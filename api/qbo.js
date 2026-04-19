// api/qbo.js
// ─────────────────────────────────────────────────────────────────────────────
// QBO API proxy.
//
// Security model (new):
//   Browser sends { extractClientId, env, method, path, body? }
//   getValidToken() looks up stored tokens from proxy KV, auto-refreshes if
//   needed, and returns a fresh accessToken — never sent to browser.
//
// Backward compatibility:
//   If request includes { token, realmId } (old format), use them directly
//   so existing connected clients keep working while the one-time migration runs.
// ─────────────────────────────────────────────────────────────────────────────

export const config = { runtime: "edge" };

const QBO_BASE_SANDBOX = "https://sandbox-quickbooks.api.intuit.com/v3/company";
const QBO_BASE_PROD    = "https://quickbooks.api.intuit.com/v3/company";
const INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

// ── Rate limiting (inlined — Edge runtime cannot import local files) ──────────
// key format: ratelimit:{endpoint}:{identifier}
// Uses KV INCR + EXPIRE via Upstash REST API.
// Fails open on KV error — never blocks requests due to rate-limit infra failure.

async function checkRateLimit(kvBaseUrl, kvToken, key, maxRequests, windowSeconds) {
  try {
    const rlKey   = `ratelimit:${key}`;
    const headers = { Authorization: `Bearer ${kvToken}`, "Content-Type": "application/json" };

    const incrRes  = await fetch(`${kvBaseUrl}/incr/${encodeURIComponent(rlKey)}`, { method: "POST", headers });
    const incrData = await incrRes.json();
    const count    = Number(incrData.result) || 1;

    // Set TTL only on the first request in the window
    if (count === 1) {
      await fetch(`${kvBaseUrl}/expire/${encodeURIComponent(rlKey)}/${windowSeconds}`, { method: "POST", headers });
    }

    return count > maxRequests ? { limited: true } : { limited: false };
  } catch {
    return { limited: false }; // fail open
  }
}

// ── Request validation (inlined) ──────────────────────────────────────────────

