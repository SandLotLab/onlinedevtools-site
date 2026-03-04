export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const path = body.path || "/";
    const event = body.event || "page_view";

    const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
    const ua = request.headers.get("user-agent") || "ua";
    const client_id = `${ip}.${hash32(ua)}`;

    const url = `https://www.google-analytics.com/mp/collect?measurement_id=${env.GA_MEASUREMENT_ID}&api_secret=${env.GA_API_SECRET}`;

    const payload = {
      client_id,
      events: [{
        name: event,
        params: {
          page_location: `https://onlinedevtools.app${path}`,
          page_path: path
        }
      }]
    };

    const gaRes = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    return new Response(JSON.stringify({ ok: gaRes.ok }), {
      status: gaRes.ok ? 200 : 502,
      headers: { "content-type": "application/json" }
    });

  } catch {
    return new Response(JSON.stringify({ ok: false }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }
}

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}