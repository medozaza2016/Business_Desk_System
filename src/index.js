const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      try {
        const result = await env.DB.prepare("SELECT 1 AS ok").first();
        return json({ ok: result?.ok === 1, service: "challenger-quotation-platform", version: "0.1.0" });
      } catch (error) {
        return json({ ok: false, error: "database_unavailable" }, 503);
      }
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    return env.STATIC.fetch(request);
  }
};
