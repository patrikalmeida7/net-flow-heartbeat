// Motor de relatórios personalizados: variáveis, condições e agenda.
// deno-lint-ignore-file no-explicit-any
export type Report = {
  id: string; nome: string; enabled: boolean; trigger_type: "interval" | "fixed" | "condition";
  interval_minutes: number; fixed_times: string[]; days: number[]; condition_key: string | null;
  condition_threshold: number; condition_window_minutes: number; cooldown_minutes: number;
  concentrador_id: string | null; phones: string[]; template: string; last_sent_at: string | null;
};

export function spNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
}
const pad = (n: number) => String(n).padStart(2, "0");

export async function buildVars(sb: any, rep: Pick<Report, "nome" | "concentrador_id" | "last_sent_at" | "interval_minutes" | "condition_window_minutes">, extra: Record<string, string | number> = {}) {
  const now = spNow();
  const h = now.getHours();
  const since24 = new Date(Date.now() - 86400000).toISOString();
  const sincePer = rep.last_sent_at ?? new Date(Date.now() - (rep.interval_minutes || 60) * 60000).toISOString();
  const cid = rep.concentrador_id;
  const f = (q: any) => (cid ? q.eq("concentrador_id", cid) : q);
  const [on, per, d24, concs, al, top] = await Promise.all([
    f(sb.from("pppoe_sessions").select("id", { count: "exact", head: true }).eq("online", true)),
    f(sb.from("eventos").select("id", { count: "exact", head: true }).eq("tipo", "disconnect").gte("created_at", sincePer)),
    f(sb.from("eventos").select("username").eq("tipo", "disconnect").gte("created_at", since24).limit(10000)),
    cid ? sb.from("concentradores").select("*").eq("id", cid) : sb.from("concentradores").select("*"),
    sb.from("alertas").select("id", { count: "exact", head: true }).eq("status", "active"),
    f(sb.from("pppoe_sessions").select("username,bytes_in,bytes_out").eq("online", true).order("bytes_out", { ascending: false }).limit(1)),
  ]);
  const by = new Map<string, number>();
  for (const e of d24.data ?? []) if (e.username) by.set(e.username, (by.get(e.username) ?? 0) + 1);
  const instaveis = [...by.values()].filter((n) => n >= 3).length;
  const topQ = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const cs = concs.data ?? [];
  const c0 = cs[0];
  const avg = (k: string) => cs.length ? Math.round(cs.reduce((a: number, c: any) => a + (c[k] ?? 0), 0) / cs.length) : 0;
  const t = top.data?.[0];
  const vars: Record<string, string | number> = {
    nome_relatorio: rep.nome,
    saudacao: h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite",
    data: `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`,
    hora: `${pad(h)}:${pad(now.getMinutes())}`,
    online_total: on.count ?? 0,
    quedas_periodo: per.count ?? 0,
    quedas_24h: d24.data?.length ?? 0,
    clientes_instaveis: instaveis,
    alertas_ativos: al.count ?? 0,
    top_consumidor_nome: t?.username ?? "-",
    top_consumidor_gb: t ? (((t.bytes_in ?? 0) + (t.bytes_out ?? 0)) / 1e9).toFixed(1) : "0",
    concentrador_nome: cid ? c0?.nome ?? "-" : cs.length === 1 ? c0.nome : "Toda a rede",
    concentrador_status: cid || cs.length === 1 ? (c0?.status === "online" ? "Online" : "Offline") : `${cs.filter((c: any) => c.status === "online").length}/${cs.length} online`,
    cpu_uso: cid || cs.length === 1 ? c0?.cpu_load ?? 0 : avg("cpu_load"),
    memoria_uso: cid || cs.length === 1 ? c0?.memory_used_pct ?? 0 : avg("memory_used_pct"),
    concentradores_lista: cs.map((c: any) => `${c.status === "online" ? "🟢" : "🔴"} ${c.nome} — CPU ${c.cpu_load ?? "-"}% · Mem ${c.memory_used_pct ?? "-"}% · ${c.usuarios_online} online`).join("\n") || "-",
    top_quedas: topQ.map(([u, n], i) => `${i + 1}. ${u} — ${n}`).join("\n") || "Nenhuma queda",
    janela: rep.condition_window_minutes,
    condicao_valor: "",
    ...extra,
  };
  return vars;
}

