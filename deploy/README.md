# Deploy do Frontend + Agente na Vultr

Guia completo para hospedar o frontend (React/Vite) e o agente coletor (Node.js) numa VPS Vultr Ubuntu 22.04, com **deploy automático** via GitHub Actions toda vez que a IA da Lovable alterar o código.

## 🏗️ Arquitetura

```
┌─────────────────────┐     git push      ┌──────────────┐     webhook (HTTPS)    ┌───────────────┐
│   Lovable (IA)      │ ────────────────▶ │   GitHub     │ ─────────────────────▶ │   VPS Vultr   │
│   edita código      │   (auto sync)     │   (repo)     │   GitHub Actions       │               │
└─────────────────────┘                   └──────────────┘                        │  - Nginx      │
                                                                                  │  - Frontend   │
                                                                                  │  - Webhook    │
                                                                                  │  - Agente     │
                                                                                  └───────┬───────┘
                                                                                          │
                                                                                          ▼
                                                                                  Lovable Cloud
                                                                                  (backend, DB,
                                                                                   edge functions)
```

**Importante**: o backend (banco, auth, edge functions) **continua no Lovable Cloud**. A VPS só hospeda:
1. **Frontend** (HTML/JS/CSS estático servido por Nginx)
2. **Agente coletor** (já documentado em `agent/README.md`)
3. **Webhook receiver** (recebe ping do GitHub e dispara deploy)

---

## 📋 Pré-requisitos

