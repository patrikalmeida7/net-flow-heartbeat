#!/usr/bin/env bash
# =============================================================
# Setup do servidor WireGuard + UFW + comando noc-add-client
# Idempotente: pode rodar várias vezes sem quebrar.
#
# Uso (como root):
#   bash setup-wg-server.sh
#
# Variáveis (opcionais, com defaults sensatos):
#   WG_IFACE=wg0
#   WG_PORT=51820
#   WG_NETWORK=10.66.66.0/24
#   WG_SERVER_IP=10.66.66.1
#   WG_PUBLIC_HOST=<auto-detect via curl ifconfig.me>
#   WG_DNS=1.1.1.1,8.8.8.8
#   SSH_PORT=22
# =============================================================
set -euo pipefail

WG_IFACE="${WG_IFACE:-wg0}"
WG_PORT="${WG_PORT:-51820}"
WG_NETWORK="${WG_NETWORK:-10.66.66.0/24}"
WG_SERVER_IP="${WG_SERVER_IP:-10.66.66.1}"
WG_DNS="${WG_DNS:-1.1.1.1,8.8.8.8}"
SSH_PORT="${SSH_PORT:-22}"
WG_DIR="/etc/wireguard"
CLIENTS_DIR="$WG_DIR/clients"
STATE_DIR="$WG_DIR/state"

log() { echo -e "\n\033[1;36m==> $*\033[0m"; }
err() { echo -e "\033[1;31m✗ $*\033[0m" >&2; }

[ "$(id -u)" -eq 0 ] || { err "Rode como root"; exit 1; }

log "1/6 Instalando pacotes (wireguard, ufw, qrencode, iproute2)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq wireguard wireguard-tools ufw qrencode iproute2 curl jq >/dev/null

log "2/6 Habilitando IP forwarding"
sed -i 's/^#\?net.ipv4.ip_forward.*/net.ipv4.ip_forward=1/' /etc/sysctl.conf
grep -q '^net.ipv4.ip_forward=1' /etc/sysctl.conf || echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
sysctl -p >/dev/null

log "3/6 Detectando interface pública e IP externo"
PUB_IFACE="$(ip route show default | awk '/default/ {print $5; exit}')"
PUB_IP="${WG_PUBLIC_HOST:-$(curl -fsSL --max-time 5 https://ifconfig.me || echo '')}"
[ -n "$PUB_IFACE" ] || { err "Não consegui detectar interface pública"; exit 1; }
[ -n "$PUB_IP" ]    || { err "Não consegui detectar IP público (defina WG_PUBLIC_HOST)"; exit 1; }
echo "   interface pública: $PUB_IFACE"
echo "   ip público:        $PUB_IP"

log "4/6 Gerando chaves do servidor (se ainda não existirem)"
mkdir -p "$WG_DIR" "$CLIENTS_DIR" "$STATE_DIR"
chmod 700 "$WG_DIR" "$STATE_DIR"
umask 077

if [ ! -f "$WG_DIR/server_private.key" ]; then
  wg genkey | tee "$WG_DIR/server_private.key" | wg pubkey > "$WG_DIR/server_public.key"
fi
SERVER_PRIV="$(cat "$WG_DIR/server_private.key")"
SERVER_PUB="$(cat "$WG_DIR/server_public.key")"

# Salva metadados pro noc-add-client usar
cat > "$STATE_DIR/server.env" <<EOF
WG_IFACE=$WG_IFACE
WG_PORT=$WG_PORT
WG_NETWORK=$WG_NETWORK
WG_SERVER_IP=$WG_SERVER_IP
WG_DNS=$WG_DNS
WG_PUBLIC_HOST=$PUB_IP
SERVER_PUBLIC_KEY=$SERVER_PUB
EOF

# Inicializa o índice de IPs (a partir de .2)
[ -f "$STATE_DIR/last_ip_octet" ] || echo "1" > "$STATE_DIR/last_ip_octet"

log "5/6 Escrevendo /etc/wireguard/$WG_IFACE.conf"
WG_CONF="$WG_DIR/$WG_IFACE.conf"
if [ ! -f "$WG_CONF" ]; then
  cat > "$WG_CONF" <<EOF
[Interface]
Address = ${WG_SERVER_IP}/24
ListenPort = ${WG_PORT}
PrivateKey = ${SERVER_PRIV}
SaveConfig = false
PostUp   = iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT; iptables -t nat -A POSTROUTING -s ${WG_NETWORK} -o ${PUB_IFACE} -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT; iptables -t nat -D POSTROUTING -s ${WG_NETWORK} -o ${PUB_IFACE} -j MASQUERADE

