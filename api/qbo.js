export const config = { runtime: "edge" };

const QBO_BASE_SANDBOX = "https://sandbox-quickbooks.api.intuit.com/v3/company";
const QBO_BASE_PROD = "https://quickbooks.api.intuit.com/v3/company";

export default async function handler(req) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "https://tashaponelis-taylorhsl.github.io",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const { token, realmId, method, path, body, env } = await req.json();
    const base = env === "production" ? QBO_BASE_PROD : QBO_BASE_SANDBOX;

    // minorversion=75 required for QBO Advanced custom fields
    // include=enhancedAllCustomFields required to read/write Advanced custom fields
    const separator = path.includes("?") ? "&" : "?";
    let fullPath = `${path}${separator}minorversion=75`;

    // Add enhancedAllCustomFields for purchase and bill endpoints
    const isWriteToTransaction = (method === "POST" || method === "PUT") && 
      (path.includes("/purchase") || path.includes("/bill") || path.includes("/journalentry"));
    const isReadTransaction = method === "GET" && 
      (path.includes("/purchase") || path.includes("/bill") || path.includes("query"));
    
    if (isWriteToTransaction || isReadTransaction) {
      fullPath += "&include=enhancedAllCustomFields";
    }

    const url = `${base}/${realmId}${fullPath}`;
    console.log("QBO URL:", url);

    const fetchOpts = {
      method: method || "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
    };
    if (body) fetchOpts.body = JSON.stringify(body);

    const response = await fetch(url, fetchOpts);

    // Capture intuit_tid for troubleshooting
    const intuitTid = response.headers.get("intuit_tid") || 
                      response.headers.get("Intuit-Tid") || null;

    const data = await response.json();
    if (intuitTid) data._intuit_tid = intuitTid;

    if (!response.ok) {
      console.error(`QBO API Error: ${response.status} | intuit_tid: ${intuitTid} | path: ${path}`);
    }

    return new Response(JSON.stringify(data), { status: response.status, headers: corsHeaders });
  } catch (error) {
    console.error("QBO proxy error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
