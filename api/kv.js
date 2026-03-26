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

    let url, body, method;

    switch (action) {
      case "get":
        url = `${baseUrl}/get/${encodeURIComponent(key)}`;
        method = "GET";
        break;
      case "set":
        url = `${baseUrl}/set/${encodeURIComponent(key)}`;
        method = "POST";
        body = JSON.stringify(value);
        break;
      case "del":
        url = `${baseUrl}/del/${encodeURIComponent(key)}`;
        method = "POST";
        break;
      case "keys":
        url = `${baseUrl}/keys/${encodeURIComponent(key)}*`;
        method = "GET";
        break;
      default:
        return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers: corsHeaders });
    }

    const response = await fetch(url, {
      method,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body } : {}),
    });

    const data = await response.json();
    return new Response(JSON.stringify(data), { status: response.status, headers: corsHeaders });

  } catch (error) {
    console.error("KV error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
