// Envia alertas e relatório diário via MultixZap (API compatível com Evolution API).
// Ações: "run" (cron, a cada minuto), "test" e "daily" (somente admin).
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { buildVars, render, checkCondition, isDue, type Report } from "./reports.ts";
import {
  allAccepted, applyResults, episodeKey, exhausted, normalizePhones, offlineBeyondTolerance, pendingPhones,
  type DeliveryRow, type SendResult,
  recoveryCandidates, healthSummary, fmtBahia, FRESH_MS, type UpEvent, type ConcState,
} from "./logic.ts";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

type Settings = {
  enabled: boolean; api_url: string | null; api_token: string | null; instance: string | null;
  phones: string[]; daily_report_enabled: boolean; daily_report_hour: number; last_daily_sent_on: string | null; id: string;
};
type Rule = { rule_key: string; label: string; enabled: boolean; send_whatsapp: boolean; include_in_daily: boolean; threshold: number; cooldown_minutes: number; window_minutes?: number; tolerance_minutes?: number };

function baseUrl(s: Settings) {
  if (!s.api_url || !s.api_token || !s.instance) throw new Error("Servidor WhatsApp não configurado");
  return (/^https?:\/\//.test(s.api_url) ? s.api_url : `https://${s.api_url}`).replace(/\/+$/, "");
}

// Envia para UM destinatário. ok=true significa "aceito pela API" (não confirma entrega no aparelho).
async function sendOne(s: Settings, number: string, text: string): Promise<SendResult> {
  try {
    const r = await fetch(`${baseUrl(s)}/message/sendText/${encodeURIComponent(s.instance!)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: s.api_token!, Authorization: `Bearer ${s.api_token}` },
      body: JSON.stringify({ number, text }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await r.text();
    if (!r.ok) return { phone: number, ok: false, error: `HTTP ${r.status} ${body.slice(0, 200)}` };
    let id: string | null = null;
    try { id = JSON.parse(body)?.key?.id ?? null; } catch { /* noop */ }
    return { phone: number, ok: true, messageId: id };
  } catch (e) {
    return { phone: number, ok: false, error: (e as Error).message };
  }
}

// Usado só em ações manuais (teste/relatório manual): lança erro se algum destinatário falhar.
async function sendText(s: Settings, text: string) {
  baseUrl(s);
  const results = await Promise.all(normalizePhones(s.phones).map((p) => sendOne(s, p, text)));
  const errs = results.filter((r) => !r.ok).map((r) => `${r.phone}: ${r.error}`);
  if (errs.length) throw new Error(errs.join(" | "));
  return results;
}

type DeliverOutcome = { status: "skipped" | "complete" | "partial" | "failed" | "exhausted"; accepted: number; failed: number; key: string };

// Entrega com registro por destinatário: reenvia só pendentes (máx. MAX_ATTEMPTS), nunca repete quem já foi aceito.
async function deliver(s: Settings, ruleKey: string, dedupe: string, text: string, cooldown: number, phones = s.phones): Promise<DeliverOutcome> {
  const key = episodeKey(dedupe, cooldown);
  if (cooldown > 0) {
    const since = new Date(Date.now() - cooldown * 60000).toISOString();
    const { data } = await sb.from("notification_log").select("id").eq("dedupe_key", dedupe).eq("success", true).gte("created_at", since).limit(1);
    if (data?.length) return { status: "skipped", accepted: 0, failed: 0, key };
  }
  const { data: rows0, error: rErr } = await sb.from("notification_deliveries").select("phone,status,attempts").eq("dedupe_key", key);
  if (rErr) throw new Error(`deliveries: ${rErr.message}`);
  const rows = (rows0 ?? []) as DeliveryRow[];
  if (allAccepted(phones, rows)) return { status: "complete", accepted: 0, failed: 0, key };
  const pend = pendingPhones(phones, rows);
  if (!pend.length) return { status: "exhausted", accepted: 0, failed: 0, key };

  const results: SendResult[] = [];
  for (const p of pend) results.push(await sendOne(s, p, text));
  const merged = applyResults(rows, results);
  const upserts = results.map((r) => ({
    dedupe_key: key, rule_key: ruleKey, phone: r.phone,
    status: r.ok ? "accepted" : "failed",
    attempts: merged.find((m) => m.phone === r.phone)!.attempts,
    provider_message_id: r.messageId ?? null,
    last_error: r.ok ? null : r.error ?? "erro",
  }));
  const { error: uErr } = await sb.from("notification_deliveries").upsert(upserts, { onConflict: "dedupe_key,phone" });
  if (uErr) console.error("notify-whatsapp: falha ao registrar entregas", uErr.message);

  const done = allAccepted(phones, merged);
  const failed = results.filter((r) => !r.ok);
  await sb.from("notification_log").insert({
    rule_key: ruleKey, dedupe_key: dedupe, message: text, success: done,
    error: failed.length ? failed.map((f) => `${f.phone}: ${f.error}`).join(" | ").slice(0, 1000) : null,
  });
  const status = done ? "complete" : failed.length === results.length ? (exhausted(phones, merged) ? "exhausted" : "failed") : "partial";
  return { status, accepted: results.length - failed.length, failed: failed.length, key };
}

async function collectAlerts(rules: Map<string, Rule>) {
  const out: { key: string; dedupe: string; text: string; cooldown: number; critical?: boolean }[] = [];
  const on = (k: string) => { const r = rules.get(k); return r && r.enabled && r.send_whatsapp ? r : null; };
  const { data: concs } = await sb.from("concentradores").select("id,nome,status,cpu_load,memory_used_pct,usuarios_online,ultima_coleta,offline_since");
  for (const c of concs ?? []) {
    let r = on("concentrador_down");
    if (r && offlineBeyondTolerance(c, r.tolerance_minutes)) {
      const desde = c.offline_since ? new Date(c.offline_since).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }) : "?";
      out.push({ key: r.rule_key, critical: true, dedupe: `down:${c.id}:${c.offline_since ?? ""}`, cooldown: r.cooldown_minutes, text: `🔴 *Concentrador offline*\n${c.nome} sem resposta desde ${desde}.` });
    }
    r = on("cpu_high");
    if (r && (c.cpu_load ?? 0) >= r.threshold) out.push({ key: r.rule_key, dedupe: `cpu:${c.id}`, cooldown: r.cooldown_minutes, text: `🟠 *CPU alta*\n${c.nome}: ${c.cpu_load}% (limite ${r.threshold}%)` });
    r = on("memory_high");
    if (r && (c.memory_used_pct ?? 0) >= r.threshold) out.push({ key: r.rule_key, dedupe: `mem:${c.id}`, cooldown: r.cooldown_minutes, text: `🟠 *Memória alta*\n${c.nome}: ${c.memory_used_pct}% (limite ${r.threshold}%)` });
  }
  let r = on("online_drop");
  if (r && r.threshold > 0) {
    // Só avalia com dados frescos: coletor parado não vira "clientes abaixo do limite"
    const fresh = new Date(Date.now() - 5 * 60000).toISOString();
    const { count } = await sb.from("pppoe_sessions").select("id", { count: "exact", head: true }).eq("online", true).gte("ultima_atualizacao", fresh);
    const anyFresh = (concs ?? []).some((c) => c.ultima_coleta && c.ultima_coleta >= fresh);
    if (anyFresh && (count ?? 0) < r.threshold) out.push({ key: r.rule_key, critical: true, dedupe: "online_drop", cooldown: r.cooldown_minutes, text: `🔴 *Clientes online abaixo do limite*\nAgora: ${count} (limite ${r.threshold})` });
  }
  r = on("mass_disconnect");
  if (r) {
    const win = Math.max(1, r.window_minutes ?? 5);
    const since = new Date(Date.now() - win * 60000).toISOString();
    const { data } = await sb.from("eventos").select("concentrador_id").eq("tipo", "disconnect").gte("created_at", since);
    const { data: mass } = await sb.from("eventos").select("concentrador_id, metadata").eq("tipo", "device_down").eq("metadata->>scope", "mass").gte("created_at", since);
    const by = new Map<string, number>();
    for (const e of data ?? []) by.set(e.concentrador_id ?? "?", (by.get(e.concentrador_id ?? "?") ?? 0) + 1);
    for (const e of mass ?? []) by.set(e.concentrador_id ?? "?", (by.get(e.concentrador_id ?? "?") ?? 0) + Number((e.metadata as any)?.count ?? 0));
    for (const [cid, n] of by) if (n >= r.threshold) {
      const nome = (concs ?? []).find((c) => c.id === cid)?.nome ?? "concentrador";
      out.push({ key: r.rule_key, critical: true, dedupe: `mass:${cid}`, cooldown: r.cooldown_minutes, text: `🚨 *Queda em massa*\n${n} clientes caíram nos últimos ${win} min em ${nome}.` });
    }
  }
  r = on("client_unstable");
  if (r) {
    // Só quedas individuais; agrupadas por concentrador+login para não misturar logins iguais
    const since = new Date(Date.now() - 86400000).toISOString();
    const { data } = await sb.from("eventos").select("username,concentrador_id").eq("tipo", "disconnect").gte("created_at", since).limit(50000);
    const by = new Map<string, { u: string; cid: string; n: number }>();
    for (const e of data ?? []) if (e.username) {
      const k = `${e.concentrador_id ?? "?"}|${e.username}`;
      const cur = by.get(k) ?? { u: e.username, cid: e.concentrador_id ?? "?", n: 0 };
      cur.n++; by.set(k, cur);
    }
    for (const v of by.values()) if (v.n >= r.threshold) {
      const nome = (concs ?? []).find((c) => c.id === v.cid)?.nome ?? "";
      out.push({ key: r.rule_key, dedupe: `unstable:${v.cid}:${v.u}`, cooldown: r.cooldown_minutes, text: `⚠️ *Cliente instável*\n${v.u}${nome ? ` (${nome})` : ""}: ${v.n} quedas individuais nas últimas 24h.` });
    }
  }
  r = on("system_alerts");
  if (r) {
    const since = new Date(Date.now() - 10 * 60000).toISOString();
    const { data } = await sb.from("alertas").select("id,titulo,descricao").eq("severidade", "critical").eq("status", "active").gte("created_at", since);
    for (const a of data ?? []) out.push({ key: r.rule_key, dedupe: `alerta:${a.id}`, cooldown: 100000, text: `🚨 *${a.titulo}*\n${a.descricao ?? ""}` });
  }
  r = on("concentrador_up");
  if (r) {
    // Baseline = última alteração da regra: ao ativar, eventos antigos não são enviados.
    const baseline = (r as Rule & { updated_at?: string }).updated_at ?? new Date().toISOString();
    const { data: ev } = await sb.from("eventos").select("id,concentrador_id,created_at,metadata").eq("tipo", "device_up").gte("created_at", baseline).limit(200);
    for (const x of recoveryCandidates((ev ?? []) as UpEvent[], (concs ?? []) as ConcState[], baseline))
      out.push({ key: r.rule_key, critical: true, dedupe: x.dedupe, cooldown: 0, text: x.text });
  }
  return out;
}

async function buildHealth() {
  const fresh = new Date(Date.now() - FRESH_MS).toISOString();
  const [{ data: concs }, { count: clients }, { count: crit }] = await Promise.all([
    sb.from("concentradores").select("id,nome,status,ultima_coleta,usuarios_online"),
    sb.from("pppoe_sessions").select("id", { count: "exact", head: true }).eq("online", true).gte("ultima_atualizacao", fresh),
    sb.from("alertas").select("id", { count: "exact", head: true }).eq("severidade", "critical").eq("status", "active"),
  ]);
  return healthSummary({ concs: (concs ?? []) as ConcState[], confirmedClients: clients ?? null, criticalAlerts: crit ?? 0 });
}

function simulateTexts() {
  const now = Date.now();
  const since = new Date(now - 42 * 60000).toISOString(), up = new Date(now - 60000).toISOString();
  const rec = recoveryCandidates(
    [{ id: "sim", concentrador_id: "sim", created_at: up, metadata: { offline_since: since } }],
    [{ id: "sim", nome: "CONCENTRADOR EXEMPLO", status: "online", ultima_coleta: new Date(now).toISOString(), usuarios_online: 250 }],
    new Date(now - 3600000).toISOString(), now,
  )[0];
  return [
    `🔴 *Concentrador offline*\nCONCENTRADOR EXEMPLO sem resposta desde ${fmtBahia(since)}.`,
    rec?.text ?? "",
  ];
}

async function buildDaily(rules: Map<string, Rule>, titulo = "Relatório diário NOC") {
  const inc = (k: string) => rules.get(k)?.enabled && rules.get(k)?.include_in_daily;
  const [{ data: summary }, { data: an }, { data: concs }, { count: alerts }] = await Promise.all([
    sb.rpc("dashboard_summary"),
    sb.rpc("analise_24h"),
    sb.from("concentradores").select("id,nome,status,cpu_load,memory_used_pct,usuarios_online,ultima_coleta"),
    sb.from("alertas").select("id", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 86400000).toISOString()),
  ]);
  const sm = (summary ?? {}) as Record<string, number>;
  const a = (an ?? {}) as { individual_drops?: number; mass_incidents?: number; mass_affected?: number; top?: { concentrador_id: string; username: string; n: number }[] };
  const lim = rules.get("client_unstable")?.threshold ?? 5;
  const top = (a.top ?? []).slice(0, 5);
  const nomeC = (id: string) => (concs ?? []).find((c) => c.id === id)?.nome ?? "";
  const stale = Number(sm.online_stale ?? 0);
  const lines = [
    `📊 *${titulo}* — ${new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}`, "",
    `👥 Clientes online: *${sm.online_now ?? 0}*${stale ? ` (+${stale} sem atualização recente)` : ""}`,
    `📉 Quedas individuais 24h: *${a.individual_drops ?? 0}*`,
    `🚨 Quedas em massa 24h: *${a.mass_incidents ?? 0}* (${a.mass_affected ?? 0} clientes afetados)`,
    `🔔 Alertas em 24h: *${alerts ?? 0}*`,
  ];
  if (inc("client_unstable")) {
    const { data: ev } = await sb.from("eventos").select("username,concentrador_id").eq("tipo", "disconnect").gte("created_at", new Date(Date.now() - 86400000).toISOString()).limit(50000);
    const by = new Map<string, number>();
    for (const e of ev ?? []) if (e.username) { const k = `${e.concentrador_id}|${e.username}`; by.set(k, (by.get(k) ?? 0) + 1); }
    lines.push(`⚠️ Clientes com ${lim}+ quedas individuais: *${[...by.values()].filter((n) => n >= lim).length}*`);
  }
  if (inc("concentrador_down") || inc("cpu_high") || inc("memory_high")) {
    lines.push("", "*Concentradores*");
    for (const c of concs ?? []) lines.push(`${c.status === "online" ? "🟢" : "🔴"} ${c.nome} — CPU ${c.cpu_load ?? "-"}% · Mem ${c.memory_used_pct ?? "-"}% · ${c.usuarios_online} online`);
  }
  if (top.length) { lines.push("", "*Top quedas individuais*"); top.forEach((t, i) => lines.push(`${i + 1}. ${t.username}${nomeC(t.concentrador_id) ? ` (${nomeC(t.concentrador_id)})` : ""} — ${t.n}`)); }
  return lines.join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "run");
    if (!["run", "test", "daily", "wa_status", "wa_connect", "wa_logout", "report_preview", "report_test", "health_preview", "health_send", "simulate"].includes(action)) return json({ error: "ação inválida" }, 400);

    if (action !== "run") {
      const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
      const { data: u } = await sb.auth.getUser(token);
      if (!u?.user) return json({ error: "não autenticado" }, 401);
      const { data: isAdmin } = await sb.rpc("has_role", { _user_id: u.user.id, _role: "admin" });
      if (!isAdmin) return json({ error: "apenas administradores" }, 403);
    }

    let { data: s } = await sb.from("notification_settings").select("*").limit(1).maybeSingle();
    if (!s && action !== "run") {
      const ins = await sb.from("notification_settings").insert({}).select("*").single();
      s = ins.data;
    }
    if (!s) return json({ ok: true, skipped: "sem configuração" });
    // Servidor WhatsApp nativo da plataforma (Evolution API): usado quando o cliente não tem servidor próprio.
    s = {
      ...s,
      api_url: s.api_url || Deno.env.get("EVOLUTION_API_URL") || null,
      api_token: s.api_token || Deno.env.get("EVOLUTION_API_KEY") || null,
      instance: s.instance || `noc_${String(s.organization_id ?? s.id).replace(/-/g, "").slice(0, 12)}`,
    };
    if (action.startsWith("wa_")) {
      if (!s.api_url || !s.api_token) return json({ error: "Servidor WhatsApp da plataforma ainda não configurado" }, 400);
      const base = (/^https?:\/\//.test(s.api_url) ? s.api_url : `https://${s.api_url}`).replace(/\/+$/, "");
      const inst = encodeURIComponent(s.instance);
      const h = { "Content-Type": "application/json", apikey: s.api_token, Authorization: `Bearer ${s.api_token}` };
      const call = async (path: string, method = "GET", b?: unknown) => {
        const r = await fetch(`${base}${path}`, { method, headers: h, body: b ? JSON.stringify(b) : undefined });
        const t = await r.text(); let j: any = {}; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 200) }; }
        return { ok: r.ok, status: r.status, j };
      };
      if (action === "wa_status") {
        const r = await call(`/instance/connectionState/${inst}`);
        if (r.status === 404) return json({ state: "missing" });
        if (!r.ok) return json({ error: `HTTP ${r.status}: ${JSON.stringify(r.j).slice(0, 200)}` }, 502);
        return json({ state: r.j?.instance?.state ?? r.j?.state ?? "unknown" });
      }
      if (action === "wa_logout") {
        await call(`/instance/logout/${inst}`, "DELETE");
        return json({ ok: true });
      }
      // wa_connect: cria instância se não existir e retorna QR / código
      const st = await call(`/instance/connectionState/${inst}`);
      if (st.status === 404) {
        const c = await call(`/instance/create`, "POST", { instanceName: s.instance, qrcode: true, integration: "WHATSAPP-BAILEYS" });
        if (!c.ok) return json({ error: `Não foi possível criar a instância: HTTP ${c.status}` }, 502);
        const q = c.j?.qrcode;
        if (q?.base64) return json({ qr: q.base64, pairingCode: q.pairingCode ?? null });
      }
      const num = String(body.number ?? "").replace(/\D/g, "");
      const r = await call(`/instance/connect/${inst}${num ? `?number=${num}` : ""}`);
      if (!r.ok) return json({ error: `HTTP ${r.status}: ${JSON.stringify(r.j).slice(0, 200)}` }, 502);
      if (r.j?.instance?.state === "open") return json({ state: "open" });
      return json({ qr: r.j?.base64 ?? null, pairingCode: r.j?.pairingCode ?? null, code: r.j?.code ?? null });
    }

    const { data: rr } = await sb.from("alert_rules").select("*");
    const rules = new Map<string, Rule>((rr ?? []).map((r: Rule) => [r.rule_key, r]));

    if (action === "report_preview" || action === "report_test") {
      const d = body.report ?? {};
      const rep = { nome: String(d.nome ?? "Relatório"), concentrador_id: d.concentrador_id || null, last_sent_at: null, interval_minutes: Number(d.interval_minutes) || 60, condition_window_minutes: Number(d.condition_window_minutes) || 5 };
      const text = render(String(d.template ?? "").slice(0, 4000), await buildVars(sb, rep, { condicao_valor: d.condition_threshold ?? 0 }));
      if (action === "report_preview") return json({ text });
      const phones = Array.isArray(d.phones) && d.phones.length ? d.phones.map(String) : s.phones;
      await sendText({ ...s, phones }, `🧪 *TESTE*\n${text}`);
      await sb.from("notification_log").insert({ rule_key: "report_test", message: text });
      return json({ ok: true });
    }


    // Prévia/simulação: nunca envia WhatsApp
    if (action === "health_preview") return json(await buildHealth());
    if (action === "simulate") return json({ texts: simulateTexts(), note: "Simulação: nada foi enviado" });
    if (action === "health_send") {
      const h = await buildHealth();
      await sendText(s, h.text);
      await sb.from("notification_log").insert({ rule_key: "health_manual", message: h.text });
      return json({ ok: true, state: h.state });
    }
    if (action === "test") {
      await sendText(s, "✅ Teste do NOC: WhatsApp conectado e funcionando.");
      await sb.from("notification_log").insert({ rule_key: "test", message: "Mensagem de teste" });
      return json({ ok: true });
    }
    if (action === "daily") {
      await sendText(s, await buildDaily(rules));
      await sb.from("notification_log").insert({ rule_key: "daily", message: "Relatório diário (manual)" });
      return json({ ok: true });
    }

    if (!s.enabled) return json({ ok: true, skipped: "desativado" });

    // Trava contra execuções concorrentes (cron sobreposto / chamadas duplicadas)
    const holder = crypto.randomUUID();
    const { data: locked } = await sb.rpc("try_job_lock", { _name: "notify-whatsapp", _holder: holder, _seconds: 55 });
    if (!locked) return json({ ok: true, skipped: "execução concorrente em andamento" });
    try {
    const nowSp = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const today = `${nowSp.getFullYear()}-${String(nowSp.getMonth() + 1).padStart(2, "0")}-${String(nowSp.getDate()).padStart(2, "0")}`;
    const h = nowSp.getHours(), mins = h * 60 + nowSp.getMinutes();
    const qs = s.quiet_start_hour ?? 23, qe = s.quiet_end_hour ?? 6;
    const quiet = !!s.quiet_enabled && (qs > qe ? h >= qs || h < qe : h >= qs && h < qe);

    const alerts = await collectAlerts(rules);
    const outcomes: Record<string, number> = {};
    const count = (o: DeliverOutcome) => { outcomes[o.status] = (outcomes[o.status] ?? 0) + 1; };
    for (const a of alerts) {
      if (quiet && !a.critical) continue;
      count(await deliver(s, a.key, a.dedupe, a.text, a.cooldown));
    }

    // Relatórios personalizados: episódio estável até concluir (retry só dos pendentes)
    const { data: reps } = await sb.from("custom_reports").select("*").eq("enabled", true);
    for (const r of (reps ?? []) as Report[]) {
      try {
        let extra: Record<string, string | number> = {};
        let ccid = r.concentrador_id;
        if (r.trigger_type === "condition") {
          if (!r.days.includes(nowSp.getDay())) continue;
          const last = r.last_sent_at ? new Date(r.last_sent_at).getTime() : 0;
          if (Date.now() - last < r.cooldown_minutes * 60000) continue;
          const hit = await checkCondition(sb, r);
          if (!hit) continue;
          if (quiet && !["mass_disconnect", "concentrador_down", "online_below"].includes(r.condition_key ?? "")) continue;
          extra = { condicao_valor: hit.value };
          if (hit.concentrador_id && hit.concentrador_id !== "?") ccid = hit.concentrador_id;
        } else {
          if (!isDue(r, nowSp)) continue;
          if (quiet) continue;
        }
        const text = render(r.template, await buildVars(sb, { ...r, concentrador_id: ccid }, extra));
        const o = await deliver(s, `report:${r.nome}`, `report:${r.id}:${r.last_sent_at ?? "first"}`, text, 0, r.phones.length ? r.phones : s.phones);
        count(o);
        const done = o.status === "complete";
        await sb.from("custom_reports").update({
          ...(done ? { last_sent_at: new Date().toISOString() } : {}),
          last_success: done,
          last_error: done ? null : `Envio ${o.status}: ${o.failed} falha(s)`,
        }).eq("id", r.id);
      } catch (e) {
        await sb.from("custom_reports").update({ last_error: (e as Error).message }).eq("id", r.id);
      }
    }

    // Resumos diários: só marca como enviado quando todos os destinatários foram aceitos
    const dayOk = (s.report_days ?? [0, 1, 2, 3, 4, 5, 6]).includes(nowSp.getDay());
    if (dayOk && s.daily_report_enabled && mins >= s.daily_report_hour * 60 + (s.daily_report_minute ?? 0) && s.last_daily_sent_on !== today) {
      const o = await deliver(s, "daily", `daily:${today}`, await buildDaily(rules, "Resumo da manhã"), 0);
      count(o);
      if (o.status === "complete") await sb.from("notification_settings").update({ last_daily_sent_on: today }).eq("id", s.id);
    }
    if (dayOk && s.evening_report_enabled && h >= (s.evening_report_hour ?? 18) && s.last_evening_sent_on !== today) {
      const o = await deliver(s, "daily", `evening:${today}`, await buildDaily(rules, "Fechamento do dia"), 0);
      count(o);
      if (o.status === "complete") await sb.from("notification_settings").update({ last_evening_sent_on: today }).eq("id", s.id);
    }
    return json({ ok: true, checked: alerts.length, outcomes, note: "accepted = aceito pela API; entrega no aparelho não é confirmada" });
    } finally {
      await sb.rpc("release_job_lock", { _name: "notify-whatsapp", _holder: holder });
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
