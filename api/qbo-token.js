export const config = { runtime: "edge" };

export default async function handler(req) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "https://tashaponelis-taylorhsl.github.io",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { code, clientId, clientSecret, redirectUri, refreshToken, grantType } = await req.json();
    const credentials = btoa(`${clientId}:${clientSecret}`);

    let body;
    if (grantType === "refresh_token") {
      // Refresh token grant
      body = new URLSearchParams({ 
        grant_type: "refresh_token", 
        refresh_token: refreshToken 
      });
    } else {
      // Authorization code grant
      body = new URLSearchParams({ 
        grant_type: "authorization_code", 
        code, 
        redirect_uri: redirectUri 
      });
    }

    const response = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
      method: "POST",
      headers: { 
        "Authorization": `Basic ${credentials}`, 
        "Content-Type": "application/x-www-form-urlencoded", 
        "Accept": "application/json" 
      },
      body,
    });

    const data = await response.json();
    return new Response(JSON.stringify(data), { status: response.status, headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
