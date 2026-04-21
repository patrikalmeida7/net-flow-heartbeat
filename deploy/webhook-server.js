// Webhook receiver simples — escuta em 127.0.0.1:9000
// O Nginx faz proxy de https://VPS/__deploy → 127.0.0.1:9000/deploy
// Auth: header X-Deploy-Secret precisa bater com WEBHOOK_SECRET do .env
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Carrega .env simples
const envPath = path.join(path.dirname(new URL(import.meta.url).pathname), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

const PORT = Number(process.env.WEBHOOK_PORT || 9000);
const SECRET = process.env.WEBHOOK_SECRET;
const DEPLOY_SCRIPT = process.env.DEPLOY_SCRIPT || "/home/deploy/app/deploy/deploy.sh";

if (!SECRET) {
  console.error("[FATAL] WEBHOOK_SECRET não definido no .env");
  process.exit(1);
}

let deploying = false;

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/deploy") {
    res.writeHead(404);
    return res.end("not found");
  }

  const got = req.headers["x-deploy-secret"];
  if (!got || got !== SECRET) {
    log("AUTH FAIL", req.socket.remoteAddress);
    res.writeHead(401);
    return res.end("unauthorized");
  }

  if (deploying) {
    res.writeHead(202);
    return res.end("deploy already running");
  }

  deploying = true;
  log("deploy disparado");
  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "started" }));

  const child = spawn(DEPLOY_SCRIPT, [], { stdio: "inherit" });
  child.on("exit", (code) => {
    deploying = false;
    log(`deploy terminou code=${code}`);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`webhook escutando em 127.0.0.1:${PORT}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`recebido ${sig}, encerrando`);
    server.close(() => process.exit(0));
  });
}
