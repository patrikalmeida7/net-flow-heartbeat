# 🚀 NOC Collector — Setup VPS Vultr

VPS centralizada que recebe túneis WireGuard/OpenVPN dos MikroTiks dos seus clientes
e envia métricas pro Lovable Cloud.

## Arquitetura

```
[MikroTik Cliente A] ──WG──┐
[MikroTik Cliente B] ──WG──┼──► VPS Vultr ──HTTPS──► Lovable Cloud (SaaS multi-tenant)
[MikroTik Cliente C] ──OVPN┘   (collector)
```

## 1. Criar VPS na Vultr

| Campo | Valor |
|---|---|
| Tipo | Cloud Compute Regular (Intel) |
| Região | São Paulo |
| Imagem | Ubuntu 22.04 LTS x64 |
| Tamanho | 2 GB / 1 vCPU / 55 GB ($12/mês) — suporta 50-80 clientes |
| Tamanho (escala) | 4 GB / 2 vCPU ($24/mês) — suporta 150-200 clientes |
| Hostname | `noc-collector-01` |
| SSH Key | Cole a sua |

Anota o IP público.

## 2. (Opcional) Apontar subdomínio

DNS do teu domínio:
```
A   collector   <IP_VULTR>   TTL: 300
```

## 3. Rodar o setup

SSH na VPS:
```bash
ssh root@<IP_VULTR>
```

Baixa e roda o instalador direto do NOC ISP (sem GitHub, servido por edge function pública):
```bash
curl -fsSL https://rzubqfexhptentnkjcaq.supabase.co/functions/v1/collector-installer | sudo bash
```

Ou já passando o token sem prompt:
```bash
INGEST_TOKEN="cole_o_AGENT_INGEST_TOKEN" \
  sudo -E bash -c "curl -fsSL https://rzubqfexhptentnkjcaq.supabase.co/functions/v1/collector-installer | bash"
```

Vai pedir:
1. **Token de ingestão** — cola o valor do secret `AGENT_INGEST_TOKEN` do Lovable Cloud
2. **Endpoint público** — `collector.seunoc.com.br` ou IP da VPS
3. **Project ref** — deixa default

O script instala automaticamente:
- ✅ Docker + Docker Compose
- ✅ WireGuard server (porta `51820/UDP`)
- ✅ OpenVPN server (porta `1194/UDP`)
- ✅ Agente coletor (Docker, multi-org)
- ✅ Watchtower (auto-update do agente a cada 1h)
- ✅ Firewall UFW
- ✅ Fail2ban (proteção SSH)
- ✅ IP forwarding + NAT pra VPN
- ✅ Helper `noc-add-client` pra adicionar clientes

## 4. Adicionar primeiro cliente

```bash
sudo noc-add-client acme-corp 10.100.0.10
```

Saída inclui:
- `.conf` salvo em `/etc/wireguard/clients/acme-corp.conf`
- **Comandos prontos pra colar no MikroTik do cliente** (RouterOS 7.1+)

## 5. Verificar

```bash
# Peers WireGuard conectados
wg show

# Logs do agente
docker logs -f noc-agent

# Status geral
systemctl status wg-quick@wg0 openvpn-server@server docker fail2ban
```

## 6. No painel Lovable Cloud (próxima etapa)

A edge function `vpn-agent-sync` vai:
1. Receber heartbeats do agente da VPS
2. Listar túneis WG/OVPN ativos por organização
3. Quando você cadastrar um novo cliente no painel:
   - Edge function gera par de chaves WG
   - Aloca IP `10.100.0.X` único
   - Retorna `.conf` pronto pro cliente colar no MikroTik
   - Adiciona peer automaticamente na VPS via API

## Troubleshooting

| Sintoma | Solução |
|---|---|
| `wg show` não lista peers | `systemctl restart wg-quick@wg0` |
| Cliente não pinga `10.100.0.1` | Verifica firewall do MikroTik + `endpoint` correto no `.conf` |
| Agente não envia métricas | `docker logs noc-agent` — provavelmente token errado |
| OpenVPN não sobe | `journalctl -u openvpn-server@server -n 50` |
| VPS lotada (>80 clientes) | Upgrade pra 4GB Vultr ou clona uma 2ª VPS |

## Custo mensal

| Componente | Custo |
|---|---|
| Vultr 2GB SP | $12/mês (R$ 60) |
| Backup automático Vultr (recomendado) | +$2.40/mês |
| **Total** | **~$14.40/mês (R$ 72)** |

Cobrando R$ 99/cliente (Starter) × 50 clientes = R$ 4.950/mês → margem **98.5%** ✅

## Escalando

Quando passar de ~80 clientes na 2GB:
1. Upgrade Vultr 4GB (1 clique, $24/mês, sem reinstalar)
2. Ou cria 2ª VPS `collector-02` e divide clientes por região
3. Edge function `vpn-agent-sync` já suporta múltiplas VPS coletoras
