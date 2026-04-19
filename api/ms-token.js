// api/ms-token.js
// ─────────────────────────────────────────────────────────────────────────────
// Microsoft OAuth2 token exchange.
// Exchanges an authorization code + PKCE verifier for an MS Graph access token.
//
// Request:  POST { clientId, tenantId, code, verifier, redirectUri, scopes }
// Response: MS token response (access_token, refresh_token, etc.)
// ─────────────────────────────────────────────────────────────────────────────

export const config = { runtime: "edge" };

// ── Rate limiting (inlined — Edge runtime cannot import local files) ──────────

async function checkRateLimit(kvBaseUrl, kvToken, key, maxRequests, windowSeconds) {
  try {
    const rlKey   = `ratelimit:${key}`;
    const headers = { Authorization: `Bearer ${kvToken}`, "Content-Type": "application/json" };

    const incrRes  = await fetch(`${kvBaseUrl}/incr/${encodeURIComponent(rlKey)}`, { method: "POST", headers });
    const incrData = await incrRes.json();
    const count    = Number(incrData.result) || 1;

    if (count === 1) {
      await fetch(`${kvBaseUrl}/expire/${encodeURIComponent(rlKey)}/${windowSeconds}`, { method: "POST", headers });
    }

    return count > maxRequests ? { limited: true } : { limited: false };
  } catch {
    return { limited: false }; // fail open
  }
}

// ── Identifier extraction ─────────────────────────────────────────────────────

function getIdentifier(req, body) {
  return body?.clientId ||
    body?.extractClientId ||
    (req.headers.get("CF-Connecting-IP")) ||
    (req.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown";
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

export default async function handler(req) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "https://tashaponelis-taylorhsl.github.io",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { clientId, tenantId, code, verifier, redirectUri, scopes } = body;

    const kvBaseUrl = process.env.KV_REST_API_URL;
    const kvToken   = process.env.KV_REST_API_TOKEN;

    // ── Rate limiting: 10 requests/min per clientId ───────────────────────────
    const identifier = getIdentifier(req, body);
    const rl = await checkRateLimit(kvBaseUrl, kvToken, `ms-token:${identifier}`, 10, 60);
    if (rl.limited) {
      return new Response(JSON.stringify({
        error: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests. Please wait before retrying.",
        retryAfter: 60,
      }), { status: 429, headers: corsHeaders });
    }

    // ── Validation: code, redirectUri, clientId, tenantId all required ────────
    if (!code || !redirectUri || !clientId || !tenantId) {
      const missing = [];
      if (!code)        missing.push("code");
      if (!redirectUri) missing.push("redirectUri");
      if (!clientId)    missing.push("clientId");
      if (!tenantId)    missing.push("tenantId");
      return new Response(JSON.stringify({
        error: "INVALID_REQUEST",
        message: `Missing required fields: ${missing.join(", ")}`,
      }), { status: 400, headers: corsHeaders });
    }

    const tokenBody = new URLSearchParams({
      client_id:     clientId,
      grant_type:    "authorization_code",
      code:          code,
      redirect_uri:  redirectUri,
      code_verifier: verifier,
      scope:         scopes,
    });

    const res = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenBody.toString(),
      }
    );

    const data = await res.json();
    return new Response(JSON.stringify(data), { status: res.status, headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
