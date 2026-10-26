import { describe, it, expect } from "vitest";
import { freshness, fmtValue, stats, kindsFor, type Pt } from "@/lib/dashboardLogic";

const now = Date.parse("2026-10-26T12:00:00Z");
describe("dashboard", () => {
  it("diferencia ausência, atraso, erro e não suportado", () => {
    expect(freshness({ supported: true, lastAt: null, now })).toBe("no_sample");
    expect(freshness({ supported: true, lastAt: "2026-10-26T11:50:00Z", now })).toBe("stale");
    expect(freshness({ supported: true, lastAt: "2026-10-26T11:59:30Z", now })).toBe("fresh");
    expect(freshness({ supported: false, lastAt: null, now })).toBe("unsupported");
    expect(freshness({ error: true, supported: true, lastAt: null, now })).toBe("error");
  });
  it("ausência nunca vira zero e uptime é duração", () => {
    expect(fmtValue("cpu_load", null)).toBe("Sem dados");
    expect(fmtValue("uptime_seconds", 90000)).toBe("1d 1h");
    expect(fmtValue("if_traffic", 1_500_000)).toBe("1.5 Mbps");
  });
  it("pico usa máximo do bucket e volume só para taxa", () => {
    const p: Pt[] = [
      { bucket_at: "a", kind: "if_in_bps", avg_value: 8000, max_value: 16000, samples: 2, bucket_seconds: 60 },
      { bucket_at: "b", kind: "if_in_bps", avg_value: 8000, max_value: 9000, samples: 2, bucket_seconds: 60 },
    ];
    const s = stats(p, "if_in_bps", true)!;
    expect(s.peak).toBe(16000); expect(s.peakAt).toBe("a");
    expect(s.volumeBytes).toBe(120000);
    expect(stats(p, "cpu_load", false)).toBeNull();
  });
  it("tráfego consulta apenas RX/TX da interface escolhida", () => {
    expect(kindsFor("if_traffic")).toEqual(["if_in_bps", "if_out_bps"]);
  });
});
