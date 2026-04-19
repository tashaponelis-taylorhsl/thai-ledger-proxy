// api/qbo-migrate.js
// ─────────────────────────────────────────────────────────────────────────────
// One-time migration endpoint.
//
// When the new app version first loads, existing connected clients have their
// tokens in localStorage/client-side KV.  The app calls this endpoint ONCE
// per client to move those tokens to server-side proxy KV storage.
//
// After a successful migration call the app clears the client-side tokens
// and never sends them to the proxy again.
//
// This endpoint is idempotent: calling it multiple times is safe.
//
// Request:  POST {
//   extractClientId,
//   accessToken,
//   refreshToken,
//   tokenExpiry,      // Unix timestamp in ms
//   qboClientId,
//   qboClientSecret,
//   realmId,
//   env
// }
// Response: { success: true } or { error: string }
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
    return { limited: false };
  }
}

// ── Identifier extraction ─────────────────────────────────────────────────────

function getIdentifier(req, body) {
  return body?.extractClientId ||
    body?.clientId ||
    (req.headers.get("CF-Connecting-IP")) ||
    (req.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tokenKey(extractClientId) {
  return `qbo_tokens:taylorhsl:${extractClientId}`;
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

  try {
    const body = await req.json();
    const {
      extractClientId,
      accessToken,
      refreshToken,
      tokenExpiry,
      qboClientId,
      qboClientSecret,
      realmId,
      env,
    } = body;

    const baseUrl  = process.env.KV_REST_API_URL;
    const kvToken  = process.env.KV_REST_API_TOKEN;

    // ── Rate limiting: 5 requests/min per extractClientId ────────────────────
    const identifier = getIdentifier(req, body);
    const rl = await checkRateLimit(baseUrl, kvToken, `qbo-migrate:${identifier}`, 5, 60);
    if (rl.limited) {
      return new Response(JSON.stringify({
        error: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests. Please wait before retrying.",
        retryAfter: 60,
      }), { status: 429, headers: corsHeaders });
    }

    // ── Validation: all token fields required ─────────────────────────────────
    if (!extractClientId || !accessToken || !refreshToken || !qboClientId || !qboClientSecret) {
      const missing = [];
      if (!extractClientId)  missing.push("extractClientId");
      if (!accessToken)       missing.push("accessToken");
      if (!refreshToken)      missing.push("refreshToken");
      if (!qboClientId)       missing.push("qboClientId");
      if (!qboClientSecret)   missing.push("qboClientSecret");
      return new Response(JSON.stringify({
        error: "INVALID_REQUEST",
        message: `Missing required fields: ${missing.join(", ")}`,
      }), { status: 400, headers: corsHeaders });
    }

    const key        = tokenKey(extractClientId);
    const kvHeaders  = { Authorization: `Bearer ${kvToken}`, "Content-Type": "application/json" };

    // Only migrate if proxy KV doesn't already have tokens for this client
    const existingRes = await fetch(`${baseUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });
    const existingData = await existingRes.json();
    if (existingData.result) {
      console.log(`[qbo-migrate] ${extractClientId} already has server-side tokens — skip`);
      return new Response(JSON.stringify({ success: true, skipped: true }), { headers: corsHeaders });
    }

    const record = {
      accessToken,
      refreshToken,
      tokenExpiry:          tokenExpiry || (Date.now() + 3_600_000),
      refreshTokenExpiry:   Date.now() + (100 * 24 * 60 * 60 * 1000),
      realmId:              realmId || "",
      qboClientId,
      qboClientSecret,
      env:                  env || "production",
      migratedAt:           new Date().toISOString(),
    };

    await fetch(`${baseUrl}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: kvHeaders,
      body: JSON.stringify(JSON.stringify(record)),
    });
    console.log(`[qbo-migrate] Tokens migrated for ${extractClientId}, realmId: ${realmId}`);

    return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
