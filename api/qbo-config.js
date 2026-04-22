// api/qbo-config.js
// ─────────────────────────────────────────────────────────────────────────────
// Returns the QBO OAuth Client ID to the browser so it can build the
// Intuit consent-screen redirect URL.
//
// The Client ID is public per the OAuth 2.0 spec — only the Client Secret
// must remain server-side. This endpoint intentionally returns no secret.
//
// Required Vercel env var: QBO_CLIENT_ID
// ─────────────────────────────────────────────────────────────────────────────

export const config = { runtime: "edge" };

export default async function handler(req) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "https://tashaponelis-taylorhsl.github.io",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  const clientId = process.env.QBO_CLIENT_ID;
  if (!clientId) {
    return new Response(
      JSON.stringify({ error: "QBO_CLIENT_ID not configured on server — contact your administrator" }),
      { status: 500, headers: corsHeaders },
    );
  }

  return new Response(JSON.stringify({ clientId }), { status: 200, headers: corsHeaders });
}
