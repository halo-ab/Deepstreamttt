/**
 * src/index.js — Cloudflare Worker
 * Handles /api/events (match data proxy) and /api/hls (HLS stream proxy).
 * All other requests fall through to Cloudflare's static asset serving (public/).
 */

const JSON_URL =
  "https://raw.githubusercontent.com/doctor-8trange/zyphx8/refs/heads/main/data/fancode.m3u";

const UPSTREAM_HEADERS = {
  Referer:      "https://www.fancode.com/",
  Origin:       "https://www.fancode.com",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:       "*/*",
  "Accept-Encoding": "identity",   /* avoid compressed chunks that break streaming */
};

function cors() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
  };
}

/* ── /api/events ───────────────────────────────────────────── */
async function handleEvents() {
  try {
    const res = await fetch(JSON_URL, {
      headers: {
        "User-Agent": "DeepStream/1.0",
        Accept: "application/json, text/plain, */*",
      },
    });

    if (!res.ok)
      return new Response(`Upstream ${res.status}`, { status: res.status, headers: cors() });

    const data = await res.json();
    const live  = (data.matches || []).filter((m) => m.status === "LIVE");

    return new Response(
      JSON.stringify({ lastUpdate: data["last update time"] || "", matches: live }),
      {
        status: 200,
        headers: {
          ...cors(),
          "Content-Type":  "application/json; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      }
    );
  } catch (e) {
    return new Response(`Events error: ${e.message}`, { status: 502, headers: cors() });
  }
}

/* ── /api/hls helpers ──────────────────────────────────────── */
function resolveUrl(base, relative) {
  if (/^https?:\/\//i.test(relative)) return relative;
  const dir = base.endsWith("/") ? base : base.replace(/\/[^/]*$/, "/");
  return new URL(relative, dir).href;
}

function proxyUrl(origin, target) {
  return `${origin}/api/hls?url=${encodeURIComponent(target)}`;
}

function rewriteM3U8(text, srcUrl, origin) {
  const base = srcUrl.endsWith("/") ? srcUrl : srcUrl.replace(/\/[^/]*$/, "/");

  let out = text
    .replace(/URI="([^"]+)"/gi, (_, u) => `URI="${proxyUrl(origin, resolveUrl(base, u))}"`)
    .replace(/URI='([^']+)'/gi, (_, u) => `URI='${proxyUrl(origin, resolveUrl(base, u))}'`);

  return out
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trimEnd();
      if (!t || t.startsWith("#")) return t;
      return proxyUrl(origin, resolveUrl(base, t));
    })
    .join("\n");
}

/* ── /api/hls ──────────────────────────────────────────────── */
async function handleHls(request) {
  /* CORS preflight */
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors() });

  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");

  if (!target)
    return new Response("Missing url param", { status: 400, headers: cors() });

  /* Build upstream headers */
  const upHeaders = { ...UPSTREAM_HEADERS };
  const range = request.headers.get("range");
  if (range) upHeaders["Range"] = range;

  let upstream;
  try {
    upstream = await fetch(target, {
      method:   "GET",
      headers:  upHeaders,
      redirect: "follow",
    });
  } catch (e) {
    return new Response(`Fetch failed: ${e.message}`, { status: 502, headers: cors() });
  }

  if (!upstream.ok)
    return new Response(`Upstream ${upstream.status}: ${upstream.statusText}`, {
      status: upstream.status,
      headers: cors(),
    });

  const origin = reqUrl.origin;

  /* Rewrite HLS manifests */
  if (/\.m3u8?(\?|$)/i.test(target)) {
    const text = await upstream.text();
    if (text.startsWith("#EXTM3U")) {
      return new Response(rewriteM3U8(text, target, origin), {
        status: 200,
        headers: {
          ...cors(),
          "Content-Type":  "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
        },
      });
    }
  }

  /* Pass-through segments + key files */
  const respHeaders = {
    ...cors(),
    "Content-Type":  upstream.headers.get("content-type") || "application/octet-stream",
    "Cache-Control": "no-store",
  };

  for (const h of ["content-range", "content-length", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) respHeaders[h.split("-").map(p => p[0].toUpperCase() + p.slice(1)).join("-")] = v;
  }

  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

/* ── Main entrypoint ───────────────────────────────────────── */
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/events") return handleEvents();
    if (pathname === "/api/hls")    return handleHls(request);

    /* Fall through to Cloudflare Assets (serves public/) */
    return env.ASSETS.fetch(request);
  },
};
