import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { z } from "npm:zod@3";
import { encryptSecret, decryptSecret } from "../_shared/credential-cipher.ts";
import { secretMatches } from "../_shared/security.ts";
const schema = z.object({ operation: z.enum(["encrypt", "decrypt"]), value: z.string().max(1048576), aad: z.string().regex(/^(mikrotik_api_credentials|device_credentials|vpn_connections|vpn_clients):[0-9a-f-]{36}:(password|config|wg_private_key|wg_preshared_key|ovpn_config|ovpn_password)$/) });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {status, headers:{...corsHeaders,"Content-Type":"application/json"}});
Deno.serve(async req => {
  if (req.method !== "POST") return json({error:"Method not allowed"},405);
  if (!await secretMatches(req.headers.get("x-credentials-bridge"), Deno.env.get("CREDENTIALS_BRIDGE_SECRET"))) return json({error:"Unauthorized"},401);
  const parsed = schema.safeParse(await req.json().catch(()=>null));
  if (!parsed.success) return json({error:"Invalid request"},400);
  const key = Deno.env.get("CREDENTIALS_ENC_KEY");
  if (!key) return json({error:"Encryption unavailable"},503);
  try {
    const {operation,value,aad} = parsed.data;
    return json({value: await (operation === "encrypt" ? encryptSecret(value,key,aad) : decryptSecret(value,key,aad))});
  } catch { return json({error:"Credential cryptography failed"},500); }
});
