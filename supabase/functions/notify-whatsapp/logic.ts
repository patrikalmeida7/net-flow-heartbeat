// Lógica pura do notificador (sem Deno/IO) — testada em src/test/notifyLogic.test.ts

export const MAX_ATTEMPTS = 3;

export type DeliveryRow = { phone: string; status: string; attempts: number };
export type SendResult = { phone: string; ok: boolean; messageId?: string | null; error?: string | null };

export function normalizePhones(phones: string[]): string[] {
  return [...new Set(phones.map((p) => p.replace(/\D/g, "")).filter(Boolean))];
}

/** Destinatários que ainda precisam receber: nunca aceitos e com tentativas restantes. */
export function pendingPhones(phones: string[], rows: DeliveryRow[], max = MAX_ATTEMPTS): string[] {
  const by = new Map(rows.map((r) => [r.phone, r]));
  return normalizePhones(phones).filter((p) => {
    const r = by.get(p);
    if (!r) return true;
    if (r.status === "accepted" || r.status === "delivered") return false;
    return r.attempts < max;
  });
}

/** Concluído só quando TODOS os destinatários foram aceitos pela API. */
export function allAccepted(phones: string[], rows: DeliveryRow[]): boolean {
  const ok = new Set(rows.filter((r) => r.status === "accepted" || r.status === "delivered").map((r) => r.phone));
  const list = normalizePhones(phones);
  return list.length > 0 && list.every((p) => ok.has(p));
}

/** Esgotado: nenhum pendente restante mas nem todos aceitos (precisa de atenção manual). */
export function exhausted(phones: string[], rows: DeliveryRow[], max = MAX_ATTEMPTS): boolean {
  return pendingPhones(phones, rows, max).length === 0 && !allAccepted(phones, rows);
}

/** Aplica resultados de envio às linhas existentes (pura, para simular/testar). */
export function applyResults(rows: DeliveryRow[], results: SendResult[]): DeliveryRow[] {
  const by = new Map(rows.map((r) => [r.phone, { ...r }]));
  for (const res of results) {
    const r = by.get(res.phone) ?? { phone: res.phone, status: "pending", attempts: 0 };
    r.attempts += 1;
    r.status = res.ok ? "accepted" : "failed";
    by.set(res.phone, r);
  }
  return [...by.values()];
}

/** Concentrador offline além da tolerância, contada do início CONTÍNUO da queda. */
export function offlineBeyondTolerance(
  c: { status: string; offline_since: string | null },
  toleranceMinutes: number | null | undefined,
  now = Date.now(),
): boolean {
  if (c.status !== "offline") return false;
  if (!toleranceMinutes) return true;
  if (!c.offline_since) return false; // sem início conhecido → aguarda próximo ciclo
  return now - new Date(c.offline_since).getTime() >= toleranceMinutes * 60000;
}

/** Chave estável de um episódio de alerta: mesma janela de cooldown → mesmas entregas. */
export function episodeKey(dedupe: string, cooldownMinutes: number, now = Date.now()): string {
  if (!cooldownMinutes || cooldownMinutes <= 0) return dedupe;
  return `${dedupe}@${Math.floor(now / (cooldownMinutes * 60000))}`;
}

// ---------- Recuperação OFFLINE→ONLINE e resumo de saúde ----------
export const FRESH_MS = 5 * 60000;
const TZ = "America/Bahia";
export const fmtBahia = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
export function fmtDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}min` : `${m}min`;
}

export type UpEvent = { id: string; concentrador_id: string | null; created_at: string; metadata?: Record<string, unknown> | null };
export type ConcState = { id: string; nome: string; status: string; ultima_coleta: string | null; usuarios_online?: number | null };
export type Recovery = { dedupe: string; concentrador_id: string; text: string };

/**
 * Recuperações comprovadas: evento device_up posterior ao baseline (sem histórico na 1ª implantação),
 * concentrador ainda online e com coleta válida fresca APÓS o evento. Uma chave por episódio.
 */
export function recoveryCandidates(events: UpEvent[], concs: ConcState[], baseline: string, now = Date.now()): Recovery[] {
  const out: Recovery[] = [];
  const base = new Date(baseline).getTime();
  for (const e of events) {
    const t = new Date(e.created_at).getTime();
    if (!e.concentrador_id || t <= base) continue;
    const c = concs.find((x) => x.id === e.concentrador_id);
    if (!c || c.status !== "online" || !c.ultima_coleta) continue;
    const last = new Date(c.ultima_coleta).getTime();
    if (now - last > FRESH_MS || last < t) continue; // heartbeat/dado velho não comprova recuperação
    const since = typeof e.metadata?.offline_since === "string" ? (e.metadata.offline_since as string) : null;
    const lines = [`🟢 *Concentrador recuperado*`, `${c.nome} voltou a responder.`];
    lines.push(`Início da indisponibilidade: ${since ? fmtBahia(since) : "desconhecido"}`);
    lines.push(`Fim: ${fmtBahia(e.created_at)}`);
    if (since) lines.push(`Duração: ${fmtDur(t - new Date(since).getTime())}`);
    lines.push(`Clientes conectados (coleta ${fmtBahia(c.ultima_coleta)}): ${c.usuarios_online ?? "não verificado"}`);
    out.push({ dedupe: `up:${e.id}`, concentrador_id: c.id, text: lines.join("\n") });
  }
  return out;
}

export type HealthInput = { concs: ConcState[]; confirmedClients: number | null; criticalAlerts: number; now?: number };
export function healthSummary(i: HealthInput): { state: "Operacional" | "Atenção" | "Sem dados recentes"; text: string } {
  const now = i.now ?? Date.now();
  const fresh = (c: ConcState) => !!c.ultima_coleta && now - new Date(c.ultima_coleta).getTime() <= FRESH_MS;
  const lastIso = i.concs.map((c) => c.ultima_coleta).filter(Boolean).sort().pop() ?? null;
  const freshOnline = i.concs.filter((c) => c.status === "online" && fresh(c));
  const offline = i.concs.filter((c) => c.status === "offline");
  const unknown = i.concs.length - freshOnline.length - offline.length;
  const state = freshOnline.length === 0 ? "Sem dados recentes"
    : offline.length || unknown || i.criticalAlerts ? "Atenção" : "Operacional";
  const icon = state === "Operacional" ? "🟢" : state === "Atenção" ? "🟠" : "⚪";
  const lines = [
    `${icon} *Resumo de saúde NOC: ${state}*`,
    `Última coleta válida: ${lastIso ? fmtBahia(lastIso) : "desconhecida"}`,
    `Concentradores online (dado recente): ${freshOnline.length} · offline: ${offline.length} · sem dado recente: ${unknown}`,
    `Clientes confirmados: ${state === "Sem dados recentes" || i.confirmedClients == null ? "desconhecido" : i.confirmedClients}`,
    `Alertas críticos ativos: ${i.criticalAlerts}`,
  ];
  if (state === "Sem dados recentes") lines.push("⚠️ Sem coleta recente — o estado atual da rede é desconhecido.");
  return { state, text: lines.join("\n") };
}
