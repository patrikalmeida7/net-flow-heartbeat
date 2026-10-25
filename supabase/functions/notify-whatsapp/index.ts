// Envia alertas e relatório diário via MultixZap (API compatível com Evolution API).
// Ações: "run" (cron, a cada minuto), "test" e "daily" (somente admin).
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { buildVars, render, checkCondition, isDue, type Report } from "./reports.ts";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

type Settings = {
  enabled: boolean; api_url: string | null; api_token: string | null; instance: string | null;
  phones: string[]; daily_report_enabled: boolean; daily_report_hour: number; last_daily_sent_on: string | null; id: string;
};
type Rule = { rule_key: string; label: string; enabled: boolean; send_whatsapp: boolean; include_in_daily: boolean; threshold: number; cooldown_minutes: number; window_minutes?: number; tolerance_minutes?: number };

async function sendText(s: Settings, text: string) {
  if (!s.api_url || !s.api_token || !s.instance) throw new Error("MultixZap não configurado");
  const base = s.api_url.replace(/\/+$/, "");
  const errs: string[] = [];
  for (const raw of s.phones) {
    const number = raw.replace(/\D/g, "");
    if (!number) continue;
    const r = await fetch(`${base}/message/sendText/${encodeURIComponent(s.instance)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: s.api_token, Authorization: `Bearer ${s.api_token}` },
      body: JSON.stringify({ number, text }),
    });
    if (!r.ok) errs.push(`${number}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  if (errs.length) throw new Error(errs.join(" | "));
}

async function deliver(s: Settings, ruleKey: string, dedupe: string, text: string, cooldown: number) {
  if (cooldown > 0) {
    const since = new Date(Date.now() - cooldown * 60000).toISOString();
    const { data } = await sb.from("notification_log").select("id").eq("dedupe_key", dedupe).eq("success", true).gte("created_at", since).limit(1);
    if (data?.length) return false;
  }
  try {
    await sendText(s, text);
    await sb.from("notification_log").insert({ rule_key: ruleKey, dedupe_key: dedupe, message: text });
  } catch (e) {
    await sb.from("notification_log").insert({ rule_key: ruleKey, dedupe_key: dedupe, message: text, success: false, error: String((e as Error).message) });
  }
  return true;
}

async function collectAlerts(rules: Map<string, Rule>) {
  const out: { key: string; dedupe: string; text: string; cooldown: number; critical?: boolean }[] = [];
  const on = (k: string) => { const r = rules.get(k); return r && r.enabled && r.send_whatsapp ? r : null; };
  const { data: concs } = await sb.from("concentradores").select("id,nome,status,cpu_load,memory_used_pct,usuarios_online,ultima_coleta");
  for (const c of concs ?? []) {
    let r = on("concentrador_down");
    const tolOk = !r?.tolerance_minutes || !c.ultima_coleta || Date.now() - new Date(c.ultima_coleta).getTime() >= r.tolerance_minutes * 60000;
    if (r && c.status === "offline" && tolOk) out.push({ key: r.rule_key, critical: true, dedupe: `down:${c.id}`, cooldown: r.cooldown_minutes, text: `🔴 *Concentrador offline*\n${c.nome} parou de responder.` });
    r = on("cpu_high");
    if (r && (c.cpu_load ?? 0) >= r.threshold) out.push({ key: r.rule_key, dedupe: `cpu:${c.id}`, cooldown: r.cooldown_minutes, text: `🟠 *CPU alta*\n${c.nome}: ${c.cpu_load}% (limite ${r.threshold}%)` });
    r = on("memory_high");
    if (r && (c.memory_used_pct ?? 0) >= r.threshold) out.push({ key: r.rule_key, dedupe: `mem:${c.id}`, cooldown: r.cooldown_minutes, text: `🟠 *Memória alta*\n${c.nome}: ${c.memory_used_pct}% (limite ${r.threshold}%)` });
  }
  let r = on("online_drop");
  if (r && r.threshold > 0) {
    const { count } = await sb.from("pppoe_sessions").select("id", { count: "exact", head: true }).eq("online", true);
    if ((count ?? 0) < r.threshold) out.push({ key: r.rule_key, critical: true, dedupe: "online_drop", cooldown: r.cooldown_minutes, text: `🔴 *Clientes online abaixo do limite*\nAgora: ${count} (limite ${r.threshold})` });
  }
  r = on("mass_disconnect");
  if (r) {
    const win = Math.max(1, r.window_minutes ?? 5);
    const since = new Date(Date.now() - win * 60000).toISOString();
    const { data } = await sb.from("eventos").select("concentrador_id").eq("tipo", "disconnect").gte("created_at", since);
    const by = new Map<string, number>();
    for (const e of data ?? []) by.set(e.concentrador_id ?? "?", (by.get(e.concentrador_id ?? "?") ?? 0) + 1);
    for (const [cid, n] of by) if (n >= r.threshold) {
      const nome = (concs ?? []).find((c) => c.id === cid)?.nome ?? "concentrador";
      out.push({ key: r.rule_key, critical: true, dedupe: `mass:${cid}`, cooldown: r.cooldown_minutes, text: `🚨 *Queda em massa*\n${n} clientes caíram nos últimos ${win} min em ${nome}.` });
    }
  }
  r = on("client_unstable");
  if (r) {
    const since = new Date(Date.now() - 86400000).toISOString();
    const { data } = await sb.from("eventos").select("username").eq("tipo", "disconnect").gte("created_at", since).limit(10000);
    const by = new Map<string, number>();
    for (const e of data ?? []) if (e.username) by.set(e.username, (by.get(e.username) ?? 0) + 1);
    for (const [u, n] of by) if (n >= r.threshold) out.push({ key: r.rule_key, dedupe: `unstable:${u}`, cooldown: r.cooldown_minutes, text: `⚠️ *Cliente instável*\n${u}: ${n} quedas nas últimas 24h.` });
  }
  r = on("system_alerts");
  if (r) {
    const since = new Date(Date.now() - 10 * 60000).toISOString();
    const { data } = await sb.from("alertas").select("id,titulo,descricao").eq("severidade", "critical").eq("status", "active").gte("created_at", since);
    for (const a of data ?? []) out.push({ key: r.rule_key, dedupe: `alerta:${a.id}`, cooldown: 100000, text: `🚨 *${a.titulo}*\n${a.descricao ?? ""}` });
  }
  return out;
}

async function buildDaily(rules: Map<string, Rule>, titulo = "Relatório diário NOC") {
  const inc = (k: string) => rules.get(k)?.enabled && rules.get(k)?.include_in_daily;
  const since = new Date(Date.now() - 86400000).toISOString();
  const [{ count: online }, { data: drops }, { data: concs }, { data: alerts }] = await Promise.all([
    sb.from("pppoe_sessions").select("id", { count: "exact", head: true }).eq("online", true),
    sb.from("eventos").select("username").eq("tipo", "disconnect").gte("created_at", since).limit(10000),
    sb.from("concentradores").select("nome,status,cpu_load,memory_used_pct,usuarios_online"),
    sb.from("alertas").select("id").gte("created_at", since),
  ]);
  const by = new Map<string, number>();
  for (const e of drops ?? []) if (e.username) by.set(e.username, (by.get(e.username) ?? 0) + 1);
  const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const lim = rules.get("client_unstable")?.threshold ?? 5;
  const lines = [`📊 *${titulo}* — ${new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}`, "", `👥 Clientes online: *${online ?? 0}*`, `📉 Quedas em 24h: *${drops?.length ?? 0}*`, `🔔 Alertas em 24h: *${alerts?.length ?? 0}*`];
  if (inc("client_unstable")) lines.push(`⚠️ Clientes instáveis (${lim}+ quedas): *${[...by.values()].filter((n) => n >= lim).length}*`);
  if (inc("concentrador_down") || inc("cpu_high") || inc("memory_high")) {
    lines.push("", "*Concentradores*");
    for (const c of concs ?? []) lines.push(`${c.status === "online" ? "🟢" : "🔴"} ${c.nome} — CPU ${c.cpu_load ?? "-"}% · Mem ${c.memory_used_pct ?? "-"}% · ${c.usuarios_online} online`);
  }
  if (top.length) { lines.push("", "*Top quedas*"); top.forEach(([u, n], i) => lines.push(`${i + 1}. ${u} — ${n}`)); }
  return lines.join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "run");
    if (!["run", "test", "daily", "wa_status", "wa_connect", "wa_logout", "report_preview", "report_test"].includes(action)) return json({ error: "ação inválida" }, 400);

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
      const base = s.api_url.replace(/\/+$/, "");
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


    if (action === "test") {
      await sendText(s, "✅ Teste do NOC: integração com MultixZap funcionando.");
      await sb.from("notification_log").insert({ rule_key: "test", message: "Mensagem de teste" });
      return json({ ok: true });
    }
    if (action === "daily") {
      await sendText(s, await buildDaily(rules));
      await sb.from("notification_log").insert({ rule_key: "daily", message: "Relatório diário (manual)" });
      return json({ ok: true });
    }

    if (!s.enabled) return json({ ok: true, skipped: "desativado" });
    const nowSp = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const today = `${nowSp.getFullYear()}-${String(nowSp.getMonth() + 1).padStart(2, "0")}-${String(nowSp.getDate()).padStart(2, "0")}`;
    const h = nowSp.getHours(), mins = h * 60 + nowSp.getMinutes();
    const qs = s.quiet_start_hour ?? 23, qe = s.quiet_end_hour ?? 6;
    const quiet = !!s.quiet_enabled && (qs > qe ? h >= qs || h < qe : h >= qs && h < qe);

    const alerts = await collectAlerts(rules);
    let sent = 0;
    for (const a of alerts) {
      if (quiet && !a.critical) continue;
      if (await deliver(s, a.key, a.dedupe, a.text, a.cooldown)) sent++;
    }

    // Relatórios personalizados
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
        let ok = true, err: string | null = null;
        try { await sendText({ ...s, phones: r.phones.length ? r.phones : s.phones }, text); } catch (e) { ok = false; err = (e as Error).message; }
        await sb.from("notification_log").insert({ rule_key: `report:${r.nome}`, dedupe_key: `report:${r.id}`, message: text, success: ok, error: err });
        await sb.from("custom_reports").update({ last_sent_at: new Date().toISOString(), last_success: ok, last_error: err }).eq("id", r.id);
        if (ok) sent++;
      } catch (e) {
        await sb.from("custom_reports").update({ last_error: (e as Error).message }).eq("id", r.id);
      }
    }


    const dayOk = (s.report_days ?? [0, 1, 2, 3, 4, 5, 6]).includes(nowSp.getDay());
    if (dayOk && s.daily_report_enabled && mins >= s.daily_report_hour * 60 + (s.daily_report_minute ?? 0) && s.last_daily_sent_on !== today) {
      await deliver(s, "daily", `daily:${today}`, await buildDaily(rules, "Resumo da manhã"), 0);
      await sb.from("notification_settings").update({ last_daily_sent_on: today }).eq("id", s.id);
    }
    if (dayOk && s.evening_report_enabled && h >= (s.evening_report_hour ?? 18) && s.last_evening_sent_on !== today) {
      await deliver(s, "daily", `evening:${today}`, await buildDaily(rules, "Fechamento do dia"), 0);
      await sb.from("notification_settings").update({ last_evening_sent_on: today }).eq("id", s.id);
    }
    return json({ ok: true, checked: alerts.length, sent });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
