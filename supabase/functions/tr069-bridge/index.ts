// Bridge between NOC-ISP and a GenieACS NBI. Logic lives in handler.ts (dependency-injected, tested from src/test).
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createHandler } from "./handler.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const userDb = (auth: string) => createClient(URL_, ANON, { global: { headers: { Authorization: auth } } });

Deno.serve(createHandler({
  cors: corsHeaders,
  getUid: async (auth) => {
    if (!auth.startsWith("Bearer ")) return null;
    const { data } = await userDb(auth).auth.getClaims(auth.slice(7));
    return (data?.claims?.sub as string) ?? null;
  },
  userDb,
  admin: createClient(URL_, SRK),
  fetch: (...a) => fetch(...a),
  secretKey: Deno.env.get("ACS_SECRETS_KEY") ?? "",
}));
