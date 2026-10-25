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
