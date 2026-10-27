// Runs deploy/genieacs/setup.sh against stub binaries (no real Docker, no network). Simulated only.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../deploy/genieacs");
type Who = "none" | "bad" | "good";
type Resp = { code: string; body?: string; exit?: number };
const OK_INFORM: Resp = { code: "200", body: "<soap-env:Envelope><cwmp:InformResponse><MaxEnvelopes>1</MaxEnvelopes></cwmp:InformResponse></soap-env:Envelope>" };
const DENY: Resp = { code: "401" };

function run(opts: { missing?: string[]; ssOut?: string; ssFail?: boolean; existing?: boolean; cmd?: string; env?: Record<string, string>;
  cwmp?: Partial<Record<Who, Resp>>; nbi?: Partial<Record<Who, Resp>>; work?: string; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(path.join(tmpdir(), "acs-"));
  const work = opts.work ?? path.join(dir, "acs");
  if (!opts.work) cpSync(SRC, work, { recursive: true });
  const bin = path.join(dir, "bin"); mkdirSync(bin, { recursive: true });
  const stub = (name: string, body: string) => { if (opts.missing?.includes(name)) return; const f = path.join(bin, name); writeFileSync(f, `#!/bin/bash\n${body}\n`); chmodSync(f, 0o755); };
  stub("docker", `
echo "$*" >> "${dir}/argv.log"
case "$*" in
  "compose version") exit 0;; "info") exit 0;;
  "ps -a"*) ${opts.existing ? "echo abc123" : "true"};;
  "volume ls"*) true;;
  "inspect"*) echo healthy;;
  "compose -p noc-genieacs ps -q"*) echo cid;;
  *exec*) cat > "${dir}/mongo-stdin.js";;
  *) true;;
esac`);
  stub("ss", opts.ssFail ? "exit 1" : `echo -n "${opts.ssOut ?? ""}"`);
  stub("openssl", `echo "openssl $*" >> "${dir}/argv.log"; if [ "$1" = passwd ]; then cat > /dev/null; echo '$apr1$hash'; else echo stubvalue; fi`);
  stub("sleep", "true");
  const py = execFileSync("bash", ["-c", "command -v python3"]).toString().trim();
  stub("python3", `exec ${py} "$@"`);
  const cw = { none: DENY, bad: DENY, good: OK_INFORM, ...opts.cwmp };
  const nb = { none: DENY, bad: DENY, good: { code: "200", body: "[]" }, ...opts.nbi };
  const enc = (r: Resp) => `${r.code}|${r.exit ?? 0}|${Buffer.from(r.body ?? "").toString("base64")}`;
  // curl stub: classifies credential from the -K config file (never from argv).
  stub("curl", `
echo "curl $*" >> "${dir}/argv.log"
cfg=""; out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -K) cfg="$2"; shift;; -o) out="$2"; shift;; http*) url="$1";; esac; shift; done
who=none
if [ -s "$cfg" ]; then if grep -q 'noc-invalido' "$cfg"; then who=bad; else who=good; fi; fi
if [[ "$url" == *7558* ]]; then case $who in none) r='${enc(nb.none)}';; bad) r='${enc(nb.bad)}';; good) r='${enc(nb.good)}';; esac
else case $who in none) r='${enc(cw.none)}';; bad) r='${enc(cw.bad)}';; good) r='${enc(cw.good)}';; esac; fi
IFS='|' read -r code ex b64 <<< "$r"
[ -n "$out" ] && echo -n "$b64" | base64 -d > "$out"
echo -n "$code"; exit $ex`);
  const env = { PATH: opts.missing?.length ? bin + ":/nonexistent" : `${bin}:/usr/bin:/bin`, ...opts.env } as NodeJS.ProcessEnv;
  if (opts.missing?.length) for (const c of ["awk", "grep", "cut", "cat", "sed", "seq", "printf", "chmod", "tr", "dirname", "mktemp", "rm", "base64"]) {
    const real = execFileSync("bash", ["-c", `command -v ${c} || true`]).toString().trim();
    if (real) { writeFileSync(path.join(bin, c), `#!/bin/bash\nexec ${real} "$@"\n`); chmodSync(path.join(bin, c), 0o755); }
  }
  try {
    const out = execFileSync("/bin/bash", [path.join(work, "setup.sh"), opts.cmd ?? "install"], { env, encoding: "utf8", stdio: "pipe" });
    return { code: 0, out, work, dir };
  } catch (e: any) { return { code: e.status as number, out: String(e.stdout) + String(e.stderr), work, dir }; }
}
const argv = (dir: string) => (existsSync(path.join(dir, "argv.log")) ? readFileSync(path.join(dir, "argv.log"), "utf8") : "");
const secrets = (work: string) => ["cwmp.credentials", "nbi.credentials"].map((f) => readFileSync(path.join(work, f), "utf8").split(":").slice(1).join(":"));

describe("instalador GenieACS: pré-condições", () => {
  it("bash -n aceita o instalador", () => { execFileSync("bash", ["-n", path.join(SRC, "setup.sh")]); });
  it("dependência ausente aborta antes de criar arquivos", () => {
    const r = run({ missing: ["ss"] });
    expect(r.code).not.toBe(0); expect(r.out).toMatch(/dependência ausente: ss/);
    expect(existsSync(path.join(r.work, ".env"))).toBe(false);
  });
  it("falha ao verificar portas aborta", () => {
    const r = run({ ssFail: true });
    expect(r.code).not.toBe(0); expect(existsSync(path.join(r.work, ".env"))).toBe(false);
  });
  it("conflito de porta aborta sem alterar nada", () => {
    const r = run({ ssOut: "LISTEN 0 4096 0.0.0.0:7547" });
    expect(r.code).not.toBe(0); expect(r.out).toMatch(/porta 7547 já está em uso/);
  });
  it("instalação existente não é tocada", () => {
    const r = run({ existing: true });
    expect(r.code).toBe(0); expect(r.out).toMatch(/Instalação existente/);
    expect(existsSync(path.join(r.work, ".env"))).toBe(false);
  });
});

describe("instalador GenieACS: verificação CWMP/NBI", () => {
  it("instala fechado e só anuncia sucesso após todos os testes", () => {
    const r = run();
    expect(r.code).toBe(0); expect(r.out).toMatch(/Autenticação CPE→ACS e NBI verificadas/); expect(r.out).toMatch(/Instalado FECHADO/);
    expect(readFileSync(path.join(r.work, ".env"), "utf8")).toMatch(/CWMP_BIND=127.0.0.1/);
    // Inform TR-069 válido é enviado, não POST vazio
    expect(argv(r.dir)).toMatch(/--data-binary @.*inform\.xml/);
  });
  const fail = (o: Parameters<typeof run>[0], re: RegExp) => { const r = run(o); expect(r.code).not.toBe(0); expect(r.out).toMatch(re); expect(r.out).not.toMatch(/Instalado FECHADO/); };
  it("CWMP aceitando sem senha reprova", () => fail({ cwmp: { none: OK_INFORM } }, /sem credencial respondeu 200/));
  it("CWMP aceitando senha errada reprova", () => fail({ cwmp: { bad: OK_INFORM } }, /INVÁLIDA respondeu 200/));
  it("credencial correta: 000 (transporte) reprova", () => fail({ cwmp: { good: { code: "000", exit: 7 } } }, /correta respondeu 000/));
  it("credencial correta: timeout reprova", () => fail({ cwmp: { good: { code: "000", exit: 28 } } }, /correta respondeu 000/));
  it("credencial correta: 403 reprova", () => fail({ cwmp: { good: { code: "403" } } }, /correta respondeu 403/));
  it("credencial correta: 500 reprova", () => fail({ cwmp: { good: { code: "500" } } }, /correta respondeu 500/));
  it("200 sem InformResponse reprova", () => fail({ cwmp: { good: { code: "200", body: "<html>ok</html>" } } }, /não devolveu InformResponse/));
  it("sem credencial com 000 (ACS fora) reprova", () => fail({ cwmp: { none: { code: "000", exit: 7 } } }, /sem credencial respondeu 000/));
  it("NBI sem senha aceita reprova", () => fail({ nbi: { none: { code: "200", body: "[]" } } }, /NBI sem senha respondeu 200/));
  it("NBI com senha errada aceita reprova", () => fail({ nbi: { bad: { code: "200", body: "[]" } } }, /senha errada respondeu 200/));
  it("NBI autenticada com resposta inválida reprova", () => fail({ nbi: { good: { code: "200", body: "<html>" } } }, /não devolveu JSON válido/));
  it("NBI autenticada com 500 reprova", () => fail({ nbi: { good: { code: "500" } } }, /correta respondeu 500/));
});

describe("instalador GenieACS: segredos", () => {
  it("nenhum segredo nos argumentos dos processos nem na saída; arquivos 600", () => {
    const r = run();
    expect(r.code).toBe(0);
    const log = argv(r.dir);
    expect(log).not.toMatch(/ -u /);
    for (const s of secrets(r.work)) { expect(s.length).toBeGreaterThan(3); expect(log).not.toContain(s); expect(r.out).not.toContain(s); }
    expect(log).not.toMatch(/--eval/);
    // mongosh recebe o script por stdin, sem a senha em texto puro
    const js = readFileSync(path.join(r.dir, "mongo-stdin.js"), "utf8");
    expect(js).toMatch(/cwmp\.auth/);
    for (const s of secrets(r.work)) expect(js).not.toContain(`"${s}"`);
    for (const f of ["cwmp.credentials", "nbi.credentials"]) expect(statSync(path.join(r.work, f)).mode & 0o077).toBe(0);
  });
  it("open-cwmp exige confirmação explícita", () => {
    const r1 = run();
    const r = run({ cmd: "open-cwmp", work: r1.work, dir: r1.dir });
    expect(r.code).not.toBe(0); expect(r.out).toMatch(/CONFIRM_OPEN=yes/);
    expect(readFileSync(path.join(r1.work, ".env"), "utf8")).toMatch(/CWMP_BIND=127.0.0.1/);
  });
  it("open-cwmp com falha na re-verificação volta para 127.0.0.1", () => {
    const r1 = run();
    let n = 0; void n;
    // Primeira verificação passa; a segunda (após publicar) recebe 403 via estado em arquivo.
    const flag = path.join(r1.dir, "opened");
    const curl = path.join(r1.dir, "bin", "curl");
    const orig = readFileSync(curl, "utf8");
    writeFileSync(curl, orig.replace('who=none\n', `who=none\nif grep -q '^CWMP_BIND=0.0.0.0' "${r1.work}/.env"; then touch "${flag}"; echo -n 403; exit 0; fi\n`));
    const r = run({ cmd: "open-cwmp", work: r1.work, dir: r1.dir, env: { CONFIRM_OPEN: "yes" } });
    // run() rewrites stubs; reapply and execute directly
    writeFileSync(curl, orig.replace('who=none\n', `who=none\nif grep -q '^CWMP_BIND=0.0.0.0' "${r1.work}/.env"; then touch "${flag}"; echo -n 403; exit 0; fi\n`));
    void r;
    let res: { code: number; out: string };
    try { res = { code: 0, out: execFileSync("/bin/bash", [path.join(r1.work, "setup.sh"), "open-cwmp"], { env: { PATH: `${path.join(r1.dir, "bin")}:/usr/bin:/bin`, CONFIRM_OPEN: "yes" }, encoding: "utf8", stdio: "pipe" }) }; }
    catch (e: any) { res = { code: e.status, out: String(e.stdout) + String(e.stderr) }; }
    expect(existsSync(flag)).toBe(true);
    expect(res.code).not.toBe(0); expect(res.out).toMatch(/voltou para 127.0.0.1/);
    expect(readFileSync(path.join(r1.work, ".env"), "utf8")).toMatch(/CWMP_BIND=127.0.0.1/);
  });
});
