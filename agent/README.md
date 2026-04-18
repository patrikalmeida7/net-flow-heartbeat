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

## 1. Criar usuário read-only no MikroTik

```routeros
/user group add name=api-ro policy=read,api,!ftp,!reboot,!write,!policy,!test,!password,!sniff,!sensitive,!romon
/user add name=api-readonly group=api-ro password="SENHA-FORTE-AQUI"
/ip service set api address=IP_DO_AGENTE/32 disabled=no
```

> Restrinja a porta `8728` por firewall ao IP do servidor onde o agente roda.

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

Por concentrador, a cada ciclo:

- `/system/resource` → CPU, memória, uptime, modelo, versão RouterOS
- `/system/identity` → nome do equipamento
- `/ppp/active` → todas as sessões PPPoE ativas (username, IP, interface, uptime)

A Edge Function:
1. Faz **upsert** do concentrador (chave: `host`)
2. Reconcilia sessões (insere novas, marca desconectadas como `online=false`)
3. Gera **eventos** (`connect`, `disconnect`, `device_down`, `device_up`)
4. Cria **alertas críticos** automaticamente quando um concentrador cai

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
