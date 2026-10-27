# GenieACS para o NOC-ISP

Piloto: **uma instância ACS exclusiva por empresa** (Texas Fibra). Tags/filtros do GenieACS não isolam empresas.

## Instalação (revisar antes; nada é feito automaticamente pelo NOC)
1. Copie esta pasta para a VPS e rode `sudo bash setup.sh`.
   - Aborta se as portas 7547/7558/3000 estiverem em uso ou se o projeto `noc-genieacs` já existir.
   - Nunca sobrescreve `.env`/`nbi.htpasswd` e **não altera firewall** nem outros containers (noc-agent, Evolution…).
2. Anote usuário/senha NBI e cadastre em **Modems / ONTs → Adicionar**.
3. Crie um **perfil validado** para cada modelo/firmware antes de enviar comandos (sem perfil, tudo fica bloqueado).
4. Nos modems: ACS URL `http://IP_DA_VPS:7547`, usuário/senha CWMP (abaixo), Periodic Inform 300–3600s.
5. **Sincronizar**, aprovar cada equipamento e só então usar Wi-Fi/Reinício.

## Versões e dados
- Imagens fixadas: `mongo:6.0.16`, `drumsergio/genieacs:1.2.13`, `nginx:1.27.2-alpine`. Atualize só trocando a tag conscientemente.
- Volumes persistentes: `genieacs-mongo` (banco), `genieacs-ext`, `genieacs-logs`.

## Backup / restauração
```
docker compose -p noc-genieacs exec -T mongo mongodump --archive --gzip --db genieacs > genieacs-$(date +%F).gz
docker compose -p noc-genieacs exec -T mongo mongorestore --archive --gzip --drop < genieacs-AAAA-MM-DD.gz
```
Guarde também `.env` e `nbi.htpasswd` (fora do servidor, com acesso restrito).

## Segurança
- **NBI** (7557) nunca é exposta: só via nginx 7558 com Basic Auth. Restrinja 7558 no firewall e prefira HTTPS (proxy reverso com certificado, ex. Caddy/Certbot, apontando para 7558).
- **UI do GenieACS** (3000) fica só em 127.0.0.1; acesse por túnel SSH.
- **Autenticação dos modems (CPE→ACS)**: por padrão o GenieACS aceita qualquer CPE. Antes de apontar modems, defina na UI do GenieACS (Admin → Config) `cwmp.auth` exigindo usuário/senha, ex.: `AUTH("acs-texas", "SENHA_FORTE")`, e configure a mesma credencial nos modems (ou via OLT/provisionamento). Para CWMP em HTTPS, publique 7547 atrás de proxy TLS e use `https://` na ACS URL (verifique suporte do firmware).
- Mesmo autenticados, equipamentos novos entram **não aprovados** no NOC e não recebem comandos.

## Comportamento
- O modem inicia a conexão; a nuvem não precisa alcançar o IP privado dele.
- Sem Connection Request alcançável (NAT/CGNAT), a tarefa fica **pendente** até o próximo Inform.
- Estados: solicitada → pendente → concluída (confirmada por leitura) / aplicada sem confirmação / falhou. Senha Wi-Fi é somente escrita: nunca aparece como "confirmada".
- Reset de fábrica e firmware não são oferecidos.
