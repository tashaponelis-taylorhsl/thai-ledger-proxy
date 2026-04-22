// api/qbo-attach.js
// ─────────────────────────────────────────────────────────────────────────────
// Attaches a PDF to a QBO transaction.
//
// New format: { extractClientId, fileData, fileName, entityType, entityId, env }
// Legacy:     { token, realmId, fileData, fileName, entityType, entityId, env }
// ─────────────────────────────────────────────────────────────────────────────

export const config = { runtime: "edge" };

const INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

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

async function getValidToken(extractClientId) {
  const record = await kvGet(tokenKey(extractClientId));
  if (!record) {
    throw { code: "QBO_AUTH_EXPIRED", message: "No QuickBooks tokens found — please reconnect in Settings." };
  }

  // Self-heal: strip credential fields that may exist in old KV records written
  // before this security fix. Re-save the clean record so the fields disappear.
  let cleanRecord = record;
  if (record.qboClientId || record.qboClientSecret) {
    const { qboClientId: _cid, qboClientSecret: _cs, ...withoutCreds } = record;
    cleanRecord = withoutCreds;
    await kvSet(tokenKey(extractClientId), cleanRecord);
  }

  const { accessToken, refreshToken, tokenExpiry, realmId } = cleanRecord;

  const needsRefresh = !accessToken || !tokenExpiry || Date.now() > tokenExpiry - 60_000;
  if (!needsRefresh) {
    return { accessToken, realmId };
  }

  // Read credentials from env vars — never from the KV record
  const qboClientId = process.env.QBO_CLIENT_ID;
  const qboClientSecret = process.env.QBO_CLIENT_SECRET;

  if (!refreshToken || !qboClientId || !qboClientSecret) {
    throw { code: "QBO_AUTH_EXPIRED", message: "Token refresh failed — please reconnect QuickBooks." };
  }

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
    ...cleanRecord,  // already has no credential fields
    accessToken:  data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    tokenExpiry:  Date.now() + ((data.expires_in || 3600) * 1000),
    // Reset refreshTokenExpiry only when Intuit issues a new refresh token
    ...(data.refresh_token && {
      refreshTokenExpiry: Date.now() + (100 * 24 * 60 * 60 * 1000),
    }),
  };
  await kvSet(tokenKey(extractClientId), newRecord);

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
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const { extractClientId, token: legacyToken, realmId: legacyRealmId, fileData, fileName, entityType, entityId, env } = body;

    // ── Rate limiting: 30 requests/min per clientId ───────────────────────────
    const kvBaseUrl  = process.env.KV_REST_API_URL;
    const kvToken    = process.env.KV_REST_API_TOKEN;
    const identifier = getIdentifier(req, body);
    const rl = await checkRateLimit(kvBaseUrl, kvToken, `qbo-attach:${identifier}`, 30, 60);
    if (rl.limited) {
      return new Response(JSON.stringify({
        error: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests. Please wait before retrying.",
        retryAfter: 60,
      }), { status: 429, headers: corsHeaders });
    }

    // ── Validation: (extractClientId OR token) AND fileData AND fileName AND entityType AND entityId ──
    const hasIdentifier = !!extractClientId || !!legacyToken;
    if (!hasIdentifier || !fileData || !fileName || !entityType || !entityId) {
      const missing = [];
      if (!hasIdentifier)  missing.push("extractClientId (or token)");
      if (!fileData)        missing.push("fileData");
      if (!fileName)        missing.push("fileName");
      if (!entityType)      missing.push("entityType");
      if (!entityId)        missing.push("entityId");
      return new Response(JSON.stringify({
        error: "INVALID_REQUEST",
        message: `Missing required fields: ${missing.join(", ")}`,
      }), { status: 400, headers: corsHeaders });
    }

    const base = env === "production"
      ? "https://quickbooks.api.intuit.com/v3/company"
      : "https://sandbox-quickbooks.api.intuit.com/v3/company";

    let accessToken, realmId;

    // ── New server-side token lookup ──────────────────────────────────────────
    if (extractClientId) {
      try {
        const tokenData = await getValidToken(extractClientId);
        accessToken = tokenData.accessToken;
        realmId     = tokenData.realmId;
      } catch (err) {
        if (err.code === "QBO_AUTH_EXPIRED") {
          return new Response(JSON.stringify({ Fault: { Error: [{ Message: err.message }] } }), { headers: corsHeaders });
        }
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
      }
    }

    // ── Legacy: token sent by browser (backward compat) ───────────────────────
    if (!accessToken && legacyToken) {
      accessToken = legacyToken;
      realmId     = legacyRealmId;
    }

    if (!accessToken || !realmId) {
      return new Response(JSON.stringify({ error: "Missing token/extractClientId or realmId" }), { status: 400, headers: corsHeaders });
    }

    // Decode base64 file (Edge-compatible: atob + Uint8Array)
    const binaryStr = atob(fileData);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    const boundary = "----ExtractBoundary" + Date.now();
    const metaJson = JSON.stringify({
      AttachableRef: [{ EntityRef: { type: entityType, value: entityId } }],
      ContentType: "application/pdf",
      FileName: fileName,
    });

    // Build multipart body (Edge-compatible: TextEncoder + Uint8Array)
    const encoder = new TextEncoder();
    const metaPart = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file_metadata_01"\r\nContent-Type: application/json\r\n\r\n${metaJson}\r\n`);
    const filePart = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file_content_01"; filename="${fileName}"\r\nContent-Type: application/pdf\r\n\r\n`);
    const endPart  = encoder.encode(`\r\n--${boundary}--`);

    const combined = new Uint8Array(metaPart.length + filePart.length + bytes.length + endPart.length);
    combined.set(metaPart, 0);
    combined.set(filePart, metaPart.length);
    combined.set(bytes,    metaPart.length + filePart.length);
    combined.set(endPart,  metaPart.length + filePart.length + bytes.length);

    const response = await fetch(`${base}/${realmId}/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        Accept: "application/json",
      },
      body: combined,
    });
    const data = await response.json();
    return new Response(JSON.stringify(data), { status: response.status, headers: corsHeaders });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
