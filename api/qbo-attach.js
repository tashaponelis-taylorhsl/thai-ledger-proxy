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
    const { token, realmId, fileData, fileName, entityType, entityId, env } = await req.json();
    const base = env === "production"
      ? "https://quickbooks.api.intuit.com/v3/company"
      : "https://sandbox-quickbooks.api.intuit.com/v3/company";

    // Decode base64 file
    const binaryStr = atob(fileData);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    const boundary = "----ExtractBoundary" + Date.now();
    const metaJson = JSON.stringify({
      AttachableRef: [{ EntityRef: { type: entityType, value: entityId } }],
      ContentType: "application/pdf",
      FileName: fileName,
    });

    // Build multipart body
    const encoder = new TextEncoder();
    const metaPart = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file_metadata_01"\r\nContent-Type: application/json\r\n\r\n${metaJson}\r\n`);
    const filePart = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file_content_01"; filename="${fileName}"\r\nContent-Type: application/pdf\r\n\r\n`);
    const endPart = encoder.encode(`\r\n--${boundary}--`);

    const combined = new Uint8Array(metaPart.length + filePart.length + bytes.length + endPart.length);
    combined.set(metaPart, 0);
    combined.set(filePart, metaPart.length);
    combined.set(bytes, metaPart.length + filePart.length);
    combined.set(endPart, metaPart.length + filePart.length + bytes.length);

    const response = await fetch(`${base}/${realmId}/upload`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Accept": "application/json",
      },
      body: combined,
    });
    const data = await response.json();
    return new Response(JSON.stringify(data), { status: response.status, headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
