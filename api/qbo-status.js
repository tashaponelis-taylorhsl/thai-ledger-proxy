// api/qbo-status.js
// ─────────────────────────────────────────────────────────────────────────────
// Returns QuickBooks connection status for a client.
// NEVER returns tokens — only status and metadata.
//
// Request:  POST { extractClientId }
// Response: { connected: boolean, realmId?: string, expiresAt?: number }
//
// The access token (1 hour) is auto-refreshed silently by the proxy.
// Only the Intuit refresh token (100 days) matters for "needs reconnect".
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
    const { extractClientId } = body;

    const baseUrl = process.env.KV_REST_API_URL;
    const token   = process.env.KV_REST_API_TOKEN;

    // ── Rate limiting: 30 requests/min per extractClientId ───────────────────
    const identifier = getIdentifier(req, body);
    const rl = await checkRateLimit(baseUrl, token, `qbo-status:${identifier}`, 30, 60);
    if (rl.limited) {
      return new Response(JSON.stringify({
        error: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests. Please wait before retrying.",
        retryAfter: 60,
      }), { status: 429, headers: corsHeaders });
    }

    // ── Validation: extractClientId required ──────────────────────────────────
    if (!extractClientId) {
      return new Response(JSON.stringify({
        error: "INVALID_REQUEST",
        message: "Missing required fields: extractClientId",
      }), { status: 400, headers: corsHeaders });
    }

    const kvRes = await fetch(`${baseUrl}/get/${encodeURIComponent(tokenKey(extractClientId))}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const kvData = await kvRes.json();

    if (!kvData.result) {
      return new Response(JSON.stringify({ connected: false }), { headers: corsHeaders });
    }

    const record = typeof kvData.result === "string" ? JSON.parse(kvData.result) : kvData.result;
    const connected = !!(record.accessToken && record.refreshToken);
    const expiresAt = record.refreshTokenExpiry || null;

    return new Response(JSON.stringify({
      connected,
      realmId:   record.realmId || null,
      expiresAt,
    }), { headers: corsHeaders });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
