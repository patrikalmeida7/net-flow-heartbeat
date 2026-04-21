# =============================================================
# NOC Agent — imagem de produção
# Multi-stage: builder instala deps, runtime só carrega o necessário
# =============================================================
FROM node:20-alpine AS builder
WORKDIR /build

# Só copia manifests primeiro pra cachear deps
COPY package.json ./
# Instala somente prod deps (sem devDependencies, sem audit)
RUN npm install --omit=dev --no-audit --no-fund

# -------------------------------------------------------------
FROM node:20-alpine AS runtime

# Pacotes nativos pra VPN + diagnóstico
# - wireguard-tools: wg / wg-quick (usado por src/vpn.js)
# - openvpn:        openvpn client (usado por src/vpn.js)
# - iputils:        ping (latência VPN)
# - bash, curl, jq: scripts de healthcheck
# - tini:           init PID 1 (graceful shutdown e zumbis)
RUN apk add --no-cache \
      wireguard-tools \
      openvpn \
      iputils \
      bash \
      curl \
      jq \
      tini \
 && rm -rf /var/cache/apk/*

WORKDIR /app

# Copia node_modules do builder e o código-fonte
COPY --from=builder /build/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY config.example.json ./config.example.json
COPY scripts ./scripts

# OBS: rodamos como root porque src/vpn.js precisa
# manipular interfaces de rede (wg-quick / openvpn).
# A mitigação é o container ter --cap-add=NET_ADMIN
# em vez de --privileged (definido no docker-compose).

ENV NODE_ENV=production \
    AGENT_CONFIG=/app/config/config.json

# Healthcheck: o próprio script verifica se o loop de heartbeat
# está vivo (arquivo /tmp/noc-agent.healthy atualizado < 90s)
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD bash /app/scripts/healthcheck.sh || exit 1

# tini garante que SIGTERM chega no Node e o loop encerra limpo
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
