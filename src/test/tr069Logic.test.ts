import { describe, it, expect } from "vitest";
import { matchProfile, sameTenant, canCommand, afterSubmit, confirmWifi, idempotencyKey, wifiParams, safeError, type Profile, type DeviceLike } from "../../supabase/functions/tr069-bridge/logic";

const dev: DeviceLike = { organization_id: "orgA", acs_server_id: "srvA", authorized: true, manufacturer: "Huawei", product_class: "HG8145V5", model_name: "HG8145V5", software_version: "V5R020C10S115" };
const prof = (o: Partial<Profile> = {}): Profile => ({ id: "p1", organization_id: "orgA", validated: true, manufacturer: "huawei", product_class: "HG8145V5", model_name: null, firmware_prefix: "V5R020",
  wifi_2g_ssid_path: "A.SSID", wifi_2g_password_path: "A.PSK", wifi_5g_ssid_path: null, wifi_5g_password_path: null, allow_reboot: false, ...o });

describe("TR-069 isolamento", () => {
  it("servidor/empresa diferente é recusado", () => {
    expect(sameTenant(dev, { id: "srvA", organization_id: "orgA" }, ["orgA"])).toBe(true);
    expect(sameTenant(dev, { id: "srvB", organization_id: "orgA" }, ["orgA"])).toBe(false);
    expect(sameTenant(dev, { id: "srvA", organization_id: "orgA" }, ["orgB"])).toBe(false);
    expect(sameTenant({ ...dev, organization_id: "orgB" }, { id: "srvA", organization_id: "orgA" }, ["orgA", "orgB"])).toBe(false);
    expect(sameTenant(dev, { id: "srvA", organization_id: null }, ["orgA"])).toBe(false);
  });
  it("perfil de outra empresa ou não validado não vale", () => {
    expect(matchProfile(dev, [prof({ organization_id: "orgB" })])).toBeNull();
    expect(matchProfile(dev, [prof({ validated: false })])).toBeNull();
    expect(matchProfile(dev, [prof({ firmware_prefix: "V3" })])).toBeNull();
    expect(matchProfile(dev, [prof({ manufacturer: null, product_class: null, model_name: null })])).toBeNull();
    expect(matchProfile(dev, [prof()])?.id).toBe("p1");
  });
});

describe("TR-069 comandos", () => {
  it("equipamento não aprovado ou sem perfil é bloqueado", () => {
    expect(canCommand({ ...dev, authorized: false }, prof(), "wifi_2g", { ssid: true }).ok).toBe(false);
    expect(canCommand(dev, null, "wifi_2g", { ssid: true }).ok).toBe(false);
  });
  it("5 GHz sem parâmetro no perfil é recusado; 2,4 aceita", () => {
    expect(canCommand(dev, prof(), "wifi_5g", { ssid: true }).ok).toBe(false);
    expect(canCommand(dev, prof(), "wifi_2g", { ssid: true, password: true }).ok).toBe(true);
    expect(wifiParams(prof(), "2g", "X", "12345678")).toEqual([["A.SSID", "X", "xsd:string"], ["A.PSK", "12345678", "xsd:string"]]);
  });
  it("reinício só com perfil que permite", () => {
    expect(canCommand(dev, prof(), "reboot").ok).toBe(false);
    expect(canCommand(dev, prof({ allow_reboot: true }), "reboot").ok).toBe(true);
  });
  it("aceite do ACS não é sucesso", () => {
    expect(afterSubmit(200)).toBe("unconfirmed");
    expect(afterSubmit(202)).toBe("queued");
    expect(afterSubmit(500)).toBe("failed");
  });
  it("confirmação por leitura; senha nunca confirmada", () => {
    expect(confirmWifi("Casa", "Casa", false).status).toBe("completed");
    expect(confirmWifi("Casa", "Outro", false).status).toBe("unconfirmed");
    expect(confirmWifi("Casa", "Casa", true).status).toBe("unconfirmed");
    expect(confirmWifi(null, null, true).status).toBe("unconfirmed");
  });
  it("retry igual gera mesma chave; senha não entra na chave", async () => {
    const t = 1_700_000_000_000;
    expect(await idempotencyKey("d", "wifi_2g", "X", true, t)).toBe(await idempotencyKey("d", "wifi_2g", "X", true, t + 1000));
    expect(await idempotencyKey("d", "wifi_2g", "X", true, t)).not.toBe(await idempotencyKey("d2", "wifi_2g", "X", true, t));
  });
  it("erros não vazam credenciais", () => {
    expect(safeError("fetch http://noc:segredo@1.2.3.4:7558 Basic bm9jOnM=")).not.toMatch(/segredo|bm9jOnM/);
  });
});
