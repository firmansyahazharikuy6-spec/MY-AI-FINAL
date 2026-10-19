const WORKER_ORIGIN = "https://myai-v3-free-api.firmansyahazharikuy6.workers.dev";
const API_ROUTES = new Map([
  ["/api/guest/models", "/guest/models"],
  ["/api/guest/chat", "/guest/chat"],
  ["/api/models", "/models"],
  ["/api/chat", "/chat"],
]);
const ERROR_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(self), payment=()",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const upstreamPath = API_ROUTES.get(url.pathname);
    if (!upstreamPath) {
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: ERROR_HEADERS });
    }

    const upstreamUrl = new URL(`${upstreamPath}${url.search}`, WORKER_ORIGIN);
    try {
      return await fetch(new Request(upstreamUrl, request));
    } catch (error) {
      console.error("Pages AI gateway request failed:", error?.name || "Error");
      return new Response(JSON.stringify({
        error: {
          message: "Cloudflare Pages tidak dapat menghubungi API AI. Coba lagi beberapa saat.",
        },
      }), { status: 502, headers: ERROR_HEADERS });
    }
  },
};
