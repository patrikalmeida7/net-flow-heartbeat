import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Session, User } from "@supabase/supabase-js";
import { accessFromRpc, roleAllows, type AppRole, type AccessStatus } from "@/lib/access";

export type { AppRole } from "@/lib/access";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  roles: AppRole[];
  role: AppRole | null;
  access: AccessStatus;
  loading: boolean;
  signOut: () => Promise<void>;
  hasRole: (role: AppRole) => boolean;
  isAdmin: boolean;
  refreshAccess: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [role, setRole] = useState<AppRole | null>(null);
  const [access, setAccess] = useState<AccessStatus>("loading");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_e, sess) => {
      setSession(sess);
      setSessionReady(true);
    });
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionReady(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const uid = session?.user?.id ?? null;

  useEffect(() => {
    if (!sessionReady) return;
    if (!uid) {
      setRole(null);
      setAccess("signed_out");
      return;
    }
    let cancelled = false;
    setAccess("loading");
    supabase.rpc("my_access").then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setRole(null);
        setAccess("error");
        return;
      }
      const a = accessFromRpc(data);
      setRole(a.role);
      setAccess(a.status);
    });
    return () => {
      cancelled = true;
    };
  }, [uid, sessionReady, tick]);

  // Re-check periodically so a block applies to open sessions in the UI too (server already enforces it).
  useEffect(() => {
    if (!uid) return;
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, [uid]);

  const signOut = async () => {
    await supabase.auth.signOut();
  };
  const hasRole = (r: AppRole) => access === "active" && roleAllows(role, r);
  const refreshAccess = useCallback(() => setTick((x) => x + 1), []);

  return (
    <AuthContext.Provider
      value={{
        user: session?.user ?? null,
        session,
        role,
        roles: role ? [role] : [],
        access,
        loading: access === "loading",
        signOut,
        hasRole,
        isAdmin: hasRole("admin"),
        refreshAccess,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth deve ser usado dentro de <AuthProvider>");
  return ctx;
}
