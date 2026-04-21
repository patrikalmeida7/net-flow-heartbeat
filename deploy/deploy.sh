#!/usr/bin/env bash
# Script de deploy idempotente do frontend NOC.
# Pode ser chamado pelo webhook OU pelo cron — ambos seguros.
set -euo pipefail

APP_DIR="/home/deploy/app"
LOCK_FILE="/tmp/noc-deploy.lock"
LOG_PREFIX="[$(date -Iseconds)] [deploy]"

echo "$LOG_PREFIX iniciando"

# Lock pra evitar 2 deploys simultâneos
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$LOG_PREFIX outro deploy em andamento, abortando"
  exit 0
fi

cd "$APP_DIR"

# Pega hash atual
BEFORE=$(git rev-parse HEAD)

# Atualiza
git fetch --quiet origin
git reset --hard origin/main --quiet

AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  echo "$LOG_PREFIX nenhuma mudança ($AFTER), saindo"
  exit 0
fi

echo "$LOG_PREFIX atualizando $BEFORE → $AFTER"

# Instala dependências (só se package.json ou lock mudaram)
if git diff --name-only "$BEFORE" "$AFTER" | grep -qE '^(package\.json|package-lock\.json|bun\.lock(b)?)$'; then
  echo "$LOG_PREFIX dependências mudaram, rodando npm ci"
  npm ci --no-audit --no-fund --prefer-offline
else
  echo "$LOG_PREFIX dependências inalteradas, pulando install"
fi

# Build
echo "$LOG_PREFIX rodando build"
npm run build

# Reload nginx (não restart — sem downtime)
echo "$LOG_PREFIX reload nginx"
sudo /usr/bin/systemctl reload nginx

echo "$LOG_PREFIX OK ($AFTER)"
