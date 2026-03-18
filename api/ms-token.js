export const config = { runtime: "edge" };

export default async function handler(req) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "https://tashaponelis-taylorhsl.github.io",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const { clientId, tenantId, code, verifier, redirectUri, scopes } = await req.json();
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      scope: scopes,
    });
    const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await res.json();
    return new Response(JSON.stringify(data), { status: res.status, headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
