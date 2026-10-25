import { describe, it, expect } from "vitest";
import { recoveryCandidates, healthSummary, applyResults, pendingPhones } from "../../supabase/functions/notify-whatsapp/logic";

const now = Date.parse("2026-10-25T20:00:00Z");
const iso = (minAgo: number) => new Date(now - minAgo * 60000).toISOString();
const conc = (o: Partial<{ status: string; ultima_coleta: string | null }> = {}) => ({ id: "c1", nome: "CCR", status: "online", ultima_coleta: iso(1), usuarios_online: 250, ...o });
const up = { id: "e1", concentrador_id: "c1", created_at: iso(3), metadata: { offline_since: iso(33) } };

describe("recuperação de concentrador", () => {
  it("down→up gera uma recuperação com duração", () => {
    const r = recoveryCandidates([up], [conc()], iso(60), now);
    expect(r).toHaveLength(1);
    expect(r[0].dedupe).toBe("up:e1");
    expect(r[0].text).toContain("Duração: 30min");
  });
  it("online→online (sem novo device_up) não repete", () => {
    const a = recoveryCandidates([up], [conc()], iso(60), now);
    const b = recoveryCandidates([up], [conc()], iso(60), now + 60000);
    expect(a[0].dedupe).toBe(b[0].dedupe); // mesmo episódio → deliver não reenvia
    expect(recoveryCandidates([], [conc()], iso(60), now)).toHaveLength(0);
  });
  it("coleta velha não comprova recuperação", () => {
    expect(recoveryCandidates([up], [conc({ ultima_coleta: iso(20) })], iso(60), now)).toHaveLength(0);
    expect(healthSummary({ concs: [conc({ ultima_coleta: iso(20) })], confirmedClients: 0, criticalAlerts: 0, now }).state).toBe("Sem dados recentes");
  });
  it("primeira execução não reenvia eventos históricos", () => {
    expect(recoveryCandidates([up], [conc()], iso(1), now)).toHaveLength(0);
  });
  it("falha parcial só reenvia pendentes", () => {
    const rows = applyResults([], [{ phone: "551", ok: true }, { phone: "552", ok: false }]);
    expect(pendingPhones(["551", "552"], rows)).toEqual(["552"]);
  });
  it("resumo operacional só com coleta fresca e sem alertas", () => {
    expect(healthSummary({ concs: [conc()], confirmedClients: 250, criticalAlerts: 0, now }).state).toBe("Operacional");
    expect(healthSummary({ concs: [conc()], confirmedClients: 250, criticalAlerts: 1, now }).state).toBe("Atenção");
  });
});
