// Payload size + best-effort per-agent rate limit (per edge isolate) for agent ingestion.
const hits = new Map<string, number[]>();

export function tooLarge(req: Request, maxBytes: number): boolean {
  const len = Number(req.headers.get("content-length") ?? "0");
  return Number.isFinite(len) && len > maxBytes;
}

export async function readJsonLimited(req: Request, maxBytes: number): Promise<unknown> {
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new Error("payload_too_large");
  return JSON.parse(text);
}

export function rateLimited(key: string, maxPerMinute: number, now = Date.now()): boolean {
  const arr = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > maxPerMinute;
}