- Conta na [Vultr](https://www.vultr.com/) (use **Cloud Compute → Regular Performance → 1GB RAM, $6/mês** ou superior)
- Repositório GitHub conectado ao Lovable (**Connectors → GitHub** dentro do editor Lovable)
- SSH key local (`~/.ssh/id_ed25519.pub`)

---

## 1️⃣ Criar a VPS Vultr

1. Acesse https://my.vultr.com/deploy/
2. **Choose Server**: Cloud Compute → Regular Performance
3. **Server Location**: Miami, São Paulo ou mais próximo dos seus MikroTiks
4. **Server Image**: Ubuntu 22.04 LTS x64
5. **Server Size**: 1 GB RAM / 1 vCPU / 25 GB SSD ($6/mês) — suficiente
6. **SSH Keys**: cole sua public key (`cat ~/.ssh/id_ed25519.pub`)
7. **Hostname**: `noc-frontend-01`
8. **Deploy Now** → anote o IP público (ex: `45.32.xxx.xxx`)

---

## 2️⃣ Setup inicial da VPS

Da sua máquina local:

```bash
ssh root@45.32.xxx.xxx
```

Depois, na VPS:

```bash
# Atualizar
apt update && apt upgrade -y

# Instalar dependências
apt install -y curl git nginx ufw
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version  # deve mostrar v20.x

# Firewall
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Criar usuário deploy
useradd -m -s /bin/bash deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh

# Permitir deploy reiniciar nginx sem senha (apenas reload)
echo "deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload nginx, /usr/bin/systemctl restart noc-webhook" > /etc/sudoers.d/deploy
chmod 440 /etc/sudoers.d/deploy
```

---

## 3️⃣ Clonar o repositório

Conecte primeiro o Lovable ao GitHub: **Lovable → Connectors → GitHub → Connect**. Isso cria automaticamente o repo.

Na VPS (como `deploy`):

```bash
su - deploy
cd ~
git clone https://github.com/SEU_USUARIO/SEU_REPO.git app
cd app
npm install
npm run build
```

O build gera o diretório `dist/` com os arquivos estáticos.

---

## 4️⃣ Configurar Nginx

Como root:

```bash
cp /home/deploy/app/deploy/nginx.conf /etc/nginx/sites-available/noc
ln -sf /etc/nginx/sites-available/noc /etc/nginx/sites-enabled/noc
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

Edite `/etc/nginx/sites-available/noc` e troque `server_name _;` pelo IP ou domínio.

Acesse `http://45.32.xxx.xxx` — deve aparecer o frontend.

---

## 5️⃣ Configurar webhook receiver

O webhook recebe o ping do GitHub Actions e executa `deploy.sh`.

```bash
# Como deploy
cd ~/app/deploy
cp webhook-server.example.env .env
# Edite .env e defina WEBHOOK_SECRET (gere com: openssl rand -hex 32)
nano .env
```

Instale o serviço como root:

```bash
cp /home/deploy/app/deploy/noc-webhook.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now noc-webhook
systemctl status noc-webhook
```

O webhook escuta em `127.0.0.1:9000`. O Nginx já está configurado pra expor em `https://SEU_IP/__deploy` (veja `nginx.conf`).

---

## 6️⃣ Configurar GitHub Actions

No repositório GitHub: **Settings → Secrets and variables → Actions → New repository secret**:

| Nome | Valor |
|---|---|
| `VPS_DEPLOY_URL` | `http://45.32.xxx.xxx/__deploy` (ou `https://...` se tiver domínio) |
| `VPS_DEPLOY_SECRET` | o mesmo valor de `WEBHOOK_SECRET` do `.env` |

O workflow `.github/workflows/deploy.yml` já está pronto: a cada push na branch `main`, ele faz POST no webhook → VPS faz `git pull` + `npm install` + `npm run build` + `nginx reload`.

---

## 7️⃣ Fallback: cron a cada 5 minutos

Caso o webhook falhe, o cron garante deploy:

```bash
# Como deploy
crontab -e
# Adicione:
*/5 * * * * /home/deploy/app/deploy/deploy.sh >> /home/deploy/deploy.log 2>&1
```

O `deploy.sh` é idempotente: se não houver mudanças no `git pull`, ele sai cedo sem rebuildar.

---

## 8️⃣ HTTPS com Let's Encrypt (depois do domínio)

Quando tiver domínio apontado pro IP:

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d seudominio.com.br
# Renovação é automática via systemd timer
```

---

## 🔄 Como funciona o ciclo automático

1. Você pede mudança no chat da Lovable
2. Lovable edita os arquivos no projeto
3. Sync automático envia commit pro GitHub (via Connectors → GitHub)
4. GitHub Actions dispara em 5-10s
5. Workflow faz POST no `/__deploy` da VPS com o `WEBHOOK_SECRET`
6. VPS valida o secret → roda `deploy.sh`
7. `deploy.sh`: `git pull` + `npm ci` + `npm run build` + `nginx reload`
8. Frontend atualizado em ~30-60s desde o chat

---

## 🛠️ Comandos úteis

```bash
# Deploy manual
sudo -u deploy /home/deploy/app/deploy/deploy.sh

# Logs do webhook
journalctl -u noc-webhook -f

# Logs de deploy
tail -f /home/deploy/deploy.log

# Logs do Nginx
tail -f /var/log/nginx/access.log /var/log/nginx/error.log

# Testar webhook localmente (na VPS)
curl -X POST http://127.0.0.1:9000/deploy \
  -H "X-Deploy-Secret: $(grep WEBHOOK_SECRET /home/deploy/app/deploy/.env | cut -d= -f2)"
```

---

## 🔐 Segurança

- Webhook protegido por **token compartilhado** (`X-Deploy-Secret`)
- Webhook escuta apenas em `127.0.0.1` — não exposto direto
- Nginx faz proxy reverso e adiciona rate limiting (10 req/min no `/__deploy`)
- `deploy` user só tem permissão de reload no nginx (não restart)
- `deploy.sh` usa `set -euo pipefail` — qualquer erro aborta sem deixar build pela metade

---

## ❓ Troubleshooting

**Frontend não atualiza:**
```bash
sudo -u deploy /home/deploy/app/deploy/deploy.sh
# Olhe a saída — se git pull falhar, é problema de chave SSH
```

**Webhook retorna 401:**
- Confira que `VPS_DEPLOY_SECRET` no GitHub é igual ao `WEBHOOK_SECRET` do `.env` na VPS

**`npm run build` falha por falta de memória (1GB RAM):**
- Adicione swap: `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo "/swapfile none swap sw 0 0" >> /etc/fstab`

**Mudança no `.env` do projeto não reflete:**
- Variáveis `VITE_*` são embarcadas no build. O `deploy.sh` já roda `npm run build` toda vez, então qualquer push reflete.
