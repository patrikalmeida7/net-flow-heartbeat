# GenieACS para o NOC-ISP

Piloto: **uma instância ACS exclusiva por empresa** (Texas Fibra). Tags/filtros do GenieACS não isolam empresas.
A aprovação de equipamentos no NOC **não substitui** a autenticação na entrada do ACS.

## 1. Instalação fechada (terminal da VPS ou ICP)
O instalador precisa de terminal (SSH ou console do ICP): ele gera credenciais, grava `cwmp.auth` no MongoDB e testa tudo.
Só pela tela "Compose" do ICP não há como executar esses testes.
```
# copie a pasta deploy/genieacs para a VPS, ex. /opt/noc-genieacs (arquivos: setup.sh, docker-compose.yml, nginx-nbi.conf)
cd /opt/noc-genieacs
sudo bash setup.sh install
```
- Dependências: docker, compose v2, openssl, curl, ss, python3, base64. Verifica portas 7547/7558/3000 antes de criar arquivos.
- Instalação existente (containers/volumes `noc-genieacs`) não é tocada.
- Sobe tudo **só em 127.0.0.1** e testa: CWMP com um Inform TR-069 real (sem credencial → 401, inválida → 401,
  correta → 200 com `InformResponse`); NBI (sem senha → 401, errada → 401, correta → 200 com JSON). Timeout, 000, 403,
  500 ou resposta inesperada reprovam. O teste registra no ACS um equipamento fictício `NOC-SELFTEST` (pode ser apagado).
- Segredos ficam em `cwmp.credentials` e `nbi.credentials` (permissão 600). Nada é impresso: consulte com
  `sudo cat /opt/noc-genieacs/nbi.credentials`. Não rode com `bash -x`.
- Instalações anteriores sem `nbi.credentials`: crie o arquivo com `noc:SENHA` (chmod 600) antes de `verify`.

## 2. API NBI por HTTPS (nginx existente)
Use o nginx que já está na VPS (não suba outro serviço em 80/443). Exemplo de server block:
```
server {
  listen 443 ssl; server_name acs-api.texasfibra.com.br;
  # ssl_certificate ... (certificado existente/Let's Encrypt)
  location / { proxy_pass http://127.0.0.1:7558; proxy_set_header Host $host; }
}
```
Cadastre no NOC: `https://acs-api.texasfibra.com.br`, usuário `noc` e a senha de `nbi.credentials`.

## 3. Modem piloto e liberação do CWMP (acs.texasfibra.com.br)
CWMP continua fechado até `open-cwmp` passar. Para HTTPS no CWMP, o mesmo nginx pode encaminhar
`acs.texasfibra.com.br` → `127.0.0.1:7547` (então não é preciso publicar 7547).
1. Configure **um** modem piloto: ACS URL `https://acs.texasfibra.com.br` (ou `http://IP:7547` após open-cwmp),
   usuário/senha de `cwmp.credentials`, Periodic Inform 300–3600s.
2. Publicação direta da 7547 (opcional), que re-testa antes e depois e volta para 127.0.0.1 se falhar:
   `sudo CONFIRM_OPEN=yes bash setup.sh open-cwmp`
3. No NOC: Sincronizar, aprovar o piloto, criar perfil com **Equipamento piloto**; após testar, marcar **Validado**.

## Versões, atualização, backup
- Imagens fixadas: `mongo:6.0.16`, `drumsergio/genieacs:1.2.13`, `nginx:1.27.2-alpine`. Logs com rotação (10 MB × 5).
- Atualizar: faça backup, troque a tag no compose, `docker compose -p noc-genieacs up -d`, depois `setup.sh verify`.
- Backup / restauração:
```
docker compose -p noc-genieacs exec -T mongo mongodump --archive --gzip --db genieacs > genieacs-$(date +%F).gz
docker compose -p noc-genieacs exec -T mongo mongorestore --archive --gzip --drop < genieacs-AAAA-MM-DD.gz
```
Guarde `.env`, `nbi.htpasswd`, `nbi.credentials` e `cwmp.credentials` fora do servidor, com acesso restrito.

## Comportamento das tarefas
Solicitada → Pendente (próxima sessão) / Resultado desconhecido (timeout após envio: confira no ACS antes de repetir) →
Concluída (SSID lido do equipamento **depois** do comando) / Aplicada sem confirmação / Falhou.
Senha Wi-Fi é somente escrita: nunca aparece como confirmada. Tarefas aplicadas sem confirmação são reverificadas sem reenviar o comando: SSID com até 3 leituras espaçadas de 5 min; reinício só confirma com novo boot posterior. O GenieACS não garante execução única; o NOC evita reenvio
pelo mesmo identificador da solicitação e bloqueia nova tarefa do mesmo tipo enquanto outra estiver aberta.
Reset de fábrica e firmware não são oferecidos.
