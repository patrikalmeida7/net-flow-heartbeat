# NOC Agent — Auto-deploy via GHCR + Watchtower

Arquitetura **100% automatizada**: você (ou a Lovable) faz push no GitHub → CI builda imagem Docker → Watchtower na VPS atualiza o container sozinho. Zero SSH, zero `git pull`, zero rebuild manual.

## 🔄 Fluxo

```
┌────────┐   git push   ┌──────────────────┐   docker push   ┌──────┐
│Lovable │─────────────▶│ GitHub Actions   │────────────────▶│ GHCR │
└────────┘              │ (builda imagem)  │                 └───┬──┘
                        └──────────────────┘                     │
                                                                 │ pull a cada 60s
                                                                 ▼
                                                        ┌────────────────┐
                                                        │ VPS: Watchtower│
                                                        │  ↓ recria      │
                                                        │ noc-agent      │
                                                        └────────────────┘
```

Tempo total entre push e agente rodando código novo: **2–4 minutos** (build CI ~2min + poll Watchtower ≤60s).

---

## 1. Setup inicial (uma vez só, na VPS)

A VPS já tem frontend + nginx rodando. Vamos só **adicionar** Docker + agent + watchtower.

### Pré-requisito: Docker
```bash
ssh root@SEU_IP_VPS
curl -fsSL https://get.docker.com | sh
docker --version
docker compose version
```

### Instalar o agent
```bash
curl -fsSL https://raw.githubusercontent.com/patrikalmeida7/net-flow-heartbeat/main/agent/scripts/install-vps.sh | sudo bash
```

O instalador:
- Baixa `docker-compose.yml`, `.env.example`, `config.example.json`
- Cria `/opt/noc-agent/{config,.env}`
- Faz `docker compose pull && up -d`
- Sobe **agent + watchtower**

### Configurar
```bash
sudo nano /opt/noc-agent/config/config.json    # ingest_token + concentradores
sudo nano /opt/noc-agent/.env                  # VPN_AGENT_TOKEN (se for usar)
cd /opt/noc-agent && sudo docker compose up -d
```

### Verificar
```bash
docker ps
docker logs -f noc-agent
bash /opt/noc-agent/scripts/check-agent.sh   # diagnóstico colorido
```

---

## 2. GitHub Container Registry: tornar a imagem pública (opcional)

Por padrão, a imagem que o CI publica em `ghcr.io/patrikalmeida7/net-flow-heartbeat-agent` fica **privada**. Duas opções:

### Opção A — Imagem pública (mais simples)
1. https://github.com/users/patrikalmeida7/packages/container/net-flow-heartbeat-agent/settings
2. Scroll até **Danger Zone → Change visibility → Public**

Pronto: a VPS baixa sem login.

### Opção B — Imagem privada (mais segura)
Crie um Personal Access Token com `read:packages` e faça login na VPS:
```bash
echo SEU_PAT_AQUI | docker login ghcr.io -u patrikalmeida7 --password-stdin
```
Watchtower já está montado com acesso ao `~/.docker/config.json` quando você descomentar a linha no `docker-compose.yml`.

---

## 3. Como atualizar o código

### Caminho normal (automático)
1. Lovable edita arquivos em `agent/`
2. Push em `main` (sync automático Lovable→GitHub)
3. Workflow `.github/workflows/agent-image.yml` builda + publica `:latest` e `:sha-XXXXXXX`
4. Watchtower vê tag nova em até 60s, baixa, recria container
5. Heartbeats voltam a aparecer em ~5s

### Forçar update manual
```bash
cd /opt/noc-agent
docker compose pull
docker compose up -d
```

### Travar uma versão específica (rollback)
```bash
sudo nano /opt/noc-agent/.env
# IMAGE_TAG=sha-abc1234
sudo docker compose up -d
```

Watchtower só atualiza imagens com a tag definida em `IMAGE_TAG`. Se você travar em `sha-abc1234`, ele para de atualizar até você voltar pra `latest`.

---

## 4. Healthcheck e auto-recuperação

### Healthcheck do Docker
O container escreve `/tmp/noc-agent.healthy` após cada tick de coleta. Se ficar > 90s sem atualizar, fica `unhealthy`.

