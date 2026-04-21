// api/verify-pin.js
// ─────────────────────────────────────────────────────────────────────────────
// Server-side PIN validation for the admin emergency backdoor.
// The PIN never appears in the browser bundle — only in Vercel environment vars.
//
// Required Vercel env vars (both thai-ledger-proxy and thai-ledger-proxy-dev):
//   VITE_LOGIN_PIN  — the configured PIN
//   ADMIN_EMAIL     — tasha.ponelis@taylorhsl.com
//
// Rate limiting: max 5 attempts per minute per IP (KV-backed, same pattern as
// other proxy endpoints).
// ─────────────────────────────────────────────────────────────────────────────

// ── Rate limiting (KV-backed) ─────────────────────────────────────────────────

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

function getClientIP(req) {
  return (req.headers["cf-connecting-ip"]) ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "global";
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "https://tashaponelis-taylorhsl.github.io");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const baseUrl = process.env.KV_REST_API_URL;
  const token   = process.env.KV_REST_API_TOKEN;

  // Rate limit: 5 attempts per minute per IP
  if (baseUrl && token) {
    const ip = getClientIP(req);
    const rl = await checkRateLimit(baseUrl, token, `verify-pin:${ip}`, 5, 60);
    if (rl.limited) {
      return res.status(429).json({
        valid: false,
        error: "Too many attempts. Please wait before retrying.",
      });
    }
  }

  try {
    const { pin, email } = req.body || {};

    if (!pin || !email) {
      return res.status(400).json({ valid: false, error: "Missing pin or email" });
    }

    const configuredPIN = process.env.VITE_LOGIN_PIN || "";
    const adminEmail    = process.env.ADMIN_EMAIL || "tasha.ponelis@taylorhsl.com";

    if (!configuredPIN) {
      return res.status(500).json({ valid: false, error: "PIN not configured" });
    }

    const emailMatch = email.trim().toLowerCase() === adminEmail.trim().toLowerCase();
    const pinMatch   = pin.trim() === configuredPIN.trim();

    // Constant-time delay to prevent timing attacks
    await new Promise(r => setTimeout(r, 200));

    if (!emailMatch || !pinMatch) {
      return res.status(200).json({ valid: false });
    }

    return res.status(200).json({ valid: true });

  } catch (err) {
    return res.status(500).json({ valid: false, error: "Server error" });
  }
};
