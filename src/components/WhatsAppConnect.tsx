import { useEffect, useState } from "react";
import { QrCode, LogOut, RefreshCw, Smartphone } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

const invoke = async (action: string, extra: Record<string, unknown> = {}) => {
  const { data, error } = await supabase.functions.invoke("notify-whatsapp", { body: { action, ...extra } });
  if (data?.error) throw new Error(data.error);
  if (error) throw new Error(error.message);
  return data;
};

const label: Record<string, string> = { open: "Conectado", connecting: "Aguardando leitura", close: "Desconectado", missing: "Instância não criada", unknown: "Desconhecido" };

export function WhatsAppConnect({ ready }: { ready: boolean }) {
  const [state, setState] = useState<string>("unknown");
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try { const d = await invoke("wa_status"); setState(d.state); if (d.state === "open") { setQr(null); setCode(null); } } catch { setState("unknown"); }
  };

  useEffect(() => { if (ready) refresh(); }, [ready]);
  useEffect(() => {
    if (!qr && !code) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [qr, code]);

  const connect = async (withNumber: boolean) => {
    setBusy(true);
    try {
      const d = await invoke("wa_connect", withNumber ? { number } : {});
      if (d.state === "open") { setState("open"); toast.success("WhatsApp já está conectado"); }
      else {
        setQr(d.qr ? (d.qr.startsWith("data:") ? d.qr : `data:image/png;base64,${d.qr}`) : null);
        setCode(d.pairingCode ?? null);
        setState("connecting");
        if (!d.qr && !d.pairingCode) toast.error("O MultixZap não devolveu o QR Code. Tente de novo.");
      }
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };

  const logout = async () => {
    setBusy(true);
    try { await invoke("wa_logout"); toast.success("WhatsApp desconectado"); setQr(null); setCode(null); await refresh(); }
    catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };

  if (!ready) return <p className="text-sm text-muted-foreground">Preencha endereço, token e instância e clique em <b>Salvar</b> para liberar o QR Code.</p>;

  return (
    <div className="rounded-md border border-border p-4">
      <div className="mb-3 flex items-center gap-2">
        <Smartphone className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">WhatsApp</span>
        <Badge variant={state === "open" ? "default" : "secondary"}>{label[state] ?? state}</Badge>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={refresh} disabled={busy}><RefreshCw className="h-4 w-4" /></Button>
      </div>

      {state === "open" ? (
        <Button variant="outline" onClick={logout} disabled={busy}><LogOut className="mr-1 h-4 w-4" />Desconectar / trocar número</Button>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => connect(false)} disabled={busy}><QrCode className="mr-1 h-4 w-4" />Gerar QR Code</Button>
            <Input className="w-48" placeholder="5511999999999" value={number} onChange={(e) => setNumber(e.target.value)} />
            <Button variant="secondary" onClick={() => connect(true)} disabled={busy || number.replace(/\D/g, "").length < 10}>Receber código</Button>
          </div>
          {qr && (
            <div className="flex flex-col items-center gap-2">
              <img src={qr} alt="QR Code do WhatsApp" className="h-64 w-64 rounded-md bg-card p-2" />
              <p className="text-center text-xs text-muted-foreground">No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho. A tela atualiza sozinha.</p>
            </div>
          )}
          {code && <p className="text-center text-lg font-semibold tracking-widest">Código: {code}</p>}
        </div>
      )}
    </div>
  );
}
