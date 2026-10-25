export type HealthState = "ok" | "delayed" | "collector_down" | "device_down" | "no_data";

/** Coleta roda a cada ~10-30s; acima de 2 min é atraso, acima de 10 min o coletor caiu. */
export const DELAY_MS = 2 * 60_000;
export const DOWN_MS = 10 * 60_000;
/** Sessão "online" sem atualização há mais que isso = último estado conhecido, não online atual. */
export const SESSION_STALE_MS = 6 * 60 * 60_000;

export function collectionHealth(input: {
  lastCollectAt: string | null;
  anyDeviceOffline: boolean;
  now?: number;
}): HealthState {
  const now = input.now ?? Date.now();
  if (!input.lastCollectAt) return "no_data";
  const age = now - new Date(input.lastCollectAt).getTime();
  if (input.anyDeviceOffline) return "device_down";
  if (age > DOWN_MS) return "collector_down";
  if (age > DELAY_MS) return "delayed";
  return "ok";
}

const severity: Record<HealthState, number> = { ok: 0, delayed: 1, device_down: 2, collector_down: 3, no_data: 1 };

export type DeviceHealthInput = { id: string; nome: string; status: string; ultima_coleta: string | null };
export type DeviceHealth = DeviceHealthInput & { state: HealthState };

/** Saúde por equipamento + pior estado geral (um equipamento recente não esconde outro parado). */
export function devicesHealth(devices: DeviceHealthInput[], now = Date.now()) {
  const list: DeviceHealth[] = devices.map((d) => ({
    ...d,
    state: d.status === "unknown" ? "device_down" : collectionHealth({ lastCollectAt: d.ultima_coleta, anyDeviceOffline: d.status === "offline", now }),
  }));
  const worst = list.length
    ? list.reduce((a, b) => (severity[b.state] > severity[a.state] ? b : a)).state
    : ("no_data" as HealthState);
  return { list, worst, problems: list.filter((d) => d.state !== "ok") };
}

export const healthLabel: Record<HealthState, string> = {
  ok: "Coleta em dia",
  delayed: "Dados atrasados",
  collector_down: "Falha de coleta",
  device_down: "Monitoramento indisponível",
  no_data: "Sem dados de coleta",
};
