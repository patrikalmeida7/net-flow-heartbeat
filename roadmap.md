# Roadmap — NOC-ISP
- [x] Implementar persistência SNMP em lote/idempotente, timeout de envio e contrato dos contadores (revisão externa pelo proprietário)
- [x] Aplicar política SNMP principal e fotografias API agendadas, preservando histórico
- [x] Dashboard real, saúde da coleta por equipamento, último estado conhecido
- [x] Métricas: Sem dados / erro / retry, frescor
- [x] PPPoE / Histórico / Cliente: paginação no servidor, cliente = concentrador+login
- [x] WhatsApp: por destinatário, retry limitado, trava, tolerância offline contínua
- [x] Quedas individuais x em massa coerentes em dashboard, análise e relatórios
- [x] Acesso restrito: Google ou e-mail/senha só para contas autorizadas pelo admin
- [ ] Atualizar o container do coletor na VPS (bloqueado: ação do proprietário)
- [ ] Confirmação de entrega no aparelho (bloqueado: exige webhook da Evolution API)
- [ ] Quedas falsas antigas: sem critério inequívoco, mantidas (aguarda decisão)

- [ ] Dashboards: OID personalizado pelo admin (exige teste controlado no agente) — etapa posterior
- [ ] Dashboards: contagem de clientes via SNMP só após OID validado

- [x] Analisar desempenho do banco (CPU/memória/disco) e sugerir otimizações antes de redimensionar

- [x] Segurança: revogar leitura das colunas secretas e execução de purge; VPN somente admin; ingestão por agente/empresa; run exige segredo de cron
- [ ] Segurança: aplicar AES-GCM e re-cifrar credenciais atuais (bloqueado: ferramenta recusou acesso a secrets)
- [ ] Segurança: configurar segredo no cron existente (mesmo bloqueio; execução automática agora recusa chamada sem segredo)
- [ ] Compatibilidade: consultas atuais com select("*") em VPN/Relatórios precisam de seleção explícita após revogação (bloqueado: pedido proíbe alterar páginas)
