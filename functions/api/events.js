/**
 * functions/api/events.js — Cloudflare Pages Function
 * Route: GET /api/events
 * Fetches live matches from fancode.json and returns only LIVE ones.
 */

const JSON_URL =
  "https://raw.githubusercontent.com/drmlive/fancode-live-events/refs/heads/main/fancode.json";

function cors() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
  };
}

export async function onRequest(context) {
  const { request } = context;

  /* CORS preflight */
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors() });

  try {
    const res = await fetch(`${JSON_URL}?_=${Date.now()}`, {
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
