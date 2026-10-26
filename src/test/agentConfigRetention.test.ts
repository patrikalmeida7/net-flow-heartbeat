import { describe, it, expect } from "vitest";
// @ts-ignore JS module do agente
import { createTargetStore } from "../../agent/src/configRetention.js";
const T = [{ host: "10.0.0.1" }];
describe("retenção de alvos SNMP", () => {
  it("timeout isolado mantém alvos", () => { let t = 0; const s = createTargetStore(1000, () => t); s.applySuccess(T); t = 500; expect(s.applyFailure(null)).toBe("retained"); expect(s.current()).toEqual(T); });
  it("expira após o prazo", () => { let t = 0; const s = createTargetStore(1000, () => t); s.applySuccess(T); t = 1500; expect(s.applyFailure(null)).toBe("expired"); expect(s.current()).toEqual([]); });
  it("401/403 invalida na hora", () => { for (const c of [401, 403]) { const s = createTargetStore(1000, () => 0); s.applySuccess(T); expect(s.applyFailure(c)).toBe("revoked"); expect(s.current()).toEqual([]); } });
  it("lista vazia válida substitui", () => { const s = createTargetStore(1000, () => 0); s.applySuccess(T); s.applySuccess([]); expect(s.current()).toEqual([]); });
});