export function render(tpl: string, vars: Record<string, string | number>) {
  // Blocos condicionais: {se_xxx}texto{fim} aparece só se a variável xxx for > 0 / não vazia
  let out = tpl.replace(/\{se_([a-z_]+)\}([\s\S]*?)\{fim\}/g, (_, k, body) => {
    const v = vars[k];
    return v && v !== "0" && v !== "-" ? body : "";
  });
  out = out.replace(/\{([a-z_]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// Retorna o valor que disparou a condição (ou null se não disparou)
export async function checkCondition(sb: any, r: Report): Promise<{ value: number; concentrador_id?: string } | null> {
  const thr = r.condition_threshold;
  const cid = r.concentrador_id;
  const f = (q: any) => (cid ? q.eq("concentrador_id", cid) : q);
  switch (r.condition_key) {
    case "mass_disconnect": {
      const since = new Date(Date.now() - Math.max(1, r.condition_window_minutes) * 60000).toISOString();
      const { data } = await f(sb.from("eventos").select("concentrador_id").eq("tipo", "disconnect").gte("created_at", since).limit(10000));
      const { data: mass } = await f(sb.from("eventos").select("concentrador_id, metadata").eq("tipo", "device_down").eq("metadata->>scope", "mass").gte("created_at", since));
      const by = new Map<string, number>();
      for (const e of data ?? []) by.set(e.concentrador_id ?? "?", (by.get(e.concentrador_id ?? "?") ?? 0) + 1);
      for (const e of mass ?? []) by.set(e.concentrador_id ?? "?", (by.get(e.concentrador_id ?? "?") ?? 0) + Number(e.metadata?.count ?? 0));
      const best = [...by.entries()].sort((a, b) => b[1] - a[1])[0];
      return best && best[1] >= thr ? { value: best[1], concentrador_id: best[0] } : null;
    }
    case "concentrador_down": {
      const { data } = await (cid ? sb.from("concentradores").select("id,status").eq("id", cid) : sb.from("concentradores").select("id,status"));
      const off = (data ?? []).find((c: any) => c.status === "offline");
      return off ? { value: 1, concentrador_id: off.id } : null;
    }
    case "cpu_high":
    case "memory_high": {
      const k = r.condition_key === "cpu_high" ? "cpu_load" : "memory_used_pct";
      const { data } = await (cid ? sb.from("concentradores").select(`id,${k}`).eq("id", cid) : sb.from("concentradores").select(`id,${k}`));
      const hit = (data ?? []).find((c: any) => (c[k] ?? 0) >= thr);
      return hit ? { value: hit[k], concentrador_id: hit.id } : null;
    }
    case "online_below": {
      const { count } = await f(sb.from("pppoe_sessions").select("id", { count: "exact", head: true }).eq("online", true));
      return (count ?? 0) < thr ? { value: count ?? 0 } : null;
    }
    case "client_unstable": {
      const since = new Date(Date.now() - 86400000).toISOString();
      const { data } = await f(sb.from("eventos").select("username").eq("tipo", "disconnect").gte("created_at", since).limit(10000));
      const by = new Map<string, number>();
      for (const e of data ?? []) if (e.username) by.set(e.username, (by.get(e.username) ?? 0) + 1);
      const n = [...by.values()].filter((v) => v >= thr).length;
      return n > 0 ? { value: n } : null;
    }
  }
  return null;
}

// Decide se o relatório deve sair agora. Retorna chave do slot (fixos) ou true.
export function isDue(r: Report, now = spNow()): string | boolean {
  if (!r.days.includes(now.getDay())) return false;
  const last = r.last_sent_at ? new Date(r.last_sent_at).getTime() : 0;
  if (r.trigger_type === "interval") return Date.now() - last >= Math.max(1, r.interval_minutes) * 60000 - 30000;
  if (r.trigger_type === "fixed") {
    const mins = now.getHours() * 60 + now.getMinutes();
    for (const t of r.fixed_times) {
      const [hh, mm] = t.split(":").map(Number);
      const slot = hh * 60 + (mm || 0);
      if (mins >= slot && mins < slot + 15) {
        const slotStart = Date.now() - (mins - slot) * 60000 - 60000;
        if (last < slotStart) return t;
      }
    }
  }
  return false;
}
