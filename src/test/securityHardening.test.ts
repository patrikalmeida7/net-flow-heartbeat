import { it, expect } from "vitest";
import { secretMatches, sameOrganization } from "../../supabase/functions/_shared/security";
import { encryptSecret, decryptSecret } from "../../supabase/functions/_shared/credential-cipher";

it("cron rejects absent and incorrect secrets", async () => {
  expect(await secretMatches(null, "test-only-cron")).toBe(false);
  expect(await secretMatches("wrong", "test-only-cron")).toBe(false);
  expect(await secretMatches("test-only-cron", "test-only-cron")).toBe(true);
});
it("agent, assignment and device must share an organization", () => {
  expect(sameOrganization("a", "a", "a")).toBe(true);
  expect(sameOrganization("a", "b", "a")).toBe(false);
  expect(sameOrganization("a", "a", "b")).toBe(false);
  expect(sameOrganization(null, null, "b")).toBe(false);
});
it("AES-GCM authenticates the key and row/field binding", async () => {
  const key = "test-only-key-0000000000000000000000000000";
  const aad = "vpn_connections:00000000-0000-0000-0000-000000000001:wg_private_key";
  const ciphertext = await encryptSecret("test-only-value", key, aad);
  expect(await decryptSecret(ciphertext, key, aad)).toBe("test-only-value");
  await expect(decryptSecret(ciphertext, key, aad + "other")).rejects.toThrow();
  await expect(decryptSecret(ciphertext, key + "other", aad)).rejects.toThrow();
});