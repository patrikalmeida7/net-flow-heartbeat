#!/usr/bin/env bash
# Instala o GenieACS na VPS sem tocar em outros containers, arquivos ou regras de firewall.
# Uso: sudo bash setup.sh   (não execute sem revisar; aborta em qualquer conflito)
set -euo pipefail
cd "$(dirname "$0")"
command -v docker >/dev/null || { echo "Docker não encontrado"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose v2 não encontrado"; exit 1; }
PROJECT=noc-genieacs

# Já instalado? Não recria nem sobrescreve.
if docker compose -p "$PROJECT" ps -q 2>/dev/null | grep -q .; then
  echo "GenieACS ($PROJECT) já existe. Nada foi alterado. Para atualizar, revise o compose e rode: docker compose -p $PROJECT up -d"
  exit 0
fi

# Conflito de portas: aborta com orientação.
for p in 7547 7558 3000; do
  if ss -ltnH "( sport = :$p )" 2>/dev/null | grep -q .; then
    echo "ERRO: porta $p já está em uso por outro serviço:"; ss -ltnp "( sport = :$p )" || true
    echo "Libere a porta ou ajuste o mapeamento em docker-compose.yml antes de continuar. Nada foi alterado."
    exit 1
  fi
done

# Arquivos existentes nunca são sobrescritos.
umask 077
[ -f .env ] || echo "GENIEACS_UI_JWT_SECRET=$(openssl rand -hex 32)" > .env
if [ ! -f nbi.htpasswd ]; then
  NBI_USER=noc
  NBI_PASS=$(openssl rand -base64 24 | tr -d '/+=')
  printf '%s:%s\n' "$NBI_USER" "$(openssl passwd -apr1 "$NBI_PASS")" > nbi.htpasswd
  chmod 644 nbi.htpasswd
  echo "==== GUARDE (mostrado só agora; não fica salvo em texto) ===="
  echo "Usuário NBI: $NBI_USER"
  echo "Senha NBI:   $NBI_PASS"
  echo "============================================================="
fi

docker compose -p "$PROJECT" up -d
IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
echo
echo "No NOC-ISP → Modems / ONTs → Adicionar ACS:"
echo "  URL da API NBI: http://$IP:7558   (prefira HTTPS via proxy/domínio — ver README)"
echo "  URL CWMP (modems): http://$IP:7547"
echo "Firewall NÃO foi alterado. Libere manualmente TCP 7547 (modems) e 7558 (só para o NOC, se possível)."
echo "Configure a autenticação CPE→ACS (README, seção 'Autenticação dos modems') ANTES de apontar modems."
