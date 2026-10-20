import { describe, it, expect } from "vitest";
import { buildMikrotikScript } from "@/lib/mikrotikScript";

describe("buildMikrotikScript", () => {
  it("restringe a API à rede da VPN", () => {
    const s = buildMikrotikScript({ username: "noc", password: "x12345678", port: 8728, use_tls: false, routeros_version: "v6" });
    expect(s).toContain("/ip service set api disabled=no port=8728 address=10.8.0.0/24");
  });
  it("usa api-ssl quando TLS ativo", () => {
    const s = buildMikrotikScript({ username: "noc", password: "x12345678", port: 8729, use_tls: true, routeros_version: "v7" });
    expect(s).toContain("/ip service set api-ssl disabled=no port=8729");
  });
});
