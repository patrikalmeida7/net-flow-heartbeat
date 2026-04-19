# NOC MikroTik Agent

Agente coletor que conecta nos seus MikroTiks via **API RouterOS** e envia métricas + sessões PPPoE para o **Lovable Cloud** (Edge Function `agent-ingest`).

```
[ MikroTik #1 ]──┐
[ MikroTik #2 ]──┼─► [ Agente Node.js ] ──HTTPS──► [ Lovable Cloud ] ──► Dashboard NOC
[ MikroTik #N ]──┘   (rede do provedor)            (Edge Function)
```

## Requisitos

- Node.js **18.17+** (recomendado 20 LTS)
- Acesso de rede aos MikroTiks (porta `8728` API ou `8729` API-SSL)
- Usuário MikroTik com permissão de **leitura** (`group=read` é suficiente)
- Token de ingestão fornecido pelo Lovable Cloud (secret `AGENT_INGEST_TOKEN`)

## 1. Habilitar API + SNMP no MikroTik

```routeros
# Usuário read-only para API
/user group add name=api-ro policy=read,api,!ftp,!reboot,!write,!policy,!test,!password,!sniff,!sensitive,!romon
/user add name=api-readonly group=api-ro password="SENHA-FORTE-AQUI"
/ip service set api address=IP_DO_AGENTE/32 disabled=no

# SNMP v2c (community)
/snmp set enabled=yes contact="noc@isp.com" location="POP-Central"
/snmp community add name=public addresses=IP_DO_AGENTE/32 read-access=yes

# SNMP v3 (recomendado em produção — auth+priv)
/snmp community remove [find name=public]
/snmp v3 user add name=snmpmonitor authentication-protocol=sha auth-password=AUTH_FORTE \
  encryption-protocol=aes encryption-password=PRIV_FORTE
```

> Restrinja portas `8728` e `161/UDP` por firewall ao IP do agente.

## 2. Instalar o agente

```bash
# Em um servidor Linux (pode ser uma VM no provedor)
sudo useradd -r -s /usr/sbin/nologin -d /opt/noc-agent noc-agent
sudo mkdir -p /opt/noc-agent
sudo chown noc-agent:noc-agent /opt/noc-agent

# Copie a pasta `agent/` deste repositório para /opt/noc-agent/
# (via git, scp ou rsync)

cd /opt/noc-agent
sudo -u noc-agent npm install --omit=dev
```

## 3. Configurar

```bash
sudo -u noc-agent cp config.example.json config.json
sudo -u noc-agent nano config.json
```

Edite:

| Campo | Descrição |
|------|-----------|
| `ingest_url` | URL da Edge Function (já preenchida) |
| `ingest_token` | Cole o valor do secret `AGENT_INGEST_TOKEN` |
| `poll_interval_seconds` | Intervalo de coleta (default 30s) |
| `concentradores[]` | Lista dos seus MikroTiks |

Permissões seguras:
```bash
sudo chmod 600 /opt/noc-agent/config.json
sudo chown noc-agent:noc-agent /opt/noc-agent/config.json
```

## 4. Rodar manualmente (teste)

```bash
sudo -u noc-agent node /opt/noc-agent/src/index.js
```

Você deve ver logs do tipo:
```
[2026-04-18T12:00:00.000Z] [INFO] 🚀 Agente iniciado. 2 concentrador(es). Intervalo: 30s
[2026-04-18T12:00:01.123Z] [INFO] ✓ BRAS-01 | online=128 | new=0 | dis=0 | evt=0
```

## 5. Rodar como serviço (systemd)

```bash
sudo cp /opt/noc-agent/systemd/noc-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now noc-agent
sudo systemctl status noc-agent
sudo tail -f /var/log/noc-agent.log
```

## O que o agente coleta

**RouterOS API (a cada `poll_interval_seconds`):**
- `/system/resource` → CPU, memória, uptime, modelo, versão RouterOS
- `/system/identity` → nome do equipamento
- `/ppp/active` → todas as sessões PPPoE ativas

**SNMP (a cada `snmp_poll_interval_seconds`):**
- `sysUpTime`, `hrProcessorLoad`, `hrStorage` (RAM)
- `ifTable`/`ifXTable` por interface: nome, descrição, alias, velocidade, status,
  contadores 64-bit `ifHCInOctets`/`ifHCOutOctets`, erros

