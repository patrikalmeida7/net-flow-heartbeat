import { describe, it, expect } from "vitest";
import { recoveryCandidates, healthSummary, applyResults, pendingPhones } from "../../supabase/functions/notify-whatsapp/logic";

const now = Date.parse("2026-10-25T20:00:00Z");
const iso = (minAgo: number) => new Date(now - minAgo * 60000).toISOString();
type C = { status: string; ultima_coleta: string | null; snmp_status: string; snmp_last_success_at: string | null };
// Contrato atual: saúde vem de snmp_status/snmp_last_success_at; status/ultima_coleta legados não comprovam nada.
const conc = (o: Partial<C> = {}) => ({ id: "c1", nome: "CCR", status: "online", ultima_coleta: iso(1), snmp_status: "online", snmp_last_success_at: iso(1), usuarios_online: 250, ...o });
const up = { id: "e1", concentrador_id: "c1", created_at: iso(3), metadata: { offline_since: iso(33), source: "snmp" } };

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
  it("coleta SNMP velha não comprova recuperação", () => {
    expect(recoveryCandidates([up], [conc({ snmp_last_success_at: iso(20) })], iso(60), now)).toHaveLength(0);
    expect(healthSummary({ concs: [conc({ snmp_last_success_at: iso(20) })], confirmedClients: 0, criticalAlerts: 0, now }).state).toBe("Sem dados recentes");
  });
  it("heartbeat/API recente sem SNMP não comprova recuperação nem 'Operacional'", () => {
    const apiOnly = conc({ ultima_coleta: iso(0), status: "online", snmp_last_success_at: null, snmp_status: "unknown" });
    expect(recoveryCandidates([up], [apiOnly], iso(60), now)).toHaveLength(0);
    expect(healthSummary({ concs: [apiOnly], confirmedClients: 250, criticalAlerts: 0, now }).state).toBe("Sem dados recentes");
  });
  it("evento device_up que não veio do SNMP é ignorado", () => {
    expect(recoveryCandidates([{ ...up, metadata: { offline_since: iso(33), source: "routeros_realtime" } }], [conc()], iso(60), now)).toHaveLength(0);
  });
  it("SNMP ainda indisponível não gera recuperação", () => {
    expect(recoveryCandidates([up], [conc({ snmp_status: "unreachable" })], iso(60), now)).toHaveLength(0);
  });
  it("coleta SNMP anterior ao evento não comprova", () => {
    expect(recoveryCandidates([up], [conc({ snmp_last_success_at: iso(1.9) })], iso(60), now)).toHaveLength(1);
    expect(recoveryCandidates([{ ...up, created_at: iso(0.5) }], [conc({ snmp_last_success_at: iso(1) })], iso(60), now)).toHaveLength(0);
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
