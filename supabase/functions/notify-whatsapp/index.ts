// Envia alertas e relatório diário via MultixZap (API compatível com Evolution API).
// Ações: "run" (cron, a cada minuto), "test" e "daily" (somente admin).
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

type Settings = {
  enabled: boolean; api_url: string | null; api_token: string | null; instance: string | null;
  phones: string[]; daily_report_enabled: boolean; daily_report_hour: number; last_daily_sent_on: string | null; id: string;
};
type Rule = { rule_key: string; label: string; enabled: boolean; send_whatsapp: boolean; include_in_daily: boolean; threshold: number; cooldown_minutes: number };

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
  const out: { key: string; dedupe: string; text: string; cooldown: number }[] = [];
  const on = (k: string) => { const r = rules.get(k); return r && r.enabled && r.send_whatsapp ? r : null; };
  const { data: concs } = await sb.from("concentradores").select("id,nome,status,cpu_load,memory_used_pct,usuarios_online");
  for (const c of concs ?? []) {
    let r = on("concentrador_down");
    if (r && c.status === "offline") out.push({ key: r.rule_key, dedupe: `down:${c.id}`, cooldown: r.cooldown_minutes, text: `🔴 *Concentrador offline*\n${c.nome} parou de responder.` });
    r = on("cpu_high");
    if (r && (c.cpu_load ?? 0) >= r.threshold) out.push({ key: r.rule_key, dedupe: `cpu:${c.id}`, cooldown: r.cooldown_minutes, text: `🟠 *CPU alta*\n${c.nome}: ${c.cpu_load}% (limite ${r.threshold}%)` });
    r = on("memory_high");
    if (r && (c.memory_used_pct ?? 0) >= r.threshold) out.push({ key: r.rule_key, dedupe: `mem:${c.id}`, cooldown: r.cooldown_minutes, text: `🟠 *Memória alta*\n${c.nome}: ${c.memory_used_pct}% (limite ${r.threshold}%)` });
  }
  let r = on("online_drop");
  if (r && r.threshold > 0) {
    const { count } = await sb.from("pppoe_sessions").select("id", { count: "exact", head: true }).eq("online", true);
    if ((count ?? 0) < r.threshold) out.push({ key: r.rule_key, dedupe: "online_drop", cooldown: r.cooldown_minutes, text: `🔴 *Clientes online abaixo do limite*\nAgora: ${count} (limite ${r.threshold})` });
  }
  r = on("mass_disconnect");
  if (r) {
    const since = new Date(Date.now() - 5 * 60000).toISOString();
    const { data } = await sb.from("eventos").select("concentrador_id").eq("tipo", "disconnect").gte("created_at", since);
    const by = new Map<string, number>();
    for (const e of data ?? []) by.set(e.concentrador_id ?? "?", (by.get(e.concentrador_id ?? "?") ?? 0) + 1);
    for (const [cid, n] of by) if (n >= r.threshold) {
      const nome = (concs ?? []).find((c) => c.id === cid)?.nome ?? "concentrador";
      out.push({ key: r.rule_key, dedupe: `mass:${cid}`, cooldown: r.cooldown_minutes, text: `🚨 *Queda em massa*\n${n} clientes caíram nos últimos 5 min em ${nome}.` });
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

async function buildDaily(rules: Map<string, Rule>) {
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
  const lines = [`📊 *Relatório diário NOC* — ${new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}`, "", `👥 Clientes online: *${online ?? 0}*`, `📉 Quedas em 24h: *${drops?.length ?? 0}*`, `🔔 Alertas em 24h: *${alerts?.length ?? 0}*`];
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
    if (!["run", "test", "daily", "wa_status", "wa_connect", "wa_logout"].includes(action)) return json({ error: "ação inválida" }, 400);

    if (action !== "run") {
      const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
      const { data: u } = await sb.auth.getUser(token);
      if (!u?.user) return json({ error: "não autenticado" }, 401);
      const { data: isAdmin } = await sb.rpc("has_role", { _user_id: u.user.id, _role: "admin" });
      if (!isAdmin) return json({ error: "apenas administradores" }, 403);
    }

    const { data: s } = await sb.from("notification_settings").select("*").limit(1).maybeSingle();
    if (!s) return json({ error: "Configure o MultixZap primeiro" }, 400);
    if (action.startsWith("wa_")) {
      if (!s.api_url || !s.api_token || !s.instance) return json({ error: "Preencha endereço, token e instância e clique em Salvar" }, 400);
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
    const alerts = await collectAlerts(rules);
    let sent = 0;
    for (const a of alerts) if (await deliver(s, a.key, a.dedupe, a.text, a.cooldown)) sent++;

    const nowSp = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const today = nowSp.toISOString().slice(0, 10);
    if (s.daily_report_enabled && nowSp.getHours() >= s.daily_report_hour && s.last_daily_sent_on !== today) {
      const text = await buildDaily(rules);
      await deliver(s, "daily", `daily:${today}`, text, 0);
      await sb.from("notification_settings").update({ last_daily_sent_on: today }).eq("id", s.id);
    }
    return json({ ok: true, checked: alerts.length, sent });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