A Edge Function `metrics-ingest`:
1. Resolve concentrador/RBS pelo `host`
2. Faz upsert das interfaces descobertas
3. **Calcula bps via delta** entre amostras consecutivas de octets
4. Insere amostras em `metric_samples` (retenção 7 dias)
5. Atualiza status do equipamento (online/offline) e CPU/mem

A Edge Function `agent-ingest`:
1. Faz **upsert** do concentrador (chave: `host`)
2. Reconcilia sessões PPPoE (insere novas, marca desconectadas)
3. Gera **eventos** (`connect`, `disconnect`, `device_down`, `device_up`)
4. Cria **alertas críticos** automaticamente quando um concentrador cai

## Troubleshooting

| Sintoma | Causa provável |
|--------|---------------|
| `HTTP 401: Unauthorized` | `ingest_token` errado em `config.json` |
| `cannot log in` | Usuário/senha do MikroTik incorretos |
| `connect ETIMEDOUT` | Firewall bloqueando porta 8728 ou IP errado |
| `connect ECONNREFUSED` | Serviço `api` desativado no RouterOS |
| `SNMP ✗ ... RequestTimedOutError` | SNMP desabilitado, community errada ou firewall UDP/161 |
| `SNMP ✗ ... AuthenticationError` | Credenciais SNMPv3 (auth/priv) erradas |
| Concentrador some do dashboard | Verifique `sudo journalctl -u noc-agent -n 100` |

## Troubleshooting

| Sintoma | Causa provável |
|--------|---------------|
| `HTTP 401: Unauthorized` | `ingest_token` errado em `config.json` |
| `cannot log in` | Usuário/senha do MikroTik incorretos |
| `connect ETIMEDOUT` | Firewall bloqueando porta 8728 ou IP errado |
| `connect ECONNREFUSED` | Serviço `api` desativado no RouterOS |
| Concentrador some do dashboard | Verifique `sudo journalctl -u noc-agent -n 100` |

## Segurança

- Nunca exponha a porta API do MikroTik à internet pública
- Use SSL (porta 8729) em ambientes sensíveis: defina `"port": 8729` no config
- Faça rotação periódica do `AGENT_INGEST_TOKEN`
- O `config.json` contém senhas — mantenha em modo `600`

---

## VPN (WireGuard + OpenVPN)

O agente também pode manter túneis VPN ativos para alcançar concentradores em redes privadas.

### Pré-requisitos

```bash
sudo apt install -y wireguard-tools openvpn iputils-ping
```

O agente precisa rodar **como root** (ou com `CAP_NET_ADMIN`) para gerenciar interfaces VPN.

### Configuração

1. No app: **Administração → Agentes** → criar agente → copiar token (só aparece uma vez)
2. Definir variáveis de ambiente no systemd unit:

   ```ini
   [Service]
   Environment="VPN_AGENT_TOKEN=<token>"
   Environment="VPN_SYNC_URL=https://<projeto>.supabase.co/functions/v1/vpn-agent-sync"
   ```

3. Em **Administração → VPN**: cadastrar túneis (WG ou OVPN), vincular ao agente, marcar `desired_state=up`
4. Importar `vpn.js` no `index.js` do agente:

   ```js
   import { startVpnLoop } from "./vpn.js";
   if (process.env.VPN_AGENT_TOKEN && process.env.VPN_SYNC_URL) {
     startVpnLoop({ syncUrl: process.env.VPN_SYNC_URL, token: process.env.VPN_AGENT_TOKEN });
   }
   ```

### Como funciona

- Agente faz POST em `vpn-agent-sync` a cada 15s
- Recebe `{ tunnels: [...] }` com chaves descriptografadas (apenas em memória)
- WireGuard: escreve `/etc/wireguard/lov-<id8>.conf` e roda `wg-quick up`
- OpenVPN: escreve `/etc/openvpn/client/lov-<id8>.conf` e `systemctl restart openvpn-client@`
- Mede latência via `ping` no primeiro `allowed_ip` (WG) e reporta status
- Túneis com `desired_state=down` são derrubados e arquivos removidos

### Segurança da VPN

- Chaves privadas ficam **criptografadas com pgsodium** no banco
- Token do agente é guardado como **sha256 hash** — não há recuperação
- Edge function só descriptografa quando o agente apresenta o bearer correto
- Prefixo `lov-` evita conflito com configs WG/OVPN manuais existentes
