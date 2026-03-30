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
    const { image } = await req.json(); // base64 image
    const apiKey = process.env.GOOGLE_VISION_API_KEY;

    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Google Vision API key not configured" }), { status: 500, headers: corsHeaders });
    }

    const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{
          image: { content: image },
          features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }],
          imageContext: { languageHints: ["th", "en"] } // Thai + English
        }]
      })
    });

    const data = await response.json();
    
    if (data.error) {
      return new Response(JSON.stringify({ error: data.error.message }), { status: 400, headers: corsHeaders });
    }

    // Extract full text from response
    const fullText = data.responses?.[0]?.fullTextAnnotation?.text || "";
    
    return new Response(JSON.stringify({ text: fullText }), { status: 200, headers: corsHeaders });

  } catch (error) {
    console.error("Vision error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
