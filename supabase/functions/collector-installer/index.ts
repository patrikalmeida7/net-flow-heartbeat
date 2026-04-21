// Edge function pública que serve os scripts de instalação do NOC Collector.
// Não depende de GitHub — o conteúdo é embutido no próprio bundle.
//
// Endpoints:
//   GET /            → script bootstrap (baixa o setup completo desta mesma função)
//   GET /setup       → script de setup completo
//   GET /install.sh  → alias do bootstrap (compatibilidade)
//
// Sem CORS / sem JWT — é chamado por curl direto na VPS.

import setupScript from "./setup.sh.ts";

const PUBLIC_BASE_URL =
  Deno.env.get("PUBLIC_INSTALLER_BASE_URL") ??
  "https://rzubqfexhptentnkjcaq.supabase.co/functions/v1/collector-installer";

const SETUP_URL = PUBLIC_BASE_URL + "?setup=1";

const BOOTSTRAP = `#!/usr/bin/env bash
# ============================================================================
# NOC Collector VPS — Bootstrap
# ============================================================================
# Uso:
#   curl -fsSL ${PUBLIC_BASE_URL} | sudo bash
# ============================================================================
set -euo pipefail

RED='\\033[0;31m'; GREEN='\\033[0;32m'; BLUE='\\033[0;34m'; NC='\\033[0m'
log() { echo -e "\${BLUE}[\$(date +%H:%M:%S)]\${NC} \$*"; }
ok()  { echo -e "\${GREEN}✓\${NC} \$*"; }
err() { echo -e "\${RED}✗\${NC} \$*" >&2; }

[ "\$(id -u)" -eq 0 ] || { err "Rode como root: curl ... | sudo bash"; exit 1; }

SETUP_URL="${SETUP_URL}"
TMP_SETUP="\$(mktemp /tmp/noc-vultr-setup.XXXXXX.sh)"
trap 'rm -f "\$TMP_SETUP"' EXIT

log "Baixando setup completo do NOC Collector..."
echo "  URL: \$SETUP_URL"

if ! curl -fsSL "\$SETUP_URL" -o "\$TMP_SETUP"; then
  err "Falha ao baixar o setup do NOC Collector."
  exit 1
fi

if ! head -1 "\$TMP_SETUP" | grep -qx '#!/usr/bin/env bash'; then
  err "Arquivo baixado não é um script bash válido."
  err "Primeira linha: \$(head -1 "\$TMP_SETUP" || true)"
  exit 1
fi

chmod +x "\$TMP_SETUP"
ok "Setup baixado"
log "Executando setup do NOC Collector..."
exec bash "\$TMP_SETUP"
`;

function scriptResponse(body: string) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

Deno.serve((req) => {
  const url = new URL(req.url);

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // ?setup=1 → script completo
  if (url.searchParams.get("setup") === "1") {
    return scriptResponse(setupScript);
  }

  // /setup ou /collector-installer/setup → script completo
  if (url.pathname.endsWith("/setup")) {
    return scriptResponse(setupScript);
  }

  // default → bootstrap
  return scriptResponse(BOOTSTRAP);
});
