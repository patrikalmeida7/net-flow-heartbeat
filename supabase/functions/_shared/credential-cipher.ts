// AES-256-GCM with a key derived from a backend-only secret. Output: v1.<iv b64>.<ct b64>.
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function aesKey(secret: string) {
  if (!secret || secret.length < 32) throw new Error("ACS key missing");
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", h, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptSecret(plain: string, secret: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, await aesKey(secret), new TextEncoder().encode(plain));
  return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
}
export async function decryptSecret(blob: string, secret: string, aad: string): Promise<string> {
  const [v, iv, ct] = blob.split(".");
  if (v !== "v1") throw new Error("bad ciphertext");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(aad) }, await aesKey(secret), unb64(ct));
  return new TextDecoder().decode(pt);
}
