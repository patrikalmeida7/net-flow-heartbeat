import { describe, it, expect } from "vitest";
import { dailyHistoryText, fmtBytes } from "../../supabase/functions/notify-whatsapp/daily";

describe("relatório D-1", () => {
  it("mesmo login em concentradores diferentes aparece separado", () => {
    const t = dailyHistoryText({ top_drops: [
      { username: "joao", concentrador_nome: "CON-A", count: 4 },
      { username: "joao", concentrador_nome: "CON-B", count: 2 }] }, "2026-10-25");
    expect(t).toContain("joao (CON-A) — 4");
    expect(t).toContain("joao (CON-B) — 2");
    expect(t).toContain("25/10/2026");
  });
  it("consumo ausente vira Sem dados, não zero", () => {
    expect(fmtBytes(null)).toBe("Sem dados");
    expect(fmtBytes(2_500_000_000)).toBe("2.50 GB");
  });
});
