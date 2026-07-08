/**
 * functions/api/events.js — Cloudflare Pages Function
 * Proxies the fancode.json file server-side so the browser
 * never hits a CORS wall. Returns only LIVE matches.
 * Migrated from Vercel Edge Function — same logic, Cloudflare export format.
 */

const JSON_URL =
  "https://raw.githubusercontent.com/drmlive/fancode-live-events/refs/heads/main/fancode.json";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

/* Cloudflare Pages Function */
export async function onRequest() {
  try {
    const upstream = await fetch(JSON_URL, {
      headers: {
        "User-Agent": "DeepStream/1.0",
        Accept: "application/json, text/plain, */*",
      },
    });

    if (!upstream.ok) {
      return new Response(`Upstream ${upstream.status}`, {
        status: upstream.status,
        headers: corsHeaders(),
      });
    }

    const data = await upstream.json();

    // Filter to LIVE only before sending to client
    const liveMatches = (data.matches || []).filter(
      (m) => m.status === "LIVE"
    );

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
    return new Response(`Events error: ${err.message}`, {
      status: 502,
      headers: corsHeaders(),
    });
  }
}
