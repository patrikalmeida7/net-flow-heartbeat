#!/usr/bin/env bash
# ============================================================================
# NOC Collector VPS — Setup Completo Automatizado
# ============================================================================
# Roda em: Ubuntu 22.04 LTS x64
# Uso:     curl -fsSL https://raw.githubusercontent.com/patrikalmeida7/ntflow/main/deploy/install-vultr-collector.sh | sudo bash
# Ou:      sudo bash vultr-collector-setup.sh
#
# O que instala:
#   - Docker + Docker Compose
#   - WireGuard server (porta 51820/UDP)
#   - OpenVPN server (porta 1194/UDP)
#   - Agente coletor NOC (multi-org, conecta no Lovable Cloud)
#   - Firewall UFW (libera SSH, WG, OVPN)
#   - Fail2ban (proteção SSH)
#   - Auto-update do agente via Watchtower
# ============================================================================

set -euo pipefail

# --- Cores ---
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*" >&2; }

[ "$(id -u)" -eq 0 ] || { err "Rode como root: sudo bash $0"; exit 1; }

# ============================================================================
# 0. Pergunta dados essenciais
# ============================================================================
echo ""
echo "============================================================"
echo "  NOC COLLECTOR — Setup VPS Vultr"
echo "============================================================"
echo ""

read -rp "🔑 Cole o INGEST_TOKEN do Lovable Cloud (secret AGENT_INGEST_TOKEN): " INGEST_TOKEN
[ -z "$INGEST_TOKEN" ] && { err "Token vazio"; exit 1; }

