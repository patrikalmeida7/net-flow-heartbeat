#!/usr/bin/env bash
# Healthcheck do container noc-agent.
# O loop principal (src/index.js) toca em /tmp/noc-agent.healthy
# após cada tick bem-sucedido (RouterOS API ou SNMP).
# Se esse arquivo ficar > MAX_AGE segundos sem ser atualizado,
# o Docker marca o container como unhealthy e (se restart=always
# + healthcheck integrado a um orquestrador) reinicia.
set -euo pipefail

MARKER="${HEALTH_MARKER:-/tmp/noc-agent.healthy}"
MAX_AGE="${HEALTH_MAX_AGE:-90}"   # segundos

if [ ! -f "$MARKER" ]; then
  echo "[healthcheck] marker $MARKER não existe (agente ainda não fez 1º tick)"
  exit 1
fi

NOW=$(date +%s)
MTIME=$(stat -c %Y "$MARKER" 2>/dev/null || stat -f %m "$MARKER")
AGE=$(( NOW - MTIME ))

if [ "$AGE" -gt "$MAX_AGE" ]; then
  echo "[healthcheck] FAIL: último tick há ${AGE}s (limite ${MAX_AGE}s)"
  exit 1
fi

echo "[healthcheck] OK (último tick há ${AGE}s)"
exit 0
