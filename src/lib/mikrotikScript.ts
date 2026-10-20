export interface MikrotikScriptInput {
  username: string;
  password: string;
  port: number;
  use_tls: boolean;
  routeros_version: "v6" | "v7";
  allowedNetwork?: string; // rede da VPN de onde o coletor acessa
}

// Gera comandos RouterOS: grupo somente leitura + usuário API + serviço api/api-ssl
// restrito à rede da VPN. Compatível com v6 e v7.
export function buildMikrotikScript(i: MikrotikScriptInput): string {
  const net = i.allowedNetwork || "10.8.0.0/24";
  const svc = i.use_tls ? "api-ssl" : "api";
  const pw = i.password.replace(/(["\\$])/g, "\\$1");
  const lines = [
    `# NOC - monitoramento via API (RouterOS ${i.routeros_version})`,
    `/user group remove [find name="noc-read"]`,
    `/user group add name="noc-read" policy=${i.routeros_version === "v7" ? "read,api,!write,!policy,!sensitive" : "read,api,!write,!policy,!sensitive"}`,
    `/user remove [find name="${i.username}"]`,
    `/user add name="${i.username}" group="noc-read" password="${pw}" address=${net}`,
    `/ip service set ${svc} disabled=no port=${i.port} address=${net}`,
  ];
  if (i.use_tls) {
    lines.push(
      `/certificate add name=noc-api common-name=noc-api days-valid=3650`,
      `/certificate sign noc-api`,
      `/ip service set api-ssl certificate=noc-api`,
    );
  }
  lines.push(`:log info "NOC: usuario API configurado"`);
  return lines.join("\n");
}
