/**
 * src/index.js — Cloudflare Worker
 * Handles API routes for DeepStream (/api/events and /api/hls).
 * Static assets in /public are served automatically by Cloudflare.
 */

const JSON_URL = "https://raw.githubusercontent.com/drmlive/fancode-live-events/refs/heads/main/fancode.json";

const UPSTREAM_HEADERS = {
  Referer: "https://www.fancode.com/",
  Origin: "https://www.fancode.com",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "*/*",
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
  };
}

// --- Events API Handler ---
async function handleEvents() {
  try {
    const upstream = await fetch(JSON_URL, {
      headers: {
        "User-Agent": "DeepStream/1.0",
        Accept: "application/json, text/plain, */*",
      },
    });

    if (!upstream.ok) {
      return new Response(`Upstream ${upstream.status}`, { status: upstream.status, headers: corsHeaders() });
    }

    const data = await upstream.json();
    const liveMatches = (data.matches || []).filter((m) => m.status === "LIVE");
    const payload = JSON.stringify({
      lastUpdate: data["last update time"] || "",
      matches: liveMatches,
    });

    return new Response(payload, {
      status: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (err) {
    return new Response(`Events error: ${err.message}`, { status: 502, headers: corsHeaders() });
  }
}

// --- HLS API Handler ---
function resolveUrl(base, relative) {
  if (/^https?:\/\//i.test(relative)) return relative;
  const baseDir = base.endsWith("/") ? base : base.replace(/\/[^/]*$/, "/");
  return new URL(relative, baseDir).href;
}

function proxyUrl(proxyOrigin, target) {
  return `${proxyOrigin}/api/hls?url=${encodeURIComponent(target)}`;
}

function rewriteManifest(text, sourceUrl, proxyOrigin) {
  const base = sourceUrl.endsWith("/") ? sourceUrl : sourceUrl.replace(/\/[^/]*$/, "/");
  let out = text.replace(/URI="([^"]+)"/gi, (_m, uri) => `URI="${proxyUrl(proxyOrigin, resolveUrl(base, uri))}"`);
  out = out.replace(/URI='([^']+)'/gi, (_m, uri) => `URI='${proxyUrl(proxyOrigin, resolveUrl(base, uri))}'`);
  return out
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.startsWith("#")) return trimmed;
      return proxyUrl(proxyOrigin, resolveUrl(base, trimmed));
    })
    .join("\n");
}

async function handleHls(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");
  if (!target) return new Response("Missing url", { status: 400, headers: corsHeaders() });

  const upstreamHeaders = { ...UPSTREAM_HEADERS };
  const range = request.headers.get("range");
  if (range) upstreamHeaders.Range = range;

  let upstream;
  try {
    upstream = await fetch(target, { headers: upstreamHeaders, redirect: "follow" });
  } catch (err) {
    return new Response(`Proxy fetch failed: ${err.message}`, { status: 502, headers: corsHeaders() });
  }

  if (!upstream.ok) {
    return new Response(`Upstream ${upstream.status}`, { status: upstream.status, headers: corsHeaders() });
  }

  const proxyOrigin = reqUrl.origin;
  if (/\.m3u8?(\?|$)/i.test(target)) {
    const text = await upstream.text();
    if (text.startsWith("#EXTM3U")) {
      return new Response(rewriteManifest(text, target, proxyOrigin), {
        status: 200,
        headers: { ...corsHeaders(), "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" },
      });
    }
  }

  const headers = {
    ...corsHeaders(),
    "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
    "Cache-Control": "no-store",
  };
  if (upstream.headers.get("content-range")) headers["Content-Range"] = upstream.headers.get("content-range");
  if (upstream.headers.get("content-length")) headers["Content-Length"] = upstream.headers.get("content-length");
  if (upstream.headers.get("accept-ranges")) headers["Accept-Ranges"] = upstream.headers.get("accept-ranges");

  return new Response(upstream.body, { status: upstream.status, headers });
}

// --- Main Worker Entrypoint ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    if (url.pathname === '/api/events') {
      return handleEvents();
    }
    
    if (url.pathname === '/api/hls') {
      return handleHls(request);
    }
    
    // Cloudflare Workers + Assets will automatically serve files from /public
    // if no route is matched here, so we don't need to do anything else.
    return new Response("Not Found", { status: 404 });
  }
};
