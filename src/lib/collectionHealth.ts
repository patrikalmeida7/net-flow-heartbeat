export type HealthState = "ok" | "delayed" | "collector_down" | "device_down" | "no_data";

/** Coleta roda a cada ~10-30s; acima de 2 min é atraso, acima de 10 min o coletor caiu. */
export const DELAY_MS = 2 * 60_000;
export const DOWN_MS = 10 * 60_000;

export function collectionHealth(input: {
  lastCollectAt: string | null;
  anyDeviceOffline: boolean;
  now?: number;
}): HealthState {
  const now = input.now ?? Date.now();
  if (!input.lastCollectAt) return "no_data";
  const age = now - new Date(input.lastCollectAt).getTime();
  if (age > DOWN_MS) return "collector_down";
  if (age > DELAY_MS) return "delayed";
  if (input.anyDeviceOffline) return "device_down";
  return "ok";
}

export const healthLabel: Record<HealthState, string> = {
  ok: "Coleta em dia",
  delayed: "Dados atrasados",
  collector_down: "Falha de coleta",
  device_down: "Equipamento indisponível",
  no_data: "Sem dados de coleta",
};
