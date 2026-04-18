import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { useAuth, type AppRole } from "@/hooks/useAuth";
import { useState } from "react";

const ROLES: AppRole[] = ["admin", "tecnico", "visualizador"];

interface UserRow {
  id: string;
  email: string | null;
  full_name: string | null;
  created_at: string;
  roles: AppRole[];
}

export default function AdminUsuarios() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const [addingFor, setAddingFor] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-usuarios"],
    queryFn: async (): Promise<UserRow[]> => {
      const { data: profiles, error: pErr } = await supabase
        .from("profiles")
        .select("id, email, full_name, created_at")
        .order("created_at", { ascending: false });
      if (pErr) throw pErr;

      const { data: roles, error: rErr } = await supabase
        .from("user_roles")
        .select("user_id, role");
      if (rErr) throw rErr;

      const byUser = new Map<string, AppRole[]>();
      for (const r of roles ?? []) {
        const arr = byUser.get(r.user_id) ?? [];
        arr.push(r.role as AppRole);
        byUser.set(r.user_id, arr);
      }

      return (profiles ?? []).map((p) => ({ ...p, roles: byUser.get(p.id) ?? [] }));
    },
  });

  const addRole = async (userId: string, role: AppRole) => {
    const { error } = await supabase.from("user_roles").insert({ user_id: userId, role });
    setAddingFor(null);
    if (error) {
      if (error.code === "23505") {
        toast.error("Usuário já possui esse papel");
      } else {
        toast.error("Erro ao adicionar papel", { description: error.message });
      }
      return;
    }
    toast.success("Papel adicionado");
    qc.invalidateQueries({ queryKey: ["admin-usuarios"] });
  };

  const removeRole = async (userId: string, role: AppRole) => {
    if (userId === me?.id && role === "admin") {
      const { count } = await supabase
        .from("user_roles")
        .select("id", { count: "exact", head: true })
        .eq("role", "admin");
      if ((count ?? 0) <= 1) {
        toast.error("Não é possível remover o último admin");
        return;
      }
    }
    const { error } = await supabase
      .from("user_roles")
      .delete()
      .eq("user_id", userId)
      .eq("role", role);
    if (error) {
      toast.error("Erro ao remover papel", { description: error.message });
      return;
    }
    toast.success("Papel removido");
    qc.invalidateQueries({ queryKey: ["admin-usuarios"] });
  };

  const roleVariant = (r: AppRole) => {
    if (r === "admin") return "default";
    if (r === "tecnico") return "secondary";
    return "outline";
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Gerencie papéis dos usuários. Novos cadastros recebem <code className="text-xs">visualizador</code> automaticamente.
      </p>

      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Usuário</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Papéis</TableHead>
              <TableHead className="w-48">Adicionar papel</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">Carregando…</TableCell></TableRow>
            )}
            {!isLoading && data?.length === 0 && (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">Nenhum usuário.</TableCell></TableRow>
            )}
            {data?.map((u) => {
              const available = ROLES.filter((r) => !u.roles.includes(r));
              return (
                <TableRow key={u.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="font-medium">{u.full_name ?? "—"}</div>
                        {u.id === me?.id && <div className="text-[10px] uppercase text-primary">você</div>}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{u.email ?? "—"}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {u.roles.length === 0 && <span className="text-xs text-muted-foreground">sem papel</span>}
                      {u.roles.map((r) => (
                        <Badge key={r} variant={roleVariant(r)} className="gap-1">
                          {r}
                          <button
                            onClick={() => removeRole(u.id, r)}
                            className="ml-1 opacity-60 hover:opacity-100"
                            aria-label={`Remover ${r}`}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {available.length > 0 ? (
                      <Select
                        value={addingFor === u.id ? "" : ""}
                        onValueChange={(v) => addRole(u.id, v as AppRole)}
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue placeholder="Adicionar…" />
                        </SelectTrigger>
                        <SelectContent>
                          {available.map((r) => (
                            <SelectItem key={r} value={r}>{r}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="text-xs text-muted-foreground">todos atribuídos</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
