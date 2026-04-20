#!/usr/bin/env bash
# Instalador do NOC Agent (Lovable Cloud)
# Uso: sudo bash install.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="/opt/noc-agent"
SERVICE_USER="noc-agent"

echo "==> 1/6 Verificando dependências"
for cmd in node npm wg wg-quick; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "FALTANDO: $cmd — rode antes:"
    echo "  apt install -y nodejs npm wireguard wireguard-tools"
    exit 1
  fi
done
node --version

echo "==> 2/6 Criando usuário $SERVICE_USER"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$INSTALL_DIR" "$SERVICE_USER"

echo "==> 3/6 Copiando agente para $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -r "$REPO_DIR"/{src,package.json,config.example.json} "$INSTALL_DIR"/
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

echo "==> 4/6 Instalando dependências npm"
cd "$INSTALL_DIR"
sudo -u "$SERVICE_USER" npm install --omit=dev

echo "==> 5/6 Criando config.json (se não existir)"
if [ ! -f "$INSTALL_DIR/config.json" ]; then
  sudo -u "$SERVICE_USER" cp "$INSTALL_DIR/config.example.json" "$INSTALL_DIR/config.json"
  chmod 600 "$INSTALL_DIR/config.json"
  echo "   ⚠️  EDITE: $INSTALL_DIR/config.json (ingest_token + concentradores)"
fi

echo "==> 6/6 Instalando systemd service"
cp "$REPO_DIR/systemd/noc-agent.service" /etc/systemd/system/
# Roda como root (precisa para wg-quick / openvpn)
sed -i 's/^User=.*/User=root/' /etc/systemd/system/noc-agent.service
systemctl daemon-reload

cat <<EOF

✅ Instalação concluída.

Próximos passos:
  1. Edite o config:
       nano $INSTALL_DIR/config.json
     - Cole o ingest_token (Admin → Agentes no Lovable)
     - Adicione seus concentradores (host, user, password, snmp)

  2. Defina variáveis VPN (se for usar):
       systemctl edit noc-agent
     Adicione:
       [Service]
       Environment="VPN_AGENT_TOKEN=<token-do-Admin-Agentes>"
       Environment="VPN_SYNC_URL=https://rzubqfexhptentnkjcaq.supabase.co/functions/v1/vpn-agent-sync"

  3. Iniciar:
       systemctl enable --now noc-agent
       journalctl -u noc-agent -f

EOF
