#!/usr/bin/env bash
# GenieACS para o NOC-ISP. Não altera firewall, outros containers nem arquivos fora desta pasta.
#   sudo bash setup.sh install     -> instala FECHADO (só 127.0.0.1) e configura/testa autenticação CPE→ACS
#   sudo bash setup.sh verify      -> testa autenticação dos modems e da API NBI
#   sudo bash setup.sh open-cwmp   -> re-testa a autenticação e só então publica 7547 para os modems
# Segredos nunca vão para argumentos de processo, URLs ou logs: curl lê credenciais de arquivo -K protegido,
# openssl lê a senha por stdin e o mongosh recebe o script por stdin. Não use `bash -x` com este script.
set -euo pipefail
set +x
cd "$(dirname "$0")"
PROJECT=noc-genieacs
CMD="${1:-install}"
die() { echo "ERRO: $*" >&2; exit 1; }

TMPD=""
cleanup() { [ -n "$TMPD" ] && rm -rf "$TMPD"; return 0; }
trap cleanup EXIT INT TERM
umask 077
TMPD=$(mktemp -d)
chmod 700 "$TMPD"

need() { command -v "$1" >/dev/null 2>&1 || die "dependência ausente: $1. Instale e rode de novo. Nada foi alterado."; }
check_deps() {
  for c in docker openssl curl ss awk grep python3 base64 mktemp; do need "$c"; done
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

# Arquivo de configuração do curl (-K) com a credencial; permissões 600, apagado no trap.
curl_cfg() { # $1 = arquivo com "user:pass" ou vazio
  local f="$TMPD/curl.$RANDOM$RANDOM"
  : > "$f"; chmod 600 "$f"
  if [ -n "${1:-}" ]; then
    python3 - "$1" "$f" <<'PY'
import sys, json
cred = open(sys.argv[1]).read().strip()
open(sys.argv[2], "w").write("user = " + json.dumps(cred) + "\n")
PY
  fi
  echo "$f"
}

# Inform TR-069 (CWMP 1.0, SOAP 1.1) mínimo e válido. Sem credencial nenhum dado é aceito.
inform_body() {
  cat > "$TMPD/inform.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soap-enc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
<soap-env:Header><cwmp:ID soap-env:mustUnderstand="1">noc-selftest-1</cwmp:ID></soap-env:Header>
<soap-env:Body><cwmp:Inform>
<DeviceId><Manufacturer>NOC</Manufacturer><OUI>000000</OUI><ProductClass>SELFTEST</ProductClass><SerialNumber>NOC-SELFTEST</SerialNumber></DeviceId>
<Event soap-enc:arrayType="cwmp:EventStruct[1]"><EventStruct><EventCode>2 PERIODIC</EventCode><CommandKey></CommandKey></EventStruct></Event>
<MaxEnvelopes>1</MaxEnvelopes><CurrentTime>2026-01-01T00:00:00Z</CurrentTime><RetryCount>0</RetryCount>
<ParameterList soap-enc:arrayType="cwmp:ParameterValueStruct[1]"><ParameterValueStruct><Name>InternetGatewayDevice.DeviceInfo.SoftwareVersion</Name><Value xsi:type="xsd:string">0</Value></ParameterValueStruct></ParameterList>
</cwmp:Inform></soap-env:Body></soap-env:Envelope>
XML
  echo "$TMPD/inform.xml"
}

# Imprime o código HTTP; "000" em falha de transporte/timeout. Corpo em $TMPD/body.
cwmp_req() { # $1 = arquivo de credencial ou vazio
  local cfg code; cfg=$(curl_cfg "${1:-}"); : > "$TMPD/body"
  code=$(curl -s -K "$cfg" -o "$TMPD/body" -w '%{http_code}' -m 10 -X POST \
    -H 'Content-Type: text/xml; charset="utf-8"' -H 'SOAPAction: ""' --data-binary "@$(inform_body)" http://127.0.0.1:7547/) || code=000
  echo "${code:-000}"
}
nbi_req() { # $1 = arquivo de credencial ou vazio
  local cfg code; cfg=$(curl_cfg "${1:-}"); : > "$TMPD/body"
  code=$(curl -s -K "$cfg" -o "$TMPD/body" -w '%{http_code}' -m 10 'http://127.0.0.1:7558/devices?projection=_id&limit=1') || code=000
  echo "${code:-000}"
}
is_json_array() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])); sys.exit(0 if isinstance(v,list) else 1)' "$TMPD/body" 2>/dev/null; }

