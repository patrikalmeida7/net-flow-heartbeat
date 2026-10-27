import { describe, it, expect } from "vitest";
import { matchProfile, sameTenant, canCommand, afterSubmit, confirmWifi, nbiUrlAllowed, reconcileStep, syncStep, safeError, snapshotFor, wifiParams, type Profile, type DeviceLike } from "../../supabase/functions/tr069-bridge/logic";

const dev: DeviceLike = { id: "d1", organization_id: "orgA", acs_server_id: "srvA", authorized: true, manufacturer: "Huawei", product_class: "HG8145V5", model_name: "HG8145V5", software_version: "V5R020C10S115" };
const prof = (o: Partial<Profile> = {}): Profile => ({ id: "p1", organization_id: "orgA", validated: true, pilot_device_id: null, manufacturer: "huawei", product_class: "HG8145V5", model_name: null, firmware_prefix: "V5R020",
  wifi_2g_ssid_path: "A.SSID", wifi_2g_password_path: "A.PSK", wifi_5g_ssid_path: null, wifi_5g_password_path: null, allow_reboot: false, ...o });

describe("TR-069 regras", () => {
  it("isolamento", () => {
    expect(sameTenant(dev, { id: "srvA", organization_id: "orgA" }, ["orgA"])).toBe(true);
    expect(sameTenant(dev, { id: "srvB", organization_id: "orgA" }, ["orgA"])).toBe(false);
    expect(sameTenant(dev, { id: "srvA", organization_id: "orgA" }, ["orgB"])).toBe(false);
    expect(sameTenant(dev, { id: "srvA", organization_id: null }, ["orgA"])).toBe(false);
  });
  it("perfis: outra empresa/não validado/firmware diferente não valem; piloto só para o próprio", () => {
    expect(matchProfile(dev, [prof({ organization_id: "orgB" })])).toBeNull();
    expect(matchProfile(dev, [prof({ validated: false })])).toBeNull();
    expect(matchProfile(dev, [prof({ validated: false, pilot_device_id: "d1" })])?.id).toBe("p1");
    expect(matchProfile({ ...dev, id: "d2" }, [prof({ validated: false, pilot_device_id: "d1" })])).toBeNull();
    expect(matchProfile(dev, [prof({ firmware_prefix: "V3" })])).toBeNull();
  });
  it("bandas, reinício e aprovação", () => {
    expect(canCommand({ ...dev, authorized: false }, prof(), "wifi_2g", { ssid: true }).ok).toBe(false);
    expect(canCommand(dev, prof(), "wifi_5g", { ssid: true }).ok).toBe(false);
    expect(canCommand(dev, prof(), "reboot").ok).toBe(false);
    expect(wifiParams(snapshotFor(prof(), "2g"), "X", "12345678")).toEqual([["A.SSID", "X", "xsd:string"], ["A.PSK", "12345678", "xsd:string"]]);
  });
  it("HTTPS obrigatório; HTTP só com exceção explícita", () => {
    expect(nbiUrlAllowed("https://acs.x", false).ok).toBe(true);
    expect(nbiUrlAllowed("http://acs.x:7558", false).ok).toBe(false);
    expect(nbiUrlAllowed("http://acs.x:7558", true).ok).toBe(true);
    expect(nbiUrlAllowed("https://u:p@acs.x", false).ok).toBe(false);
  });
  it("aceite/timeout não é sucesso nem falha", () => {
    expect(afterSubmit(200)).toBe("unconfirmed");
    expect(afterSubmit(202)).toBe("queued");
    expect(afterSubmit("timeout")).toBe("unknown");
    expect(afterSubmit(502)).toBe("unknown");
    expect(afterSubmit(400)).toBe("failed");
  });
  it("confirmação exige observação posterior", () => {
    const at = "2026-10-27T12:00:00Z";
    expect(confirmWifi("A", { value: "A", timestamp: "2026-10-27T11:59:00Z" }, at, false).status).toBe("unconfirmed");
    expect(confirmWifi("A", { value: "A", timestamp: null }, at, false).status).toBe("unconfirmed");
    expect(confirmWifi("A", { value: "A", timestamp: "2026-10-27T12:00:01Z" }, at, false).status).toBe("completed");
    expect(confirmWifi("A", { value: "A", timestamp: "2026-10-27T12:00:01Z" }, at, true).status).toBe("unconfirmed");
  });
  it("reconciliação: consulta falha = manter", () => {
    expect(reconcileStep({ tasksOk: false, stillQueued: false, faultsOk: true, faultCount: 0 })).toBe("keep");
    expect(reconcileStep({ tasksOk: true, stillQueued: false, faultsOk: false, faultCount: 0 })).toBe("keep");
    expect(reconcileStep({ tasksOk: true, stillQueued: false, faultsOk: true, faultCount: 1 })).toBe("failed");
    expect(reconcileStep({ tasksOk: true, stillQueued: false, faultsOk: true, faultCount: 0 })).toBe("applied");
  });
  it("sync: página cheia nunca é completa", () => {
    expect(syncStep(0, 200, 200, 25000, 20000)).toEqual({ cursor: 200, complete: false, stop: true });
    expect(syncStep(400, 50, 200, 1000, 20000)).toEqual({ cursor: 0, complete: true, stop: true });
  });
  it("erros sem credenciais", () => {
    expect(safeError("http://noc:segredo@1.2.3.4 Basic bm9jOnM=")).not.toMatch(/segredo|bm9jOnM/);
  });
});
