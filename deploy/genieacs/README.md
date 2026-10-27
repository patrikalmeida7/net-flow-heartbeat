# GenieACS para o NOC-ISP

Piloto: **uma instância ACS exclusiva por empresa** (Texas Fibra). Tags/filtros do GenieACS não isolam empresas.
A aprovação de equipamentos no NOC **não substitui** a autenticação na entrada do ACS.

## 1. Instalação fechada
```
sudo bash setup.sh install
```
- Verifica dependências (docker, compose v2, openssl, curl, ss) e conflitos de porta 7547/7558/3000 **antes** de criar qualquer arquivo; aborta se não conseguir verificar.
- Detecta instalação existente (containers, inclusive parados, ou volumes do projeto `noc-genieacs`) e sai sem alterar nada.
- Nunca sobrescreve `.env`, `nbi.htpasswd`, `cwmp.credentials`. Não altera firewall nem outros serviços.
- Sobe tudo **só em 127.0.0.1**, aguarda healthchecks, grava `cwmp.auth` exigindo usuário/senha e testa:
  sem credencial → 401, credencial inválida → 401, credencial correta → aceita, NBI sem senha → 401.
  Só então informa sucesso.
- MongoDB e a NBI original (7557) nunca são publicados. UI (3000) só local (túnel SSH).

## 2. API NBI por HTTPS
O NOC recusa NBI em HTTP. Publique o proxy local `127.0.0.1:7558` atrás de HTTPS, ex. Caddy:
```
acs-api.suaempresa.com.br {
  reverse_proxy 127.0.0.1:7558
}
```
Restrinja o acesso no firewall quando possível. Cadastre no NOC: `https://acs-api.suaempresa.com.br`, usuário `noc` e a senha mostrada na instalação.
Exceção de laboratório (HTTP) existe por servidor, desligada por padrão, e aparece marcada na tela.

## 3. Modem piloto e liberação do CWMP
1. Configure **um** modem piloto: ACS URL `http://IP:7547` (ou `https://` atrás de proxy TLS, se o firmware suportar), usuário/senha de `cwmp.credentials`, Periodic Inform 300–3600s.
2. Liberação explícita, que re-testa a autenticação antes de publicar:
   ```
   sudo CONFIRM_OPEN=yes bash setup.sh open-cwmp
   ```
   Firewall continua sob sua responsabilidade. Para fechar: `CWMP_BIND=127.0.0.1` no `.env` e `docker compose -p noc-genieacs up -d genieacs`.
3. No NOC: Sincronizar, aprovar o piloto, criar perfil com **Equipamento piloto** = ID do piloto (não validado). Isso libera comandos só para ele.
4. Após testar no piloto, marque o perfil como **Validado** para liberar os demais equipamentos aprovados do mesmo modelo/firmware.

## Versões, atualização, backup
- Imagens fixadas: `mongo:6.0.16`, `drumsergio/genieacs:1.2.13`, `nginx:1.27.2-alpine`. Logs com rotação (10 MB × 5).
- Atualizar: faça backup, troque a tag no compose, `docker compose -p noc-genieacs up -d`, depois `setup.sh verify`.
- Backup / restauração:
```
docker compose -p noc-genieacs exec -T mongo mongodump --archive --gzip --db genieacs > genieacs-$(date +%F).gz
docker compose -p noc-genieacs exec -T mongo mongorestore --archive --gzip --drop < genieacs-AAAA-MM-DD.gz
```
Guarde `.env`, `nbi.htpasswd` e `cwmp.credentials` fora do servidor, com acesso restrito.

## Comportamento das tarefas
Solicitada → Pendente (próxima sessão) / Resultado desconhecido (timeout após envio: confira no ACS antes de repetir) →
Concluída (SSID lido do equipamento **depois** do comando) / Aplicada sem confirmação / Falhou.
Senha Wi-Fi é somente escrita: nunca aparece como confirmada. O GenieACS não garante execução única; o NOC evita reenvio
pelo mesmo identificador da solicitação e bloqueia nova tarefa do mesmo tipo enquanto outra estiver aberta.
Reset de fábrica e firmware não são oferecidos.
