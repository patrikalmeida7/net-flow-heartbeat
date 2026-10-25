export type AppRole = "admin" | "tecnico" | "visualizador";
export type AccessStatus = "loading" | "signed_out" | "pending" | "active" | "error";

/** Exact normalized e-mail (trim + lowercase). No domain/alias tricks. */
export function normalizeEmail(e: string): string {
  return e.trim().toLowerCase();
}

const RANK: Record<AppRole, number> = { visualizador: 1, tecnico: 2, admin: 3 };

/** Mirrors server has_role(): admin > tecnico > visualizador. UI only; the server decides. */
export function roleAllows(role: AppRole | null, needed: AppRole): boolean {
  return !!role && RANK[role] >= RANK[needed];
}

/** Fail closed: anything other than an explicit active answer is not access. */
export function accessFromRpc(data: unknown): { status: "pending" | "active"; role: AppRole | null } {
  const d = (data ?? {}) as { status?: string; role?: string };
  if (d.status === "active" && d.role && d.role in RANK) return { status: "active", role: d.role as AppRole };
  return { status: "pending", role: null };
}

/** Same-origin path only, used after OAuth to return the user where they wanted. */
export function safeNextPath(p: string | null | undefined): string {
  if (!p || !p.startsWith("/") || p.startsWith("//") || p.startsWith("/auth")) return "/";
  return p;
}
