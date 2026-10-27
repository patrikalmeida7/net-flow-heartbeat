// Runs deploy/genieacs/setup.sh against stub binaries (no real Docker, no network).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../deploy/genieacs");

function run(opts: { missing?: string[]; ssOut?: string; ssFail?: boolean; existing?: boolean; cwmpNoAuth?: string; cmd?: string; env?: Record<string, string> }) {
  const dir = mkdtempSync(path.join(tmpdir(), "acs-"));
  const work = path.join(dir, "acs"); cpSync(SRC, work, { recursive: true });
  const bin = path.join(dir, "bin"); mkdirSync(bin);
  const stub = (name: string, body: string) => { if (opts.missing?.includes(name)) return; const f = path.join(bin, name); writeFileSync(f, `#!/bin/bash\n${body}\n`); chmodSync(f, 0o755); };
  stub("docker", `
case "$*" in
  "compose version") exit 0;; "info") exit 0;;
  "ps -a"*) ${opts.existing ? 'echo abc123' : 'true'};;
  "volume ls"*) true;;
  "inspect"*) echo healthy;;
  "compose -p noc-genieacs ps -q"*) echo cid;;
  *) echo "$*" >> "${dir}/docker.log";;
esac`);
  stub("ss", opts.ssFail ? "exit 1" : `echo -n "${opts.ssOut ?? ""}"`);
  stub("openssl", 'echo stubvalue');
  stub("sleep", "true");
  // curl stub: CWMP without creds -> 401 unless cwmpNoAuth overrides; any -u -> 401 if invalid user, else 200.
  stub("curl", `
args="$*"
if [[ "$args" == *7558* ]]; then echo 401; exit 0; fi
if [[ "$args" == *"-u noc-invalido"* ]]; then echo 401; exit 0; fi
if [[ "$args" == *"-u "* ]]; then echo 200; exit 0; fi
echo ${opts.cwmpNoAuth ?? "401"}`);
  const sys = "/usr/bin:/bin";
  const PATH = `${bin}:${sys}`;
  // Hide real binaries we want "missing" by making a PATH without them.
  const env = { PATH: opts.missing?.length ? bin + ":" + "/nonexistent" : PATH, ...opts.env } as NodeJS.ProcessEnv;
  if (opts.missing?.length) for (const c of ["awk", "grep", "cut", "cat", "sed", "seq", "printf", "chmod", "tr", "dirname"]) {
    const real = execFileSync("bash", ["-c", `command -v ${c} || true`]).toString().trim();
    if (real) { writeFileSync(path.join(bin, c), `#!/bin/bash\nexec ${real} "$@"\n`); chmodSync(path.join(bin, c), 0o755); }
  }
  try {
    const out = execFileSync("/bin/bash", [path.join(work, "setup.sh"), opts.cmd ?? "install"], { env, encoding: "utf8", stdio: "pipe" });
    return { code: 0, out, work, dir };
  } catch (e: any) { return { code: e.status as number, out: String(e.stdout) + String(e.stderr), work, dir }; }
}

describe("instalador GenieACS", () => {
  it("dependência ausente aborta antes de criar arquivos", () => {
    const r = run({ missing: ["ss"] });
    expect(r.code).not.toBe(0); expect(r.out).toMatch(/dependência ausente: ss/);
    expect(existsSync(path.join(r.work, ".env"))).toBe(false);
  });
  it("falha ao verificar portas aborta", () => {
    const r = run({ ssFail: true });
    expect(r.code).not.toBe(0); expect(r.out).toMatch(/não foi possível verificar a porta/);
    expect(existsSync(path.join(r.work, ".env"))).toBe(false);
  });
  it("conflito de porta aborta sem alterar nada", () => {
    const r = run({ ssOut: "LISTEN 0 4096 0.0.0.0:7547" });
    expect(r.code).not.toBe(0); expect(r.out).toMatch(/porta 7547 já está em uso/);
    expect(existsSync(path.join(r.work, ".env"))).toBe(false);
  });
  it("instalação existente (inclusive parada) não é tocada", () => {
    const r = run({ existing: true });
    expect(r.code).toBe(0); expect(r.out).toMatch(/Instalação existente/);
    expect(existsSync(path.join(r.work, ".env"))).toBe(false);
  });
  it("instala fechado e só reporta sucesso após testar autenticação", () => {
    const r = run({});
    expect(r.code).toBe(0); expect(r.out).toMatch(/Autenticação CPE→ACS e NBI verificadas/); expect(r.out).toMatch(/Instalado FECHADO/);
    expect(execFileSync("cat", [path.join(r.work, ".env")]).toString()).toMatch(/CWMP_BIND=127.0.0.1/);
  });
  it("ACS aceitando modem sem autenticação falha", () => {
    const r = run({ cwmpNoAuth: "200" });
    expect(r.code).not.toBe(0); expect(r.out).toMatch(/SEM autenticação/);
  });
  it("open-cwmp exige confirmação explícita", () => {
    const r1 = run({});
    const r = (() => { try { return { code: 0, out: execFileSync("/bin/bash", [path.join(r1.work, "setup.sh"), "open-cwmp"], { env: { PATH: `${path.join(r1.dir, "bin")}:/usr/bin:/bin` }, encoding: "utf8", stdio: "pipe" }) }; }
      catch (e: any) { return { code: e.status, out: String(e.stderr) }; } })();
    expect(r.code).not.toBe(0); expect(r.out).toMatch(/CONFIRM_OPEN=yes/);
  });
});
