// api/qbo-token.js
// ─────────────────────────────────────────────────────────────────────────────
// QBO token exchange and server-side storage.
//
// Security model:
//   QBO_CLIENT_ID and QBO_CLIENT_SECRET are read exclusively from Vercel env
//   vars. The browser MUST NOT send clientId or clientSecret in the request
//   body — the new flow rejects such requests with 400.
//   Tokens are stored in Vercel KV under "qbo_tokens:taylorhsl:{extractClientId}".
//   No credentials are written into the KV record.
//
// New format:  POST { code, extractClientId, realmId, env, redirectUri }
// Legacy flow: POST { code, clientId, clientSecret, redirectUri }  (no extractClientId)
//              POST { grantType: "refresh_token", refreshToken, clientId, clientSecret }
//
// Backward compatibility: legacy flows still return tokens directly so any
// remaining old connected clients keep working. Remove in a later cleanup step.
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

    // Destructure all expected fields. clientId and clientSecret are kept only
    // for the legacy flows (code without extractClientId, or refresh_token grant).
    const {
      code, redirectUri, refreshToken, grantType, extractClientId, realmId, env,
      clientId: legacyClientId, clientSecret: legacyClientSecret,
    } = body;

    // ── Security: reject new-flow requests that erroneously include credentials ──
    // The new flow reads credentials from env vars — the browser must not send them.
    if (extractClientId && (legacyClientId || legacyClientSecret)) {
      return new Response(JSON.stringify({
        error: "CREDENTIALS_IN_REQUEST",
        message: "QBO credentials must not be sent from the client. The server reads them from environment variables.",
      }), { status: 400, headers: corsHeaders });
    }

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

    // ── Validation ────────────────────────────────────────────────────────────
    const hasNewCodeFlow     = !!(code && extractClientId);
    const hasLegacyCodeFlow  = !!(code && !extractClientId && legacyClientId && legacyClientSecret);
    const hasRefreshFlow     = !!(grantType === "refresh_token" && refreshToken);

    if (!hasNewCodeFlow && !hasLegacyCodeFlow && !hasRefreshFlow) {
      return new Response(JSON.stringify({
        error: "INVALID_REQUEST",
        message: "Provide (code + extractClientId) or legacy (code + clientId + clientSecret) or (grantType='refresh_token' + refreshToken)",
      }), { status: 400, headers: corsHeaders });
    }

    // ── New server-side flow: read credentials from env vars ──────────────────
    if (hasNewCodeFlow) {
      const qboClientId = process.env.QBO_CLIENT_ID;
      const qboClientSecret = process.env.QBO_CLIENT_SECRET;

      if (!qboClientId || !qboClientSecret) {
        return new Response(JSON.stringify({
          error: "QBO_CREDENTIALS_NOT_CONFIGURED",
          message: "QBO credentials not configured on server — set QBO_CLIENT_ID and QBO_CLIENT_SECRET env vars",
        }), { status: 500, headers: corsHeaders });
      }

      const environment = env || "production";
      const redirect = environment === "production" ? REDIRECT_URI_PROD : REDIRECT_URI_DEV;
      const credentials = btoa(`${qboClientId}:${qboClientSecret}`);

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

      // Store tokens server-side — never return them to the browser.
      // Credentials are intentionally NOT written into the KV record;
      // they are always read from env vars at refresh time.
      const record = {
        accessToken:        data.access_token,
        refreshToken:       data.refresh_token,
        tokenExpiry:        Date.now() + ((data.expires_in || 3600) * 1000),
        refreshTokenExpiry: Date.now() + (100 * 24 * 60 * 60 * 1000),
        realmId:            realmId || "",
        env:                environment,
      };
      await kvSet(tokenKey(extractClientId), record);
      console.log(`[qbo-token] Tokens stored server-side for ${extractClientId}, realmId: ${realmId}`);

      return new Response(JSON.stringify({ success: true, realmId: realmId || "" }), { headers: corsHeaders });
    }

    // ── Legacy flow: authorization code exchange (returns tokens to browser) ──
    // Used by old app versions without extractClientId. Remove once all migrated.
    if (hasLegacyCodeFlow) {
      const credentials = btoa(`${legacyClientId}:${legacyClientSecret}`);
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
    if (hasRefreshFlow) {
      const credentials = btoa(`${legacyClientId}:${legacyClientSecret}`);
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