read -rp "🌐 Subdomínio público da VPS (ex: collector.seunoc.com.br) [enter pra usar IP]: " PUBLIC_HOST
PUBLIC_IP=$(curl -fsSL https://api.ipify.org || hostname -I | awk '{print $1}')
PUBLIC_HOST="${PUBLIC_HOST:-$PUBLIC_IP}"
ok "Endpoint público: $PUBLIC_HOST"

read -rp "📡 Lovable Cloud project ref (default: rzubqfexhptentnkjcaq): " PROJECT_REF
PROJECT_REF="${PROJECT_REF:-rzubqfexhptentnkjcaq}"

INGEST_URL="https://${PROJECT_REF}.supabase.co/functions/v1/agent-ingest"
METRICS_URL="https://${PROJECT_REF}.supabase.co/functions/v1/metrics-ingest"
VPN_SYNC_URL="https://${PROJECT_REF}.supabase.co/functions/v1/vpn-agent-sync"

echo ""
log "Configuração:"
echo "  Ingest URL:   $INGEST_URL"
echo "  Metrics URL:  $METRICS_URL"
echo "  VPN Sync URL: $VPN_SYNC_URL"
echo "  Endpoint WG/OVPN: $PUBLIC_HOST"
echo ""
read -rp "Confirma e prossegue? (s/N): " CONFIRM
[[ ! "$CONFIRM" =~ ^[sS]$ ]] && { warn "Cancelado"; exit 0; }

# ============================================================================
# 1. Atualiza sistema + dependências base
# ============================================================================
log "Atualizando sistema..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq

log "Instalando dependências base..."
apt-get install -y -qq \
  curl wget git nano htop \
  ca-certificates gnupg lsb-release \
  ufw fail2ban \
  wireguard wireguard-tools \
  openvpn easy-rsa \
  iputils-ping iproute2 \
  jq openssl

ok "Pacotes base instalados"

# ============================================================================
# 2. Docker + Docker Compose
# ============================================================================
if ! command -v docker &>/dev/null; then
  log "Instalando Docker..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  ok "Docker instalado: $(docker --version)"
else
  ok "Docker já instalado: $(docker --version)"
fi

# ============================================================================
# 3. Firewall UFW
# ============================================================================
log "Configurando firewall..."
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 51820/udp comment 'WireGuard'
ufw allow 1194/udp comment 'OpenVPN'
ufw --force enable
ok "Firewall ativo: SSH, WG/51820, OVPN/1194"

# ============================================================================
# 4. IP Forwarding (necessário pra VPN rotear pacotes)
# ============================================================================
log "Habilitando IP forwarding..."
cat > /etc/sysctl.d/99-noc-forwarding.conf <<EOF
net.ipv4.ip_forward=1
net.ipv4.conf.all.proxy_arp=1
EOF
sysctl -p /etc/sysctl.d/99-noc-forwarding.conf >/dev/null
ok "IP forwarding habilitado"

# ============================================================================
# 5. WireGuard Server (servidor central — clientes conectam aqui)
# ============================================================================
log "Configurando WireGuard server..."
WG_DIR=/etc/wireguard
mkdir -p $WG_DIR
chmod 700 $WG_DIR

if [ ! -f $WG_DIR/server_private.key ]; then
  wg genkey | tee $WG_DIR/server_private.key | wg pubkey > $WG_DIR/server_public.key
  chmod 600 $WG_DIR/server_private.key
  ok "Chaves WireGuard geradas"
fi

WG_PRIV=$(cat $WG_DIR/server_private.key)
WG_PUB=$(cat $WG_DIR/server_public.key)

# Detecta interface de saída (geralmente eth0 ou ens3 na Vultr)
WAN_IF=$(ip route | grep default | awk '{print $5}' | head -1)
ok "Interface WAN detectada: $WAN_IF"

cat > $WG_DIR/wg0.conf <<EOF
# WireGuard server — clientes adicionados via 'wg set' ou edge function
[Interface]
Address = 10.100.0.1/16
ListenPort = 51820
PrivateKey = $WG_PRIV
SaveConfig = false

# NAT pra clientes alcançarem internet via VPS (caso precisem)
PostUp   = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -A FORWARD -o wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o $WAN_IF -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -D FORWARD -o wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o $WAN_IF -j MASQUERADE

# Peers (clientes) são adicionados dinamicamente:
# Use 'wg set wg0 peer <PUBKEY> allowed-ips 10.100.0.X/32 persistent-keepalive 25'
EOF

chmod 600 $WG_DIR/wg0.conf
systemctl enable wg-quick@wg0
systemctl restart wg-quick@wg0
ok "WireGuard server ATIVO em :51820/UDP"

# ============================================================================
# 6. OpenVPN Server (alternativa pra clientes que não suportam WG)
# ============================================================================
log "Configurando OpenVPN server (modo simplificado)..."
OVPN_DIR=/etc/openvpn/server
mkdir -p $OVPN_DIR

if [ ! -f $OVPN_DIR/ca.crt ]; then
  EASYRSA_DIR=/etc/openvpn/easy-rsa
  rm -rf $EASYRSA_DIR
  make-cadir $EASYRSA_DIR
  cd $EASYRSA_DIR

  export EASYRSA_BATCH=1
  export EASYRSA_REQ_CN="NOC-Collector-CA"
  ./easyrsa init-pki >/dev/null 2>&1
  ./easyrsa build-ca nopass >/dev/null 2>&1
  ./easyrsa gen-req server nopass >/dev/null 2>&1
  ./easyrsa sign-req server server >/dev/null 2>&1
  ./easyrsa gen-dh >/dev/null 2>&1
  openvpn --genkey --secret pki/ta.key

  cp pki/ca.crt pki/issued/server.crt pki/private/server.key pki/dh.pem pki/ta.key $OVPN_DIR/
  cd /
  ok "Certificados OpenVPN gerados"
fi

cat > $OVPN_DIR/server.conf <<EOF
port 1194
proto udp
dev tun
ca ca.crt
cert server.crt
key server.key
dh dh.pem
tls-auth ta.key 0
server 10.200.0.0 255.255.0.0
ifconfig-pool-persist /var/log/openvpn/ipp.txt
keepalive 10 120
cipher AES-256-GCM
auth SHA256
user nobody
group nogroup
persist-key
persist-tun
status /var/log/openvpn/status.log
verb 3
client-to-client
duplicate-cn
push "route 10.100.0.0 255.255.0.0"
EOF

# NAT pra OpenVPN
iptables -t nat -A POSTROUTING -s 10.200.0.0/16 -o "$WAN_IF" -j MASQUERADE 2>/dev/null || true
iptables-save > /etc/iptables.rules

mkdir -p /var/log/openvpn
systemctl enable openvpn-server@server
systemctl restart openvpn-server@server
ok "OpenVPN server ATIVO em :1194/UDP"

# ============================================================================
# 7. Agente Coletor NOC (Docker)
# ============================================================================
log "Instalando agente coletor NOC..."
COLLECTOR_DIR=/opt/noc-collector
mkdir -p $COLLECTOR_DIR
cd $COLLECTOR_DIR

# Cria config base do agente — ele vai puxar a lista de clientes do Lovable Cloud
cat > $COLLECTOR_DIR/config.json <<EOF
{
  "ingest_url": "$INGEST_URL",
  "metrics_ingest_url": "$METRICS_URL",
  "ingest_token": "$INGEST_TOKEN",
  "poll_interval_seconds": 30,
  "snmp_poll_interval_seconds": 30,
  "request_timeout_ms": 10000,
  "concentradores": [],
  "rbs": []
}
EOF
chmod 600 $COLLECTOR_DIR/config.json

cat > $COLLECTOR_DIR/docker-compose.yml <<EOF
services:
  agent:
    image: node:20-alpine
    container_name: noc-agent
    restart: unless-stopped
    network_mode: host  # precisa ver as redes WG/OVPN
    cap_add:
      - NET_ADMIN
    volumes:
      - ./agent:/app
      - ./config.json:/app/config.json:ro
      - /etc/wireguard:/etc/wireguard
      - /etc/openvpn:/etc/openvpn
    working_dir: /app
    environment:
      - VPN_AGENT_TOKEN=$INGEST_TOKEN
      - VPN_SYNC_URL=$VPN_SYNC_URL
      - NODE_ENV=production
    command: sh -c "apk add --no-cache wireguard-tools openvpn iputils && npm install --omit=dev && node src/index.js"

  watchtower:
    image: containrrr/watchtower
    container_name: watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --interval 3600 --cleanup
EOF

# Clona o agente do repo (você ajusta a URL pro seu fork)
log "Baixando código do agente..."
if [ ! -d $COLLECTOR_DIR/agent ]; then
  git clone --depth 1 https://github.com/patrikalmeida7/net-flow-heartbeat.git /tmp/noc-repo
  cp -r /tmp/noc-repo/agent $COLLECTOR_DIR/
  rm -rf /tmp/noc-repo
fi

cd $COLLECTOR_DIR
docker compose up -d
ok "Agente coletor RODANDO em Docker"

# ============================================================================
# 8. Fail2ban (proteção SSH brute-force)
# ============================================================================
log "Configurando Fail2ban..."
cat > /etc/fail2ban/jail.local <<EOF
[sshd]
enabled = true
port = 22
maxretry = 5
bantime = 3600
findtime = 600
EOF
systemctl enable --now fail2ban
ok "Fail2ban ATIVO"

# ============================================================================
# 9. Script auxiliar pra adicionar clientes WireGuard
# ============================================================================
log "Criando helper /usr/local/bin/noc-add-client..."
cat > /usr/local/bin/noc-add-client <<'EOF'
#!/usr/bin/env bash
# Adiciona um cliente WireGuard e gera o .conf pra ele colar no MikroTik
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Rode como root"; exit 1; }
[ $# -lt 2 ] && { echo "Uso: $0 <nome-cliente> <ip-interno-na-vpn> [endpoint-publico]"; echo "Ex:  $0 acme-corp 10.100.0.10 collector.seunoc.com.br"; exit 1; }

NAME=$1
CLIENT_IP=$2
ENDPOINT=${3:-$(curl -fsSL https://api.ipify.org)}
WG_DIR=/etc/wireguard
SERVER_PUB=$(cat $WG_DIR/server_public.key)

# Gera par de chaves do cliente
CLIENT_PRIV=$(wg genkey)
CLIENT_PUB=$(echo "$CLIENT_PRIV" | wg pubkey)
PSK=$(wg genpsk)

# Adiciona peer no servidor
wg set wg0 peer "$CLIENT_PUB" preshared-key <(echo "$PSK") allowed-ips "$CLIENT_IP/32" persistent-keepalive 25
wg-quick save wg0

# Salva config do cliente
mkdir -p /etc/wireguard/clients
cat > "/etc/wireguard/clients/${NAME}.conf" <<CONF
# WireGuard config para: $NAME
# Cole no MikroTik: /interface/wireguard ...
[Interface]
PrivateKey = $CLIENT_PRIV
Address = $CLIENT_IP/16
DNS = 1.1.1.1

[Peer]
PublicKey = $SERVER_PUB
PresharedKey = $PSK
Endpoint = $ENDPOINT:51820
AllowedIPs = 10.100.0.0/16
PersistentKeepalive = 25
CONF

chmod 600 "/etc/wireguard/clients/${NAME}.conf"

echo ""
echo "============================================"
echo "✅ Cliente '$NAME' adicionado!"
echo "   IP interno: $CLIENT_IP"
echo "   Config:     /etc/wireguard/clients/${NAME}.conf"
echo "============================================"
echo ""
echo "📋 Comandos pra colar no MikroTik (RouterOS 7.1+):"
echo ""
cat <<MIKROTIK
/interface/wireguard add name=wg-noc listen-port=13231 private-key="$CLIENT_PRIV"
/interface/wireguard/peers add interface=wg-noc public-key="$SERVER_PUB" preshared-key="$PSK" endpoint-address=$ENDPOINT endpoint-port=51820 allowed-address=10.100.0.0/16 persistent-keepalive=25s
/ip/address add address=$CLIENT_IP/16 interface=wg-noc
/ip/route add dst-address=10.100.0.0/16 gateway=wg-noc
MIKROTIK
echo ""
EOF
chmod +x /usr/local/bin/noc-add-client
ok "Helper instalado: noc-add-client <nome> <ip>"

# ============================================================================
# 10. Resumo final
# ============================================================================
echo ""
echo "============================================================"
echo -e "${GREEN}🎉 SETUP COMPLETO!${NC}"
echo "============================================================"
echo ""
echo "📊 Status dos serviços:"
systemctl is-active wg-quick@wg0       | xargs -I{} echo "   WireGuard:  {}"
systemctl is-active openvpn-server@server | xargs -I{} echo "   OpenVPN:    {}"
systemctl is-active docker             | xargs -I{} echo "   Docker:     {}"
systemctl is-active fail2ban           | xargs -I{} echo "   Fail2ban:   {}"
docker ps --format "   {{.Names}}: {{.Status}}" | grep -E "noc-agent|watchtower"
echo ""
echo "🌐 Endpoints públicos:"
echo "   $PUBLIC_HOST:51820/UDP  (WireGuard)"
echo "   $PUBLIC_HOST:1194/UDP   (OpenVPN)"
echo ""
echo "🔑 Chave pública WireGuard server (pra usar nas configs cliente):"
echo "   $WG_PUB"
echo ""
echo "📦 Arquivos importantes:"
echo "   /etc/wireguard/wg0.conf            ← config do server"
echo "   /etc/wireguard/clients/            ← configs por cliente"
echo "   /opt/noc-collector/                ← agente Docker"
echo "   /opt/noc-collector/config.json     ← config do agente"
echo ""
echo "🛠️  Comandos úteis:"
echo "   noc-add-client acme-corp 10.100.0.10                ← adiciona cliente"
echo "   docker logs -f noc-agent                            ← logs do agente"
echo "   wg show                                             ← peers conectados"
echo "   systemctl status wg-quick@wg0                       ← status WG"
echo ""
echo "⚠️  GUARDE A CHAVE PÚBLICA WG ACIMA — vai usar no painel Lovable"
echo "============================================================"
