#!/usr/bin/env bash
# GenieACS para o NOC-ISP. Não altera firewall, outros containers nem arquivos fora desta pasta.
#   sudo bash setup.sh install     -> instala FECHADO (só 127.0.0.1) e configura/testa autenticação CPE→ACS
#   sudo bash setup.sh verify      -> testa autenticação dos modems e saúde dos serviços
#   sudo bash setup.sh open-cwmp   -> re-testa a autenticação e só então publica 7547 para os modems
set -euo pipefail
cd "$(dirname "$0")"
PROJECT=noc-genieacs
CMD="${1:-install}"
die() { echo "ERRO: $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "dependência ausente: $1. Instale e rode de novo. Nada foi alterado."; }
check_deps() {
  for c in docker openssl curl ss awk grep; do need "$c"; done
  docker compose version >/dev/null 2>&1 || die "docker compose v2 não encontrado. Nada foi alterado."
  docker info >/dev/null 2>&1 || die "não foi possível falar com o Docker (permissão/daemon). Nada foi alterado."
}

existing() {
  docker ps -a --filter "label=com.docker.compose.project=$PROJECT" -q | grep -q . && return 0
  docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | grep -q . && return 0
  return 1
}

check_ports() {
  local out
  for p in 7547 7558 3000; do
    out=$(ss -ltnH "( sport = :$p )" 2>&1) || die "não foi possível verificar a porta $p (ss falhou). Nada foi alterado."
    [ -z "$out" ] || die "porta $p já está em uso: $out. Libere-a ou ajuste docker-compose.yml. Nada foi alterado."
  done
}

wait_healthy() {
  local svc st i
  for svc in mongo genieacs nbi-proxy; do
    for i in $(seq 1 60); do
      st=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose -p "$PROJECT" ps -q "$svc")" 2>/dev/null || echo none)
      [ "$st" = healthy ] && break
      [ "$i" = 60 ] && die "serviço $svc não ficou saudável (status: $st). Veja: docker compose -p $PROJECT logs $svc"
      sleep 3
    done
  done
}

cwmp_code() { # $1 = "user:pass" ou vazio
  local a=(); [ -n "${1:-}" ] && a=(-u "$1")
  curl -s -o /dev/null -w '%{http_code}' -m 10 "${a[@]}" -X POST -H 'Content-Type: text/xml' --data '' http://127.0.0.1:7547/ || echo 000
}

verify_auth() {
  [ -f cwmp.credentials ] || die "cwmp.credentials ausente: rode install primeiro."
  local cred; cred=$(cat cwmp.credentials)
  [ "$(cwmp_code)" = 401 ] || die "ACS aceitou modem SEM autenticação. Não libere 7547."
  [ "$(cwmp_code "noc-invalido:errado")" = 401 ] || die "ACS aceitou credencial INVÁLIDA. Não libere 7547."
  [ "$(cwmp_code "$cred")" != 401 ] || die "credencial correta foi recusada: revise cwmp.auth."
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:7558/devices)" = 401 ] || die "API NBI respondeu sem senha."
  echo "Autenticação CPE→ACS e NBI verificadas."
}

case "$CMD" in
  install)
    check_deps
    if existing; then echo "Instalação existente de $PROJECT (containers ou volumes, inclusive parados). Nada foi alterado. Use verify ou consulte o README para atualizar."; exit 0; fi
    check_ports
    umask 077
    [ -f .env ] || printf 'GENIEACS_UI_JWT_SECRET=%s\nCWMP_BIND=127.0.0.1\n' "$(openssl rand -hex 32)" > .env
    grep -q '^CWMP_BIND=' .env || echo 'CWMP_BIND=127.0.0.1' >> .env
    if [ ! -f nbi.htpasswd ]; then
      NBI_PASS=$(openssl rand -base64 24 | tr -d '/+=')
      printf 'noc:%s\n' "$(openssl passwd -apr1 "$NBI_PASS")" > nbi.htpasswd; chmod 644 nbi.htpasswd
      echo "== Senha da API NBI (mostrada só agora): usuário noc / senha $NBI_PASS =="
    fi
    if [ ! -f cwmp.credentials ]; then
      printf 'cpe-%s:%s' "$(openssl rand -hex 3)" "$(openssl rand -base64 18 | tr -d '/+=')" > cwmp.credentials
    fi
    docker compose -p "$PROJECT" up -d
    wait_healthy
    U=${CRED_USER:-$(cut -d: -f1 cwmp.credentials)}; P=$(cut -d: -f2- cwmp.credentials)
    docker compose -p "$PROJECT" exec -T mongo mongosh --quiet genieacs --eval \
      "db.config.updateOne({_id:'cwmp.auth'},{\$set:{value:'AUTH(\"$U\", \"$P\")'}},{upsert:true})" >/dev/null
    sleep 5
    verify_auth
    echo
    echo "Instalado FECHADO: 7547/7558 só em 127.0.0.1. Credencial dos modems em ./cwmp.credentials (protegido)."
    echo "Próximos passos (README): HTTPS para a NBI e, após configurar 1 modem piloto, 'setup.sh open-cwmp'."
    ;;
  verify) check_deps; wait_healthy; verify_auth ;;
  open-cwmp)
    check_deps; wait_healthy; verify_auth
    [ "${CONFIRM_OPEN:-}" = yes ] || die "defina CONFIRM_OPEN=yes para publicar 7547 (firewall continua sob sua responsabilidade)."
    sed -i 's/^CWMP_BIND=.*/CWMP_BIND=0.0.0.0/' .env
    docker compose -p "$PROJECT" up -d genieacs
    wait_healthy; verify_auth
    echo "CWMP 7547 publicado. Libere no firewall apenas se necessário. Para fechar: CWMP_BIND=127.0.0.1 no .env e 'docker compose -p $PROJECT up -d genieacs'."
    ;;
  *) die "uso: setup.sh [install|verify|open-cwmp]" ;;
esac
