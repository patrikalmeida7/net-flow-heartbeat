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
    f(sb.from("pppoe_sessions").select("id", { count: "exact", head: true }).eq("online", true).gte("ultima_atualizacao", new Date(Date.now() - 5 * 60000).toISOString())),
    f(sb.from("eventos").select("id", { count: "exact", head: true }).eq("tipo", "disconnect").gte("created_at", sincePer)),
    f(sb.from("eventos").select("username,concentrador_id").eq("tipo", "disconnect").gte("created_at", since24).limit(50000)),
    cid ? sb.from("concentradores").select("*").eq("id", cid) : sb.from("concentradores").select("*"),
    sb.from("alertas").select("id", { count: "exact", head: true }).eq("status", "active"),
    f(sb.from("pppoe_sessions").select("username,bytes_in,bytes_out").eq("online", true).order("bytes_out", { ascending: false }).limit(1)),
  ]);
  const by = new Map<string, number>();
  for (const e of d24.data ?? []) if (e.username) { const k = cs0(e); by.set(k, (by.get(k) ?? 0) + 1); }
  const instaveis = [...by.values()].filter((n) => n >= 3).length;
  const topQ = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => [k.split("|").slice(1).join("|"), n] as const);
  const cs = concs.data ?? [];
  const c0 = cs[0];
  const avg = (k: string) => { const valid=cs.filter((c:any)=>c[k]!=null && c.snmp_last_success_at && Date.now()-Date.parse(c.snmp_last_success_at)<=120000); return valid.length ? Math.round(valid.reduce((a:number,c:any)=>a+c[k],0)/valid.length) : "Sem dados"; };
  const t = top.data?.[0];
  const vars: Record<string, string | number> = {
    nome_relatorio: rep.nome,
    saudacao: h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite",
    data: `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`,
    hora: `${pad(h)}:${pad(now.getMinutes())}`,
    online_total: "Indisponível em tempo real; consulte fotografia API",
    quedas_periodo: per.count ?? 0,
    quedas_24h: d24.data?.length ?? 0,
    clientes_instaveis: "Indisponível em tempo real",
    alertas_ativos: al.count ?? 0,
    top_consumidor_nome: t?.username ?? "-",
    top_consumidor_gb: t && t.bytes_in != null && t.bytes_out != null ? ((t.bytes_in+t.bytes_out)/1e9).toFixed(1) : "Sem dados",
    concentrador_nome: cid ? c0?.nome ?? "-" : cs.length === 1 ? c0.nome : "Toda a rede",
    concentrador_status: cid || cs.length === 1 ? (c0?.snmp_status === "online" && c0.snmp_last_success_at && Date.now()-Date.parse(c0.snmp_last_success_at)<120000 ? "SNMP online" : "Sem confirmação SNMP recente") : "Consulte frescor SNMP por equipamento",
    cpu_uso: cid || cs.length === 1 ? c0?.snmp_last_success_at && Date.now()-Date.parse(c0.snmp_last_success_at)<=120000 ? c0.cpu_load ?? "Sem dados" : "Sem dados" : avg("cpu_load"),
    memoria_uso: cid || cs.length === 1 ? c0?.snmp_last_success_at && Date.now()-Date.parse(c0.snmp_last_success_at)<=120000 ? c0.memory_used_pct ?? "Sem dados" : "Sem dados" : avg("memory_used_pct"),
    concentradores_lista: cs.map((c: any) => `${c.status === "online" ? "🟢" : "🔴"} ${c.nome} — CPU ${c.cpu_load ?? "-"}% · Mem ${c.memory_used_pct ?? "-"}% · ${c.api_last_success_at ? c.usuarios_online : "Sem dados"} na fotografia API`).join("\n") || "-",
    top_quedas: topQ.map(([u, n], i) => `${i + 1}. ${u} — ${n}`).join("\n") || "Nenhuma queda",
    janela: rep.condition_window_minutes,
    condicao_valor: "",
    ...extra,
  };
  return vars;
}

// Chave de cliente = concentrador + login (logins iguais em concentradores diferentes são clientes distintos)
const cs0 = (e: { username: string; concentrador_id: string | null }) => `${e.concentrador_id ?? "?"}|${e.username}`;

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
  if (["mass_disconnect","client_unstable","online_below"].includes(r.condition_key ?? "")) return null;
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
      const { data } = await (cid ? sb.from("concentradores").select("id,status,offline_since,snmp_status").eq("id", cid) : sb.from("concentradores").select("id,status,offline_since,snmp_status"));
      const off = (data ?? []).find((c: any) => c.snmp_status === "unreachable");
      return off ? { value: 1, concentrador_id: off.id } : null;
    }
    case "cpu_high":
    case "memory_high": {
      const k = r.condition_key === "cpu_high" ? "cpu_load" : "memory_used_pct";
      const { data } = await (cid ? sb.from("concentradores").select(`id,${k},snmp_last_success_at`).eq("id", cid) : sb.from("concentradores").select(`id,${k},snmp_last_success_at`));
      const hit = (data ?? []).find((c: any) => c.snmp_last_success_at && Date.now()-Date.parse(c.snmp_last_success_at)<=120000 && c[k] != null && c[k] >= thr);
      return hit ? { value: hit[k], concentrador_id: hit.id } : null;
    }
    case "online_below": {
      const fresh = new Date(Date.now() - 5 * 60000).toISOString();
      const { count } = await f(sb.from("pppoe_sessions").select("id", { count: "exact", head: true }).eq("online", true).gte("ultima_atualizacao", fresh));
      const { count: stale } = await f(sb.from("pppoe_sessions").select("id", { count: "exact", head: true }).eq("online", true).lt("ultima_atualizacao", fresh));
      if (!count && stale) return null; // coleta parada: não confundir com clientes caindo
      return (count ?? 0) < thr ? { value: count ?? 0 } : null;
    }
    case "client_unstable": {
      const since = new Date(Date.now() - 86400000).toISOString();
      const { data } = await f(sb.from("eventos").select("username,concentrador_id").eq("tipo", "disconnect").gte("created_at", since).limit(50000));
      const by = new Map<string, number>();
      for (const e of data ?? []) if (e.username) { const k = cs0(e); by.set(k, (by.get(k) ?? 0) + 1); }
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
