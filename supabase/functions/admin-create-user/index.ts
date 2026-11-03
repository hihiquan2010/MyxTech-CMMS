import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const projectUrl = Deno.env.get("SUPABASE_URL");
const publishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!projectUrl || !publishableKey || !serviceRoleKey) {
  throw new Error("Missing required Supabase function secrets.");
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  if (origin && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  const headers = corsHeaders(origin);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405, headers });
  }
  if (origin && !allowedOrigins.includes(origin)) {
    return Response.json({ error: "Origin is not allowed." }, { status: 403, headers });
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return Response.json({ error: "Authentication required." }, { status: 401, headers });
  }

  const token = authorization.slice("Bearer ".length);
  const userClient = createClient(projectUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const adminClient = createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: authData, error: authError } = await userClient.auth.getUser(token);
  if (authError || !authData.user) {
    return Response.json({ error: "Invalid or expired session." }, { status: 401, headers });
  }
  const { data: caller, error: callerError } = await adminClient
    .from("profiles")
    .select("role,is_active")
    .eq("id", authData.user.id)
    .maybeSingle();
  if (callerError) {
    console.error("Could not verify admin profile:", callerError.message);
    return Response.json({ error: "Could not verify permissions." }, { status: 500, headers });
  }
  if (!caller?.is_active || caller.role !== "admin") {
    return Response.json({ error: "Administrator access required." }, { status: 403, headers });
  }

  let input: Record<string, unknown>;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON request." }, { status: 400, headers });
  }
  const fullName = typeof input.full_name === "string" ? input.full_name.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const role = input.role;
  const password = input.password;
  if (!fullName || fullName.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 || !["admin", "technician"].includes(String(role)) ||
      typeof password !== "string" || password.length < 12 || password.length > 256) {
    return Response.json({ error: "Invalid account details. Use a valid email and a password of at least 12 characters." }, { status: 400, headers });
  }

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (createError || !created.user) {
    return Response.json({ error: createError?.message || "Could not create account." }, { status: 400, headers });
  }

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .update({ full_name: fullName, role })
    .eq("id", created.user.id)
    .select("id,email,full_name,role,is_active,created_at")
    .maybeSingle();
  if (profileError || !profile) {
    const { error: cleanupError } = await adminClient.auth.admin.deleteUser(created.user.id);
    if (cleanupError) console.error("Failed to clean up incomplete user:", cleanupError.message);
    console.error("Could not initialize new user profile:", profileError?.message);
    return Response.json({ error: "Account creation did not complete; contact the administrator." }, { status: 500, headers });
  }

  return Response.json(profile, { status: 201, headers });
});
