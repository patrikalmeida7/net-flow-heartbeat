#!/usr/bin/env bash
# Instala o GenieACS na VPS sem tocar em outros containers. Uso: sudo bash setup.sh
set -euo pipefail
cd "$(dirname "$0")"
command -v docker >/dev/null || { echo "Docker não encontrado"; exit 1; }

if [ ! -f .env ]; then
  echo "GENIEACS_UI_JWT_SECRET=$(openssl rand -hex 32)" > .env
  chmod 600 .env
fi

if [ ! -f nbi.htpasswd ]; then
  NBI_USER=noc
  NBI_PASS=$(openssl rand -base64 24 | tr -d '/+=')
  printf '%s:%s\n' "$NBI_USER" "$(openssl passwd -apr1 "$NBI_PASS")" > nbi.htpasswd
  chmod 644 nbi.htpasswd
  echo "==== GUARDE (mostrado só agora) ===="
  echo "Usuário NBI: $NBI_USER"
  echo "Senha NBI:   $NBI_PASS"
  echo "===================================="
fi

docker compose up -d
IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
echo
echo "No NOC-ISP → Modems / ONTs → Adicionar ACS:"
echo "  URL da API NBI: http://$IP:7558"
echo "  URL CWMP (configurar nos modems): http://$IP:7547"
echo "Libere no firewall: TCP 7547 (modems) e 7558 (API, idealmente só para o NOC)."
