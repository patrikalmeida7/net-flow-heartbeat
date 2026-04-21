#!/usr/bin/env bash
# Diagnóstico rápido do noc-agent na VPS.
# Uso: bash check-agent.sh
set -uo pipefail

CONTAINER="${1:-noc-agent}"
echo "=== noc-agent diagnóstico ==="
echo

# 1) Container existe?
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "✗ Container '$CONTAINER' NÃO existe."
  echo "  → cd /opt/noc-agent && docker compose up -d"
  exit 1
fi

# 2) Está rodando?
STATE=$(docker inspect -f '{{.State.Status}}' "$CONTAINER")
HEALTH=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$CONTAINER")
echo "Status: $STATE | Health: $HEALTH"

if [ "$STATE" != "running" ]; then
  echo "✗ Container parado. Últimos logs:"
  docker logs --tail 30 "$CONTAINER"
  exit 1
fi

# 3) Imagem rodando + tag
IMAGE=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")
DIGEST=$(docker inspect -f '{{.Image}}' "$CONTAINER" | cut -c8-19)
echo "Imagem: $IMAGE ($DIGEST)"

# 4) Últimos 30 logs com cor pra erros
echo
echo "=== últimos 30 logs ==="
docker logs --tail 30 "$CONTAINER" 2>&1 | sed -E \
  -e 's/.*\[ERROR\].*/\x1b[31m&\x1b[0m/' \
  -e 's/.*\[WARN\].*/\x1b[33m&\x1b[0m/' \
  -e 's/.*✓.*/\x1b[32m&\x1b[0m/'

# 5) Procura erros conhecidos nos últimos 200 logs
echo
echo "=== diagnóstico de erros (últimos 200 logs) ==="
LOGS=$(docker logs --tail 200 "$CONTAINER" 2>&1)

check() {
  local pattern="$1"
  local msg="$2"
  if echo "$LOGS" | grep -qE "$pattern"; then
    echo "  ⚠ $msg"
    return 0
  fi
  return 1
}

FOUND=0
check "HTTP 401"        "401 Unauthorized — INGEST_TOKEN está errado no config.json" && FOUND=1
check "HTTP 403"        "403 Forbidden — token revogado ou agente desativado no painel" && FOUND=1
check "ETIMEDOUT"       "Timeout de rede — verificar firewall / IP do MikroTik" && FOUND=1
check "ECONNREFUSED"    "Conexão recusada — serviço API do MikroTik desligado" && FOUND=1
check "ENOTFOUND"       "DNS falhou — verificar conectividade de internet" && FOUND=1
check "FATAL"           "Erro fatal no agente — ver logs completos" && FOUND=1

if [ $FOUND -eq 0 ]; then
  echo "  ✓ nenhum erro crítico detectado"
fi

# 6) Confirma heartbeat recente
echo
HEARTBEATS=$(echo "$LOGS" | grep -cE '✓ |samples=|metrics pushed' || true)
echo "Heartbeats nos últimos 200 logs: $HEARTBEATS"
if [ "$HEARTBEATS" -eq 0 ]; then
  echo "  ⚠ Nenhum heartbeat recente. Agente pode estar travado."
  exit 2
fi

echo
echo "✓ noc-agent saudável."
