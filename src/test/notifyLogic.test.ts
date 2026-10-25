import { describe, it, expect } from "vitest";
import {
  pendingPhones, allAccepted, exhausted, applyResults, offlineBeyondTolerance, episodeKey, type DeliveryRow,
} from "../../supabase/functions/notify-whatsapp/logic";

const phones = ["5511999990001", "5511999990002"];

describe("entregas WhatsApp por destinatário", () => {
  it("falha parcial: só reenvia o destinatário que falhou", () => {
    const rows = applyResults([], [
      { phone: phones[0], ok: true },
      { phone: phones[1], ok: false, error: "HTTP 500" },
    ]);
    expect(pendingPhones(phones, rows)).toEqual([phones[1]]);
    expect(allAccepted(phones, rows)).toBe(false);
  });

  it("não duplica quem já teve sucesso após várias execuções", () => {
    let rows: DeliveryRow[] = [];
    for (let i = 0; i < 5; i++) {
      const pend = pendingPhones(phones, rows);
      rows = applyResults(rows, pend.map((p) => ({ phone: p, ok: p === phones[0] })));
    }
    expect(rows.find((r) => r.phone === phones[0])!.attempts).toBe(1);
  });

  it("limita tentativas a 3 e marca como esgotado", () => {
    let rows: DeliveryRow[] = [];
    for (let i = 0; i < 6; i++) rows = applyResults(rows, pendingPhones([phones[1]], rows).map((p) => ({ phone: p, ok: false })));
    expect(rows[0].attempts).toBe(3);
    expect(exhausted([phones[1]], rows)).toBe(true);
  });

  it("relatório só concluído quando todos aceitos", () => {
    const rows = applyResults([], phones.map((p) => ({ phone: p, ok: true })));
    expect(allAccepted(phones, rows)).toBe(true);
  });

  it("formatos diferentes do mesmo número contam como um destinatário", () => {
    expect(pendingPhones(["+55 (11) 99999-0001", "5511999990001"], [])).toEqual(["5511999990001"]);
  });
});

describe("tolerância de concentrador offline", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  it("conta do início contínuo, não da última tentativa", () => {
    const c = { status: "offline", offline_since: new Date(now - 6 * 60000).toISOString() };
    expect(offlineBeyondTolerance(c, 5, now)).toBe(true);
    expect(offlineBeyondTolerance(c, 10, now)).toBe(false);
  });
  it("recuperado não alerta", () => {
    expect(offlineBeyondTolerance({ status: "online", offline_since: null }, 5, now)).toBe(false);
  });
  it("sem tolerância alerta imediatamente", () => {
    expect(offlineBeyondTolerance({ status: "offline", offline_since: null }, 0, now)).toBe(true);
  });
});

describe("episódio de alerta", () => {
  it("mesma janela de cooldown gera a mesma chave", () => {
    const t = Date.parse("2026-10-25T12:01:00Z");
    expect(episodeKey("down:x", 30, t)).toBe(episodeKey("down:x", 30, t + 10 * 60000));
    expect(episodeKey("down:x", 30, t)).not.toBe(episodeKey("down:x", 30, t + 31 * 60000));
  });
});
