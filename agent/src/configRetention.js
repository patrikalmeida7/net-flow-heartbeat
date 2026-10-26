// Retenção em memória (nunca em disco) dos alvos SNMP vindos do painel.
// - resposta válida (inclusive lista vazia) substitui os alvos
// - erro temporário mantém os últimos alvos até `ttlMs`; depois expira
// - 401/403 invalida imediatamente (agente revogado)
export function createTargetStore(ttlMs = 10 * 60_000, now = () => Date.now()) {
  let targets = [];
  let validAt = null;
  let revoked = false;
  return {
    applySuccess(list) { targets = Array.isArray(list) ? list : []; validAt = now(); revoked = false; },
    applyFailure(status) {
      if (status === 401 || status === 403) { targets = []; validAt = null; revoked = true; return "revoked"; }
      if (validAt == null) return "none";
      if (now() - validAt > ttlMs) { targets = []; validAt = null; return "expired"; }
      return "retained";
    },
    current() {
      if (validAt != null && now() - validAt > ttlMs) { targets = []; validAt = null; }
      return targets;
    },
    get revoked() { return revoked; },
  };
}
