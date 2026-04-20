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
      title: "1. Preparar a VM (Ubuntu 22.04+)",
      body: `# Como root
apt update && apt upgrade -y
apt install -y curl git wireguard wireguard-tools openvpn iputils-ping
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version`,
    },
    {
      title: "2. Baixar e instalar o agente",
      body: `cd /opt
git clone <URL_DO_SEU_REPO>.git noc-source
cd noc-source/agent
sudo bash install.sh`,
    },
    {
      title: "3. Configurar concentradores (config.json)",
      body: `nano /opt/noc-agent/config.json

# Edite os campos:
#  - "ingest_token": "${ingest}"
#  - "concentradores": [{ host, user, password, snmp: {...} }]
#  - Se quiser RBS, adicione em "rbs": [...]`,
    },
    {
      title: "4. Ativar loop VPN (variáveis de ambiente)",
      body: `sudo systemctl edit noc-agent

# Cole exatamente isto e salve:
[Service]
Environment="VPN_AGENT_TOKEN=${vpn}"
Environment="VPN_SYNC_URL=${VPN_SYNC_URL}"`,
    },
    {
      title: "5. Iniciar e ver logs",
      body: `sudo systemctl daemon-reload
sudo systemctl enable --now noc-agent
sudo journalctl -u noc-agent -f`,
    },
    {
      title: "URLs do projeto (já preenchidas)",
      body: `Ingest URL : ${INGEST_URL}
Metrics URL: ${METRICS_URL}
VPN Sync   : ${VPN_SYNC_URL}`,
    },
  ];

  // Bloco "tudo em um" para copiar de uma vez
  const allInOne = `#!/usr/bin/env bash
# Instalação completa do NOC Agent
set -euo pipefail

# 1. Dependências
apt update
apt install -y curl git wireguard wireguard-tools openvpn iputils-ping
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 2. Código
cd /opt
[ -d noc-source ] || git clone <URL_DO_SEU_REPO>.git noc-source
cd noc-source/agent
bash install.sh

# 3. Variáveis VPN
mkdir -p /etc/systemd/system/noc-agent.service.d
cat > /etc/systemd/system/noc-agent.service.d/override.conf <<EOF
[Service]
Environment="VPN_AGENT_TOKEN=${vpn}"
Environment="VPN_SYNC_URL=${VPN_SYNC_URL}"
EOF

# 4. Editar config (interativo)
echo ">>> Edite agora /opt/noc-agent/config.json com seus concentradores e ingest_token"
echo ">>> Depois rode: systemctl enable --now noc-agent && journalctl -u noc-agent -f"`;

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
