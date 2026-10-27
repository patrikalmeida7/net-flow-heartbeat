# GenieACS para o NOC-ISP

1. Copie esta pasta para a VPS e rode `sudo bash setup.sh`. Não afeta noc-agent, Evolution ou outros containers.
2. Anote usuário/senha NBI exibidos e cadastre em **Modems / ONTs → Adicionar**.
3. Nos modems/ONTs (ou via provisionamento da OLT/PPPoE), configure:
   - ACS URL: `http://IP_DA_VPS:7547`
   - Periodic Inform: habilitado, intervalo 300–3600s
4. Clique **Sincronizar** no NOC-ISP, autorize os equipamentos e use **Wi-Fi** para alterar nome/senha.

Notas:
- O modem inicia a conexão; a nuvem não precisa alcançar o IP privado dele.
- Se o Connection Request não for alcançável (NAT/CGNAT), o comando fica **pendente** e aplica no próximo Inform.
- A API NBI não tem autenticação nativa; por isso fica atrás do nginx (7558) com Basic Auth. Restrinja 7558 no firewall quando possível e prefira HTTPS com proxy reverso/domínio.
