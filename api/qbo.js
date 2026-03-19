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
    const url = `${base}/${realmId}${path}`;

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

    // Capture intuit_tid from response headers for troubleshooting
    const intuitTid = response.headers.get("intuit_tid") || 
                      response.headers.get("Intuit-Tid") || 
                      null;

    const data = await response.json();

    // Include intuit_tid in response for error logging
    if (intuitTid) data._intuit_tid = intuitTid;

    // Log errors with intuit_tid for troubleshooting
    if (!response.ok) {
      console.error(`QBO API Error: ${response.status} | intuit_tid: ${intuitTid} | path: ${path} | realmId: ${realmId}`);
    }

    return new Response(JSON.stringify(data), { status: response.status, headers: corsHeaders });
  } catch (error) {
    console.error("QBO proxy error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
