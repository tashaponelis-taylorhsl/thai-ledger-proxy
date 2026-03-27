export const config = { runtime: "edge" };

export default async function handler(req) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "https://tashaponelis-taylorhsl.github.io",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const { action, key, value } = await req.json();
    const baseUrl = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;

    if (!baseUrl || !token) {
      return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers: corsHeaders });
    }

    const headers = {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    let response;

    switch (action) {
      case "get":
        response = await fetch(`${baseUrl}/get/${encodeURIComponent(key)}`, {
          method: "GET", headers,
        });
        break;

      case "set":
        // Store value as JSON string directly - no extra wrapping
        response = await fetch(`${baseUrl}/set/${encodeURIComponent(key)}`, {
          method: "POST", headers,
          body: JSON.stringify(JSON.stringify(value)),
        });
        break;

      case "del":
        response = await fetch(`${baseUrl}/del/${encodeURIComponent(key)}`, {
          method: "POST", headers,
        });
        break;

      default:
        return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers: corsHeaders });
    }

    const data = await response.json();
    return new Response(JSON.stringify(data), { status: response.status, headers: corsHeaders });

  } catch (error) {
    console.error("KV error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