```bash
docker inspect -f '{{.State.Health.Status}}' noc-agent
# healthy | unhealthy | starting
```

### Restart automático
- `restart: always` → se o processo morrer, Docker reinicia
- Watchtower com `WATCHTOWER_INCLUDE_RESTARTING=true` → não pula container reiniciando

### Detectar problemas
```bash
bash /opt/noc-agent/scripts/check-agent.sh
```

Output mostra:
- Status do container e healthcheck
- Imagem em uso (digest)
- Últimos 30 logs com cor pra ERROR/WARN
- Verifica padrões: `HTTP 401`, `HTTP 403`, `ETIMEDOUT`, `ECONNREFUSED`, `ENOTFOUND`, `FATAL`
- Conta heartbeats nos últimos 200 logs

---

## 5. Segurança

| Item | Como protegemos |
|------|-----------------|
| `INGEST_TOKEN` | Vive só em `/opt/noc-agent/config/config.json` (chmod 600), nunca em logs (não é printado) |
| `VPN_AGENT_TOKEN` | Vive só em `/opt/noc-agent/.env` (chmod 600), passado como env do container |
| Webhook do CI | Não usado nesse fluxo — Watchtower puxa, não recebe push |
| Capabilities | Container só tem `NET_ADMIN` (necessário pra wg-quick), não `--privileged` |
| GHCR auth | Imagem pública OU token read-only |

### Firewall (se ainda não tem)
```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

---

## 6. Adicionar cliente WireGuard (existing flow)

O container monta `/etc/wireguard` como volume persistente, então o comando `noc-add-client` continua funcionando — **mas precisa rodar dentro do container**:

```bash
docker exec -it noc-agent wg-quick up wg0
docker exec -it noc-agent wg show
```

Ou exponha o script via volume bind se quiser usar do host. (Ver `agent/README.md` seção VPN.)

---

## 7. Comandos prontos (copia e cola)

```bash
# Status
docker ps --filter name=noc-

# Logs ao vivo
docker logs -f --tail 50 noc-agent
docker logs -f --tail 20 noc-watchtower

# Diagnóstico completo
bash /opt/noc-agent/scripts/check-agent.sh

# Forçar atualização
cd /opt/noc-agent && docker compose pull && docker compose up -d

# Restart limpo
cd /opt/noc-agent && docker compose restart noc-agent

# Ver versão da imagem em produção
docker inspect -f '{{.Config.Image}} ({{.Image}})' noc-agent

# Ver última atualização do Watchtower
docker logs noc-watchtower 2>&1 | grep -i "found new" | tail -5
```

---

## 8. Troubleshooting

| Sintoma | Diagnóstico | Solução |
|---------|-------------|---------|
| `unauthorized` no `docker pull` | Imagem privada sem login | Tornar pública (seção 2.A) ou logar (2.B) |
| Watchtower não atualiza | Imagem talvez travada em sha | Conferir `IMAGE_TAG` em `.env` — deve ser `latest` |
| Container reinicia em loop | `config.json` inválido ou sem `ingest_token` | `docker logs noc-agent` mostra `[FATAL]` |
| 401 Unauthorized nos logs | Token errado | Atualizar `config.json` → `docker compose restart noc-agent` |
| `wg-quick: permission denied` | Falta NET_ADMIN | Verificar `cap_add` no docker-compose.yml |
| CI falha em "log in to GHCR" | Permissão do `GITHUB_TOKEN` | Settings → Actions → Workflow permissions → Read and write |

---

## 9. Por que GHCR + Watchtower (e não webhook)?

Você tinha 2 opções; escolhemos esta porque:

| | Webhook+rebuild | **GHCR+Watchtower (escolhido)** |
|--|-----------------|----------------------------------|
| Build na VPS | Sim (consome CPU/RAM) | Não (build no CI gratuito) |
| Tempo deploy | ~30-60s | ~2-4min |
| Rollback | git checkout + rebuild | Trocar IMAGE_TAG (~10s) |
| Versionamento | Por commit | Por imagem imutável |
| Múltiplas VPS | Cada uma builda | Todas baixam a mesma |
| Falha de build | Quebra produção | Versão antiga continua rodando |

Pra escalar pra 2+ coletoras, GHCR é imbatível.
