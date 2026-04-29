#!/usr/bin/env bash
# =============================================================
# Instalador one-shot do NOC Agent (Docker + Watchtower) na VPS
# Funciona em VPS limpa OU em VPS que já tem o frontend rodando.
#
# Uso (rode como root):
#   curl -fsSL https://raw.githubusercontent.com/patrikalmeida7/net-flow-heartbeat/main/agent/scripts/install-vps.sh | bash
# Ou:
#   sudo bash agent/scripts/install-vps.sh
# =============================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/noc-agent}"
REPO_RAW="https://raw.githubusercontent.com/patrikalmeida7/net-flow-heartbeat/main/agent"

log() { echo -e "\n\033[1;36m==> $*\033[0m"; }
err() { echo -e "\033[1;31m✗ $*\033[0m" >&2; }

if [ "$(id -u)" -ne 0 ]; then
  err "Rode como root: sudo bash $0"; exit 1
fi

# 1. Docker
log "1/5 Verificando Docker"
if ! command -v docker >/dev/null 2>&1; then
  log "Instalando Docker via script oficial"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  err "Docker Compose v2 não disponível. Atualize Docker."; exit 1
fi
docker --version

# 2. Diretório + arquivos
log "2/5 Preparando $INSTALL_DIR"
mkdir -p "$INSTALL_DIR/config"

for f in docker-compose.yml .env.example; do
  if [ ! -f "$INSTALL_DIR/$f" ]; then
    log "Baixando $f"
    curl -fsSL "$REPO_RAW/$f" -o "$INSTALL_DIR/$f"
  fi
done

if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  log "✏️  Edite $INSTALL_DIR/.env (IMAGE_REF, VPN_AGENT_TOKEN se for usar)"
fi

if [ ! -f "$INSTALL_DIR/config/config.json" ]; then
  curl -fsSL "$REPO_RAW/config.example.json" -o "$INSTALL_DIR/config/config.json"
  chmod 600 "$INSTALL_DIR/config/config.json"
  log "✏️  Edite $INSTALL_DIR/config/config.json (ingest_token + concentradores)"
fi

# 3. tun (WireGuard)
log "3/6 Garantindo módulo tun"
modprobe tun 2>/dev/null || true
if [ ! -c /dev/net/tun ]; then
  mkdir -p /dev/net
  mknod /dev/net/tun c 10 200 || true
fi

# 3b. Servidor WireGuard + UFW + noc-add-client (opcional)
# Ative com:  SETUP_WG_SERVER=1 bash install-vps.sh
if [ "${SETUP_WG_SERVER:-0}" = "1" ]; then
  log "3b/6 Instalando servidor WireGuard + firewall + noc-add-client"
  curl -fsSL "$REPO_RAW/scripts/setup-wg-server.sh" -o /tmp/setup-wg-server.sh
  bash /tmp/setup-wg-server.sh
fi

# 4. Pull inicial e up
log "4/6 Subindo stack"
cd "$INSTALL_DIR"
docker compose pull
docker compose up -d

# 5. Status
sleep 3
log "5/6 Status"
docker compose ps
echo
echo "Logs ao vivo:   docker logs -f noc-agent"
echo "Diagnóstico:    bash $INSTALL_DIR/check-agent.sh"
echo "Atualizar tag:  edite IMAGE_TAG em $INSTALL_DIR/.env e rode 'docker compose up -d'"
echo
echo "✅ Watchtower verifica nova imagem a cada 60s e atualiza sozinho."