verify_auth() {
  [ -f cwmp.credentials ] || die "cwmp.credentials ausente: rode install primeiro."
  [ -f nbi.credentials ] || die "nbi.credentials ausente: rode install primeiro."
  printf 'noc-invalido:errado-%s' "$RANDOM" > "$TMPD/bad.cred"
  local c
  c=$(cwmp_req); [ "$c" = 401 ] || die "CWMP sem credencial respondeu $c (esperado 401). Não libere 7547."
  c=$(cwmp_req "$TMPD/bad.cred"); [ "$c" = 401 ] || die "CWMP com credencial INVÁLIDA respondeu $c (esperado 401). Não libere 7547."
  c=$(cwmp_req cwmp.credentials)
  [ "$c" = 200 ] || die "CWMP com credencial correta respondeu $c (esperado 200 com InformResponse). Revise cwmp.auth."
  grep -q 'InformResponse' "$TMPD/body" || die "CWMP aceitou a credencial, mas não devolveu InformResponse. Não libere 7547."
  c=$(nbi_req); [ "$c" = 401 ] || die "API NBI sem senha respondeu $c (esperado 401)."
  c=$(nbi_req "$TMPD/bad.cred"); [ "$c" = 401 ] || die "API NBI com senha errada respondeu $c (esperado 401)."
  c=$(nbi_req nbi.credentials); [ "$c" = 200 ] || die "API NBI com senha correta respondeu $c (esperado 200)."
  is_json_array || die "API NBI autenticada não devolveu JSON válido (lista)."
  echo "Autenticação CPE→ACS e NBI verificadas."
}

case "$CMD" in
  install)
    check_deps
    if existing; then echo "Instalação existente de $PROJECT (containers ou volumes, inclusive parados). Nada foi alterado. Use verify ou consulte o README para atualizar."; exit 0; fi
    check_ports
    [ -f .env ] || printf 'GENIEACS_UI_JWT_SECRET=%s\nCWMP_BIND=127.0.0.1\n' "$(openssl rand -hex 32)" > .env
    grep -q '^CWMP_BIND=' .env || echo 'CWMP_BIND=127.0.0.1' >> .env
    if [ ! -f nbi.credentials ]; then
      printf 'noc:%s' "$(openssl rand -base64 24 | tr -d '/+=\n')" > nbi.credentials; chmod 600 nbi.credentials
    fi
    if [ ! -f nbi.htpasswd ]; then
      HASH=$(cut -d: -f2- nbi.credentials | openssl passwd -apr1 -stdin)
      printf 'noc:%s\n' "$HASH" > nbi.htpasswd; chmod 644 nbi.htpasswd; unset HASH
    fi
    if [ ! -f cwmp.credentials ]; then
      printf 'cpe-%s:%s' "$(openssl rand -hex 3)" "$(openssl rand -base64 18 | tr -d '/+=\n')" > cwmp.credentials
    fi
    chmod 600 cwmp.credentials nbi.credentials
    docker compose -p "$PROJECT" up -d
    wait_healthy
    # Script do mongosh enviado por stdin; usuário/senha em base64 (sem interpolação de JS com o segredo bruto).
    U64=$(cut -d: -f1 cwmp.credentials | tr -d '\n' | base64 | tr -d '\n')
    P64=$(cut -d: -f2- cwmp.credentials | tr -d '\n' | base64 | tr -d '\n')
    cat > "$TMPD/auth.js" <<JS
const d = (s) => Buffer.from(s, "base64").toString("utf8");
const v = "AUTH(" + JSON.stringify(d("$U64")) + ", " + JSON.stringify(d("$P64")) + ")";
db.getSiblingDB("genieacs").config.updateOne({ _id: "cwmp.auth" }, { \$set: { value: v } }, { upsert: true });
JS
    unset U64 P64
    docker compose -p "$PROJECT" exec -T mongo mongosh --quiet --norc < "$TMPD/auth.js" >/dev/null
    rm -f "$TMPD/auth.js"
    sleep 5
    verify_auth
    echo
    echo "Instalado FECHADO: 7547/7558 só em 127.0.0.1."
    echo "Credenciais em arquivos protegidos (consulte localmente): sudo cat $(pwd)/nbi.credentials  e  sudo cat $(pwd)/cwmp.credentials"
    echo "Próximos passos (README): HTTPS para a NBI e, após configurar 1 modem piloto, 'setup.sh open-cwmp'."
    ;;
  verify) check_deps; wait_healthy; verify_auth ;;
  open-cwmp)
    check_deps; wait_healthy; verify_auth
    [ "${CONFIRM_OPEN:-}" = yes ] || die "defina CONFIRM_OPEN=yes para publicar 7547 (firewall continua sob sua responsabilidade)."
    sed -i 's/^CWMP_BIND=.*/CWMP_BIND=0.0.0.0/' .env
    docker compose -p "$PROJECT" up -d genieacs
    if ! ( wait_healthy && verify_auth ); then
      sed -i 's/^CWMP_BIND=.*/CWMP_BIND=127.0.0.1/' .env
      docker compose -p "$PROJECT" up -d genieacs || true
      die "verificação falhou após publicar; CWMP voltou para 127.0.0.1."
    fi
    echo "CWMP 7547 publicado. Libere no firewall apenas se necessário. Para fechar: CWMP_BIND=127.0.0.1 no .env e 'docker compose -p $PROJECT up -d genieacs'."
    ;;
  *) die "uso: setup.sh [install|verify|open-cwmp]" ;;
esac
