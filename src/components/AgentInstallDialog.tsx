import { useState } from "react";
import { Copy, Check, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const VPN_SYNC_URL = `${SUPABASE_URL}/functions/v1/vpn-agent-sync`;
const INGEST_URL = `${SUPABASE_URL}/functions/v1/agent-ingest`;
const METRICS_URL = `${SUPABASE_URL}/functions/v1/metrics-ingest`;
const COLLECTOR_INSTALLER_URL = `${SUPABASE_URL}/functions/v1/collector-installer`;

interface AgentInstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Token recém-gerado (só disponível na criação). Se null, mostra placeholder. */
  vpnToken?: string | null;
  /** Token de ingestão (opcional — placeholder se não disponível) */
  ingestToken?: string | null;
  agentName?: string;
}

interface Block {
  title: string;
  body: string;
  language?: string;
}

function CodeBlock({ block }: { block: Block }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(block.body);
    setCopied(true);
    toast.success("Copiado");
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">{block.title}</h4>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? <Check className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />}
          {copied ? "Copiado" : "Copiar"}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
        <code className="font-mono">{block.body}</code>
      </pre>
    </div>
  );
}

export function AgentInstallDialog({
  open,
  onOpenChange,
  vpnToken,
  ingestToken,
  agentName,
}: AgentInstallDialogProps) {
  const ingest = ingestToken || "<COLE_AQUI_O_AGENT_INGEST_TOKEN>";
  const vpn = vpnToken || "<COLE_AQUI_O_VPN_AGENT_TOKEN>";

  const blocks: Block[] = [
    {
      title: "🚀 Instalação automática (1 comando — Ubuntu 22.04+)",
      body: `# Como root na VPS Vultr (ou qualquer Ubuntu 22.04+)
INGEST_TOKEN="${ingest}" sudo -E bash -c "curl -fsSL ${COLLECTOR_INSTALLER_URL} | bash"`,
    },
    {
      title: "Alternativa: rodar interativo (script pergunta o token)",
      body: `curl -fsSL ${COLLECTOR_INSTALLER_URL} | sudo bash`,
    },
    {
      title: "Após instalar — ativar loop VPN deste agente",
      body: `sudo systemctl edit noc-agent

# Cole exatamente isto e salve:
[Service]
Environment="VPN_AGENT_TOKEN=${vpn}"
Environment="VPN_SYNC_URL=${VPN_SYNC_URL}"

# Aplicar:
sudo systemctl daemon-reload
sudo systemctl restart noc-agent
sudo journalctl -u noc-agent -f`,
    },
    {
      title: "URLs do projeto (referência)",
      body: `Installer  : ${COLLECTOR_INSTALLER_URL}
Ingest URL : ${INGEST_URL}
Metrics URL: ${METRICS_URL}
VPN Sync   : ${VPN_SYNC_URL}`,
    },
  ];

  // Bloco "tudo em um" para copiar de uma vez
  const allInOne = `#!/usr/bin/env bash
# Instalação completa do NOC Collector + ativação VPN
set -euo pipefail

# 1. Instala collector (Docker, WireGuard, OpenVPN, agente)
INGEST_TOKEN="${ingest}" curl -fsSL ${COLLECTOR_INSTALLER_URL} | bash

# 2. Ativa loop VPN do agente
mkdir -p /etc/systemd/system/noc-agent.service.d
cat > /etc/systemd/system/noc-agent.service.d/override.conf <<EOF
[Service]
Environment="VPN_AGENT_TOKEN=${vpn}"
Environment="VPN_SYNC_URL=${VPN_SYNC_URL}"
EOF

systemctl daemon-reload
systemctl restart noc-agent
journalctl -u noc-agent -f`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            Comando de instalação{agentName ? ` — ${agentName}` : ""}
          </DialogTitle>
          <DialogDescription>
            Execute estes comandos numa VM Linux (Ubuntu 22.04+) que tenha acesso de rede aos seus
            equipamentos. O agente vai manter os túneis VPN ativos e coletar métricas via RouterOS API + SNMP.
          </DialogDescription>
        </DialogHeader>

        {!vpnToken && (
          <div className="rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-xs">
            ⚠️ O token VPN deste agente não pode ser recuperado (só guardamos o hash). Os comandos
            abaixo usam um placeholder <code className="rounded bg-muted px-1">{"<COLE_AQUI_O_VPN_AGENT_TOKEN>"}</code>.
            Se você perdeu o token, exclua este agente e crie um novo.
          </div>
        )}

        <div className="space-y-4">
          {blocks.map((b, i) => (
            <CodeBlock key={i} block={b} />
          ))}

          <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
            <CodeBlock
              block={{
                title: "🚀 Tudo em um único script (cole numa VM nova)",
                body: allInOne,
              }}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
