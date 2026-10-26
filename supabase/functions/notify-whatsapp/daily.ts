// Texto do relatório D-1 (puro, testável). Clientes = concentrador + login.
type Row = { concentrador_nome?: string | null; username: string; count?: number; bytes_in?: number | null; bytes_out?: number | null };
type Rep = { summary?: Record<string, unknown>; top_drops?: Row[]; top_consumers?: Row[] } | null;

export const fmtBytes = (b: number | null | undefined) =>
  b == null ? "Sem dados" : b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`;

export function dailyHistoryText(rep: Rep, date: string): string {
  const [y, m, d] = date.split("-");
  const s = rep?.summary ?? {};
  const drops = rep?.top_drops ?? [], cons = rep?.top_consumers ?? [];
  const L = [`📅 *Apuração de ontem (${d}/${m}/${y})*`, "", "📉 *Top clientes com mais quedas*"];
  if (!drops.length) L.push("Nenhuma queda individual registrada.");
  drops.slice(0, 5).forEach((r, i) => L.push(`${i + 1}. ${r.username} (${r.concentrador_nome ?? "?"}) — ${r.count} queda(s)`));
  L.push("", "🚀 *Top consumo (aproximado, fotografias API)*");
  if (!cons.length) L.push("Sem dados de consumo no período.");
  cons.slice(0, 5).forEach((r, i) => L.push(`${i + 1}. ${r.username} (${r.concentrador_nome ?? "?"}) — ↓${fmtBytes(r.bytes_out)} ↑${fmtBytes(r.bytes_in)}`));
  L.push("", "📊 *Resumo*", `Quedas individuais: ${s.individual_drops ?? "Sem dados"}`, `Clientes afetados: ${s.clients_with_drops ?? "Sem dados"}`, `Quedas em massa: ${s.mass_incidents ?? "Sem dados"}`, `Alertas: ${s.alerts ?? "Sem dados"}`);
  return L.join("\n");
}
