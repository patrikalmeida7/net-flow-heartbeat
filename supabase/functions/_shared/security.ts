export async function secretMatches(provided: string | null, expected: string | undefined): Promise<boolean> {
  if (!provided || !expected) return false;
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(provided), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
export function sameOrganization(agent: string | null, assignment: string | null, target: string | null) {
  return agent === assignment && agent === target;
}
