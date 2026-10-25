import { describe, it, expect } from "vitest";
import { normalizeEmail, roleAllows, accessFromRpc, safeNextPath } from "@/lib/access";

describe("acesso restrito", () => {
  it("e-mails equivalentes normalizados batem exatamente", () => {
    expect(normalizeEmail("  KoBew@Kikaga.COM ")).toBe("kobew@kikaga.com");
    expect(normalizeEmail("a.b@gmail.com")).not.toBe(normalizeEmail("ab@gmail.com"));
  });
  it("sem resposta ativa = sem acesso (fail closed)", () => {
    expect(accessFromRpc(null)).toEqual({ status: "pending", role: null });
    expect(accessFromRpc({ status: "pending" }).status).toBe("pending");
    expect(accessFromRpc({ status: "active", role: "root" }).status).toBe("pending");
    expect(accessFromRpc({ status: "active", role: "tecnico" })).toEqual({ status: "active", role: "tecnico" });
  });
  it("hierarquia de papéis", () => {
    expect(roleAllows("admin", "tecnico")).toBe(true);
    expect(roleAllows("tecnico", "admin")).toBe(false);
    expect(roleAllows("visualizador", "tecnico")).toBe(false);
    expect(roleAllows(null, "visualizador")).toBe(false);
  });
  it("retorno após login só para caminho interno", () => {
    expect(safeNextPath("/pppoe?x=1")).toBe("/pppoe?x=1");
    expect(safeNextPath("//evil.com")).toBe("/");
    expect(safeNextPath("https://evil.com")).toBe("/");
    expect(safeNextPath("/auth")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
  });
});