function validateRequest(body, requiredFields) {
  const missing = requiredFields.filter(f => body[f] === undefined || body[f] === null || body[f] === "");
  return missing.length > 0 ? { valid: false, missing } : { valid: true };
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

// ── Token lookup + auto-refresh ───────────────────────────────────────────────
// Returns { accessToken, realmId }.
// Throws { code: "QBO_AUTH_EXPIRED", message } if tokens missing or unrefreshable.

async function getValidToken(extractClientId) {
  console.log('[getValidToken] looking up key:', tokenKey(extractClientId));
  const record = await kvGet(tokenKey(extractClientId));
  console.log('[getValidToken] record found:', !!record);
  console.log('[getValidToken] record keys:', record ? Object.keys(record) : 'null');
  if (!record) {
    throw { code: "QBO_AUTH_EXPIRED", message: "No QuickBooks tokens found — please reconnect in Settings." };
  }

  const { accessToken, refreshToken, tokenExpiry, qboClientId, qboClientSecret, realmId } = record;

  // Return cached token if it has more than 60 seconds of life left
  const needsRefresh = !accessToken || !tokenExpiry || Date.now() > tokenExpiry - 60_000;
  if (!needsRefresh) {
    return { accessToken, realmId };
  }

  if (!refreshToken || !qboClientId || !qboClientSecret) {
    throw { code: "QBO_AUTH_EXPIRED", message: "Stored credentials incomplete — please reconnect QuickBooks." };
  }

  // Refresh the access token
  const credentials = btoa(`${qboClientId}:${qboClientSecret}`);
  const refreshRes = await fetch(INTUIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  const data = await refreshRes.json();
  if (data.error) {
    throw { code: "QBO_AUTH_EXPIRED", message: `Token refresh failed: ${data.error}. Please reconnect QuickBooks in Settings.` };
  }

  const newRecord = {
    ...record,
    accessToken:  data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    tokenExpiry:  Date.now() + ((data.expires_in || 3600) * 1000),
    // Reset refreshTokenExpiry only when Intuit issues a new refresh token
    ...(data.refresh_token && {
      refreshTokenExpiry: Date.now() + (100 * 24 * 60 * 60 * 1000),
    }),
  };
  await kvSet(tokenKey(extractClientId), newRecord);
  console.log(`[qbo] Token refreshed for ${extractClientId}`);

  return { accessToken: newRecord.accessToken, realmId: newRecord.realmId };
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
    const { extractClientId, token: legacyToken, realmId: legacyRealmId, method, path, env } = body;

    // ── Rate limiting: 100 requests/min per clientId ──────────────────────────
    const kvBaseUrl = process.env.KV_REST_API_URL;
    const kvToken   = process.env.KV_REST_API_TOKEN;
    const identifier = getIdentifier(req, body);
    const rl = await checkRateLimit(kvBaseUrl, kvToken, `qbo:${identifier}`, 100, 60);
    if (rl.limited) {
      return new Response(JSON.stringify({
        error: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests. Please wait before retrying.",
        retryAfter: 60,
      }), { status: 429, headers: corsHeaders });
    }

    // ── Validation: extractClientId OR (token AND realmId) ────────────────────
    const hasNewFormat    = !!extractClientId;
    const hasLegacyFormat = !!legacyToken && !!legacyRealmId;
    if (!hasNewFormat && !hasLegacyFormat) {
      return new Response(JSON.stringify({
        error: "INVALID_REQUEST",
        message: "Missing required fields: extractClientId (or legacy token + realmId)",
      }), { status: 400, headers: corsHeaders });
    }

    const base = env === "production" ? QBO_BASE_PROD : QBO_BASE_SANDBOX;

    let accessToken, realmId;

    // ── New server-side token lookup ──────────────────────────────────────────
    if (extractClientId) {
      try {
        const tokenData = await getValidToken(extractClientId);
        accessToken = tokenData.accessToken;
        realmId     = tokenData.realmId;
      } catch (err) {
        if (err.code === "QBO_AUTH_EXPIRED") {
          return new Response(JSON.stringify({
            error:   "QBO_AUTH_EXPIRED",
            message: err.message,
            Fault:   { Error: [{ Message: err.message, code: "QBO_AUTH_EXPIRED" }] },
          }), { headers: corsHeaders });
        }
        console.error("[qbo] getValidToken error:", err);
        return new Response(JSON.stringify({ error: "Token lookup failed", message: String(err) }), { status: 500, headers: corsHeaders });
      }
    }

    // ── Legacy: token sent by browser (backward compat) ───────────────────────
    if (!accessToken && legacyToken) {
      accessToken = legacyToken;
      realmId     = legacyRealmId;
    }

    if (!accessToken || !realmId) {
      return new Response(JSON.stringify({ error: "Missing extractClientId or legacy token/realmId" }), { status: 400, headers: corsHeaders });
    }

    // ── Build QBO URL — minorversion=75 for custom fields support ─────────────
    const separator = path.includes("?") ? "&" : "?";
    let fullPath = `${path}${separator}minorversion=75`;

    // enhancedAllCustomFields only for direct purchase/bill reads — NOT queries (causes 404)
    const isPurchasePath = path.match(/^\/(purchase|bill)(\/\d+)?$/i);
    if (isPurchasePath) {
      fullPath += "&include=enhancedAllCustomFields";
    }

    const url = `${base}/${realmId}${fullPath}`;
    const fetchOpts = {
      method: method || "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };
    if (body.body) fetchOpts.body = JSON.stringify(body.body);

    const response = await fetch(url, fetchOpts);

    // Capture Intuit transaction ID for debugging
    const intuitTid = response.headers.get("intuit_tid") ||
                      response.headers.get("Intuit-Tid") || null;

    const data = await response.json();
    if (intuitTid) data._intuit_tid = intuitTid;

    if (!response.ok) {
      console.error(`QBO API Error: ${response.status} | intuit_tid: ${intuitTid} | path: ${path}`);
    }

    // Detect 401 from QBO itself — surface as QBO_AUTH_EXPIRED
    if (response.status === 401 || data?.fault?.error?.[0]?.code === "3200") {
      return new Response(JSON.stringify({
        error:   "QBO_AUTH_EXPIRED",
        message: "QuickBooks session expired. Please reconnect in Settings.",
        Fault:   { Error: [{ Message: "QuickBooks session expired.", code: "QBO_AUTH_EXPIRED" }] },
      }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify(data), { status: response.status, headers: corsHeaders });

  } catch (error) {
    console.error("QBO proxy error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
