// api/qbo-token.js
// ─────────────────────────────────────────────────────────────────────────────
// QBO token exchange and server-side storage.
//
// Security model:
//   Tokens are stored in Vercel KV under "qbo_tokens:taylorhsl:{extractClientId}".
//   They are NEVER returned to the browser.  The browser only ever receives
//   { success: true, realmId } on initial connect.
//
// New format:  POST { code, clientId, clientSecret, redirectUri, extractClientId, realmId, env }
// Legacy flow: POST { code, clientId, clientSecret, redirectUri }  (no extractClientId)
//              POST { grantType: "refresh_token", refreshToken, clientId, clientSecret }
//
// Backward compatibility: legacy flows still return tokens directly so old
// connected clients keep working until the one-time migration runs.
// ─────────────────────────────────────────────────────────────────────────────

export const config = { runtime: "edge" };

const INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REDIRECT_URI_PROD = "https://tashaponelis-taylorhsl.github.io/Extract/";
const REDIRECT_URI_DEV  = "https://tashaponelis-taylorhsl.github.io/Extract-Dev/";

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

// ── KV helpers (Upstash REST API — Edge-compatible) ───────────────────────────

function tokenKey(extractClientId) {
  return `qbo_tokens:taylorhsl:${extractClientId}`;
}

async function kvGet(key) {
  const baseUrl = process.env.KV_REST_API_URL;
  const token   = process.env.KV_REST_API_TOKEN;
  const res = await fetch(`${baseUrl}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!data.result) return null;

  // Handle single, double, or triple encoded JSON
  let value = data.result;
  while (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  return value;
}

async function kvSet(key, value) {
  const baseUrl = process.env.KV_REST_API_URL;
  const token   = process.env.KV_REST_API_TOKEN;
  await fetch(`${baseUrl}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(JSON.stringify(value)),
  });
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

export default async function handler(req) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "https://tashaponelis-taylorhsl.github.io",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const { code, clientId, clientSecret, redirectUri, refreshToken, grantType, extractClientId, realmId, env } = body;

    const kvBaseUrl = process.env.KV_REST_API_URL;
    const kvToken   = process.env.KV_REST_API_TOKEN;

    // ── Rate limiting: 10 requests/min per clientId ───────────────────────────
    const identifier = getIdentifier(req, body);
    const rl = await checkRateLimit(kvBaseUrl, kvToken, `qbo-token:${identifier}`, 10, 60);
    if (rl.limited) {
      return new Response(JSON.stringify({
        error: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests. Please wait before retrying.",
        retryAfter: 60,
      }), { status: 429, headers: corsHeaders });
    }

    // ── Validation: (code AND clientId AND clientSecret) OR (grantType AND refreshToken) ──
    const hasCodeFlow    = !!(code && clientId && clientSecret);
    const hasRefreshFlow = !!(grantType === "refresh_token" && refreshToken);
    if (!hasCodeFlow && !hasRefreshFlow) {
      return new Response(JSON.stringify({
        error: "INVALID_REQUEST",
        message: "Missing required fields: provide (code + clientId + clientSecret) or (grantType='refresh_token' + refreshToken)",
      }), { status: 400, headers: corsHeaders });
    }

    const credentials = btoa(`${clientId}:${clientSecret}`);

    // ── New server-side flow: exchange code and store tokens in KV ────────────
    if (code && extractClientId) {
      const environment = env || "production";
      const redirect = environment === "production" ? REDIRECT_URI_PROD : REDIRECT_URI_DEV;

      const response = await fetch(INTUIT_TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type:   "authorization_code",
          code,
          redirect_uri: redirectUri || redirect,
        }),
      });
      const data = await response.json();
      if (data.error) {
        return new Response(JSON.stringify({ error: data.error }), { status: 400, headers: corsHeaders });
      }

      // Store tokens server-side — never return them to the browser
      const record = {
        accessToken:          data.access_token,
        refreshToken:         data.refresh_token,
        tokenExpiry:          Date.now() + ((data.expires_in || 3600) * 1000),
        refreshTokenExpiry:   Date.now() + (100 * 24 * 60 * 60 * 1000),
        realmId:              realmId || "",
        qboClientId:          clientId,
        qboClientSecret:      clientSecret,
        env:                  environment,
      };
      await kvSet(tokenKey(extractClientId), record);
      console.log(`[qbo-token] Tokens stored server-side for ${extractClientId}, realmId: ${realmId}`);

      // Return only non-sensitive data to browser
      return new Response(JSON.stringify({ success: true, realmId: realmId || "" }), { headers: corsHeaders });
    }

    // ── Legacy flow: authorization code exchange (returns tokens to browser) ──
    // Used by old app versions without extractClientId. Remove once all migrated.
    if (code && !extractClientId) {
      const response = await fetch(INTUIT_TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type:   "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
      });
      const data = await response.json();
      return new Response(JSON.stringify(data), { status: response.status, headers: corsHeaders });
    }

    // ── Legacy flow: refresh token (returns new tokens to browser) ────────────
    if (grantType === "refresh_token") {
      const response = await fetch(INTUIT_TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type:    "refresh_token",
          refresh_token: refreshToken,
        }),
      });
      const data = await response.json();
      return new Response(JSON.stringify(data), { status: response.status, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "INVALID_REQUEST", message: "Unrecognised request format" }), { status: 400, headers: corsHeaders });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