# === peers gerenciados pelo noc-add-client abaixo ===
EOF
  chmod 600 "$WG_CONF"
else
  echo "   $WG_CONF já existe, mantendo."
fi

log "6/6 Subindo wg-quick@$WG_IFACE + firewall UFW"
systemctl enable "wg-quick@$WG_IFACE" >/dev/null
systemctl restart "wg-quick@$WG_IFACE"

# Firewall: SSH, WireGuard, e libera forward
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow "${SSH_PORT}/tcp" >/dev/null
ufw allow "${WG_PORT}/udp" >/dev/null
# Permitir tráfego roteado pelos peers
sed -i 's/^DEFAULT_FORWARD_POLICY=.*/DEFAULT_FORWARD_POLICY="ACCEPT"/' /etc/default/ufw
ufw --force enable >/dev/null

# Instala helper noc-add-client
log "Instalando /usr/local/bin/noc-add-client"
cat > /usr/local/bin/noc-add-client <<'HELPER'
#!/usr/bin/env bash
# noc-add-client <nome> [<ip-interno>]
# Cria um peer WireGuard, salva /etc/wireguard/clients/<nome>.conf
# e injeta o peer no servidor sem reiniciar o túnel.
set -euo pipefail
NAME="${1:?uso: noc-add-client <nome> [<ip-interno>]}"
IP_ARG="${2:-}"

# shellcheck disable=SC1091
source /etc/wireguard/state/server.env

CLIENTS_DIR=/etc/wireguard/clients
STATE_DIR=/etc/wireguard/state
mkdir -p "$CLIENTS_DIR"
umask 077

CONF="$CLIENTS_DIR/${NAME}.conf"
KEY_PRIV="$CLIENTS_DIR/${NAME}.key"
KEY_PUB="$CLIENTS_DIR/${NAME}.pub"
KEY_PSK="$CLIENTS_DIR/${NAME}.psk"

if [ -f "$CONF" ]; then
  echo "cliente $NAME já existe em $CONF" >&2
  cat "$CONF"
  exit 0
fi

# Aloca IP
if [ -n "$IP_ARG" ]; then
  CLIENT_IP="$IP_ARG"
else
  LAST=$(cat "$STATE_DIR/last_ip_octet")
  NEXT=$((LAST + 1))
  [ "$NEXT" -lt 255 ] || { echo "rede $WG_NETWORK cheia" >&2; exit 1; }
  PREFIX="$(echo "$WG_SERVER_IP" | cut -d. -f1-3)"
  CLIENT_IP="${PREFIX}.${NEXT}"
  echo "$NEXT" > "$STATE_DIR/last_ip_octet"
fi

wg genkey | tee "$KEY_PRIV" | wg pubkey > "$KEY_PUB"
wg genpsk > "$KEY_PSK"

CLIENT_PRIV=$(cat "$KEY_PRIV")
CLIENT_PUB=$(cat "$KEY_PUB")
PSK=$(cat "$KEY_PSK")

# Adiciona peer ao servidor (runtime + persiste no .conf)
wg set "$WG_IFACE" peer "$CLIENT_PUB" preshared-key "$KEY_PSK" allowed-ips "${CLIENT_IP}/32"
{
  echo ""
  echo "# client: $NAME"
  echo "[Peer]"
  echo "PublicKey = $CLIENT_PUB"
  echo "PresharedKey = $PSK"
  echo "AllowedIPs = ${CLIENT_IP}/32"
} >> "/etc/wireguard/${WG_IFACE}.conf"

# .conf do cliente
cat > "$CONF" <<EOF
[Interface]
PrivateKey = $CLIENT_PRIV
Address = ${CLIENT_IP}/32
DNS = $WG_DNS

[Peer]
PublicKey = $SERVER_PUBLIC_KEY
PresharedKey = $PSK
Endpoint = ${WG_PUBLIC_HOST}:${WG_PORT}
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
EOF
chmod 600 "$CONF"

echo "✓ cliente $NAME criado: $CONF (ip $CLIENT_IP)"
cat "$CONF"
HELPER
chmod +x /usr/local/bin/noc-add-client

cat <<EOF

✅ WireGuard server pronto.
   Interface:    $WG_IFACE  ($WG_SERVER_IP/24)
   Endpoint:     $PUB_IP:$WG_PORT
   Public key:   $SERVER_PUB
   Comando:      noc-add-client <nome> [<ip-interno>]
   Configs:      $CLIENTS_DIR/<nome>.conf

Status:
  systemctl status wg-quick@$WG_IFACE --no-pager
  wg show
  ufw status
EOF
