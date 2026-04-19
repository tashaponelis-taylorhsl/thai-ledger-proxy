// api/history.js
// ─────────────────────────────────────────────────────────────────────────────
// Server-side paginated history for a client.
// Browser never receives the full history blob — only the requested page.
//
// Request:  POST { clientId, page, pageSize, filters, sort }
// Response: { records, total, page, pageSize, totalPages }
//
// filters: { dateFrom?, dateTo?, txType?, status?, search? }
//   dateFrom / dateTo: YYYY-MM-DD (applied to processedAt)
//   txType:  'Bill' | 'Expense' | 'Payment'  (omit or 'all' = no filter)
//   status:  'posted' (has qboId) | 'error' (no qboId)
//   search:  case-insensitive substring match on vendor / taxInvoiceNumber /
//            voucherNumber / fileName
//
// sort: { field: 'date'|'vendor'|'amount'|'docNumber', direction: 'asc'|'desc' }
//   Default: date desc (newest first)
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
  return body?.clientId ||
    body?.extractClientId ||
    (req.headers.get("CF-Connecting-IP")) ||
    (req.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// processHistory — pure function, no I/O dependencies.
// Exported for unit testing; also used by the handler below.
//
// recordsObj: Record<fileId, ProcessedFile> — the raw KV blob
// filters:    { dateFrom?, dateTo?, txType?, status?, search? }
// sort:       { field, direction }
// page:       1-based page number
// pageSize:   records per page
//
// Returns { records, total, page, pageSize, totalPages }
//   - If total === 0 → totalPages === 0
//   - If page > totalPages → records === [] (does NOT clamp to last page)
// ─────────────────────────────────────────────────────────────────────────────

export function processHistory(
  recordsObj,
  filters  = {},
  sort     = { field: "date", direction: "desc" },
  page     = 1,
  pageSize = 20,
) {
  // ── Normalise input ────────────────────────────────────────────────────────
  const rObj = (recordsObj && typeof recordsObj === "object" && !Array.isArray(recordsObj))
    ? recordsObj
    : {};

  // ── Convert Record<fileId, ProcessedFile> → array ─────────────────────────
  let records = Object.entries(rObj).map(([fileId, data]) => ({
    fileId,
    ...(data && typeof data === "object" ? data : {}),
  }));

  // ── Apply filters ─────────────────────────────────────────────────────────
  const { dateFrom, dateTo, txType, status, search } = filters;

  if (dateFrom) {
    const from = new Date(dateFrom);
    from.setUTCHours(0, 0, 0, 0);
    records = records.filter(r => new Date(r.processedAt || 0) >= from);
  }
  if (dateTo) {
    const to = new Date(dateTo);
    to.setUTCHours(23, 59, 59, 999);
    records = records.filter(r => new Date(r.processedAt || 0) <= to);
  }
  if (txType && txType !== "all") {
    records = records.filter(r => r.txType === txType);
  }
  if (status === "posted") {
    records = records.filter(r => !!r.qboId);
  } else if (status === "error") {
    records = records.filter(r => !r.qboId);
  }
  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    records = records.filter(r =>
      (r.vendor           || "").toLowerCase().includes(q) ||
      (r.taxInvoiceNumber || "").toLowerCase().includes(q) ||
      (r.voucherNumber    || "").toLowerCase().includes(q) ||
      (r.fileName         || "").toLowerCase().includes(q),
    );
  }

  // ── Apply sort ────────────────────────────────────────────────────────────
  const sortField     = sort.field     || "date";
  const sortDirection = sort.direction || "desc";
  const asc           = sortDirection === "asc";

  records.sort((a, b) => {
    let av, bv;
    switch (sortField) {
      case "vendor":
        av = (a.vendor || "").toLowerCase();
        bv = (b.vendor || "").toLowerCase();
        break;
      case "amount":
        av = Number(a.amount) || 0;
        bv = Number(b.amount) || 0;
        break;
      case "docNumber":
        av = (a.taxInvoiceNumber || a.voucherNumber || a.fileName || "").toLowerCase();
        bv = (b.taxInvoiceNumber || b.voucherNumber || b.fileName || "").toLowerCase();
        break;
      case "date":
      default:
        av = new Date(a.processedAt || 0).getTime();
        bv = new Date(b.processedAt || 0).getTime();
        break;
    }
    if (av < bv) return asc ? -1 : 1;
    if (av > bv) return asc ? 1 : -1;
    return 0;
  });

  // ── Paginate ──────────────────────────────────────────────────────────────
  const total      = records.length;
  const safeSize   = Math.max(1, Number(pageSize) || 20);
  // When total is 0 there are no pages — totalPages must be 0, not 1
  const totalPages = total === 0 ? 0 : Math.ceil(total / safeSize);
  const safePage   = Number(page) || 1;

  // Out-of-range page: return empty slice (do NOT clamp to last page)
  let pageSlice;
  if (total === 0 || safePage < 1 || safePage > totalPages) {
    pageSlice = [];
  } else {
    const start = (safePage - 1) * safeSize;
    pageSlice = records.slice(start, start + safeSize);
  }

  return {
    records:    pageSlice,
    total,
    page:       safePage,
    pageSize:   safeSize,
    totalPages,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge handler
// ─────────────────────────────────────────────────────────────────────────────

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
      clientId,
      page     = 1,
      pageSize = 20,
      filters  = {},
      sort     = { field: "date", direction: "desc" },
    } = body;

    const baseUrl = process.env.KV_REST_API_URL;
    const token   = process.env.KV_REST_API_TOKEN;

    if (!baseUrl || !token) {
      return new Response(
        JSON.stringify({ error: "KV not configured" }),
        { status: 500, headers: corsHeaders },
      );
    }

    // ── Rate limiting: 60 requests/min per clientId ───────────────────────────
    const identifier = getIdentifier(req, body);
    const rl = await checkRateLimit(baseUrl, token, `history:${identifier}`, 60, 60);
    if (rl.limited) {
      return new Response(JSON.stringify({
        error: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests. Please wait before retrying.",
        retryAfter: 60,
      }), { status: 429, headers: corsHeaders });
    }

    // ── Validation: clientId required ─────────────────────────────────────────
    if (!clientId) {
      return new Response(
        JSON.stringify({ error: "INVALID_REQUEST", message: "Missing required fields: clientId" }),
        { status: 400, headers: corsHeaders },
      );
    }

    // ── Read processed:{clientId} from KV ─────────────────────────────────────
    const kvRes = await fetch(
      `${baseUrl}/get/${encodeURIComponent(`processed:${clientId}`)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const kvData = await kvRes.json();

    // kv.js stores values with double-JSON-encoding (JSON.stringify(JSON.stringify(value)))
    // Unwrap until we have a plain object.
    let processed = kvData.result;
    if (typeof processed === "string") {
      try { processed = JSON.parse(processed); } catch { /* leave as-is */ }
    }
    if (typeof processed === "string") {
      try { processed = JSON.parse(processed); } catch { /* leave as-is */ }
    }

    // ── Delegate all logic to the pure function ────────────────────────────────
    const result = processHistory(processed, filters, sort, page, pageSize);

    return new Response(JSON.stringify(result), { headers: corsHeaders });

  } catch (error) {
    console.error("History endpoint error:", error.message);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: corsHeaders },
    );
  }
}
