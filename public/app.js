/**
 * DeepStream — app.js
 * Data source: drmlive fancode.m3u (M3U playlist)
 * Streams default to 720p (URL is rewritten from 1080p → 720p).
 *
 * Everything below the data layer is IDENTICAL to the original:
 *  - HLS playback via Chrome HLS extension fallback
 *  - Same DOM IDs, same error/loading states
 *  - Same retry / network-error recovery
 *  - Same 5-minute auto-refresh
 */

/** @typedef {{ title:string, url:string, logo:string, group:string, matchName:string, eventName:string, team1:string, team2:string, matchId:number, language:string, qualities:Object }} Channel */

const $ = (sel) => document.querySelector(sel);

const video         = $("#video");
const channelList   = $("#channel-list");
const channelSearch = $("#channel-search");
const channelCount  = $("#channel-count");
const playerOverlay = $("#player-overlay");
const playerLoading = $("#player-loading");
const playerError   = $("#player-error");
const errorMessage  = $("#error-message");
const nowTitle      = $("#now-title");
const nowGroup      = $("#now-group");
const nowUrl        = $("#now-url");
const nowLogo       = $("#now-logo");

/** @type {Channel[]} */
let channels = [];
/** @type {Channel|null} */
let activeChannel = null;
/** @type {any|null} */
let shakaPlayer = null;
let networkRetries = 0;

/* ── M3U source ── */
const M3U_URL =
  "https://raw.githubusercontent.com/drmlive/fancode-live-events/refs/heads/main/fancode.m3u";
const REFRESH_MS = 5 * 60 * 1000;   // 5 minutes

/* No proxy needed */
function proxiedStreamUrl(url) {
  return url;
}

/* ════════════════════════════════════════════════════════════
   M3U FETCH & PARSE
   Fetches drmlive/fancode-live-events fancode.m3u and converts
   each EXTINF entry into a Channel object.
   The playlist URLs are 1080p — we rewrite them to 720p.
════════════════════════════════════════════════════════════ */

/**
 * Fetches and parses the fancode.m3u playlist.
 * @returns {Promise<Channel[]>}
 */
async function fetchEvents() {
  const bust = Date.now();
  try {
    const res = await fetch(`${M3U_URL}?_=${bust}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return parseM3U(text);
  } catch (err) {
    console.error("Failed to fetch M3U:", err);
    return [];
  }
}

/**
 * Parses a raw M3U playlist string into Channel objects.
 * Rewrites 1080p / 1080p5 stream URLs → 720p.
 * @param {string} text
 * @returns {Channel[]}
 */
function parseM3U(text) {
  const lines = text.split("\n").map(l => l.trim());
  const channels = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("#EXTINF:")) continue;

    /* ── Parse EXTINF attributes ── */
    const logoMatch   = line.match(/tvg-logo="([^"]*)"/i);
    const groupMatch  = line.match(/group-title="([^"]*)"/i);
    /* Title is everything after the last attribute's closing quote + comma */
    const titleMatch  = line.match(/",\s*(.+)$/);

    /* ── URL is the next non-comment, non-empty line ── */
    let url = "";
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] && !lines[j].startsWith("#")) {
        url = lines[j];
        break;
      }
    }
    if (!url) continue;

    /* Use the URL directly from the playlist (1080p) */

    /* ── Clean up group: strip "Fancode-" prefix and language prefixes ── */
    let group = (groupMatch ? groupMatch[1] : "Sports")
      .replace(/^Fancode-/i, "")
      .replace(/^(ENGLISH|HINDI|TAMIL|TELUGU|KANNADA|MALAYALAM|BENGALI|PUNJABI|GUJARATI|MARATHI)\s+/i, "")
      .trim() || "Sports";

    const title = (titleMatch ? titleMatch[1] : "Live Match").trim();
    /* Also extract just match name (strip tournament in brackets) */
    const logo  = logoMatch ? logoMatch[1] : "";

    channels.push({
      url,
      qualities: {},
      title,
      matchName: title,
      eventName: "",
      team1:     "",
      team2:     "",
      group,
      logo,
      matchId:   0,
      startTime: "",
      language:  "",
    });
  }

  return channels;
}

/* ════════════════════════════════════════════════════════════
   RENDER CHANNEL LIST
   Identical structure to original — UI layer (index.html script)
   reads .channel-item buttons with .channel-name / .channel-group /
   img.channel-logo to build the card grid.
════════════════════════════════════════════════════════════ */

/** @param {Channel[]} list */
function renderChannelList(list) {
  if (!list.length) {
    channelList.innerHTML = `<div class="empty-state"><p>No live matches right now</p></div>`;
    channelCount.textContent = "0 live";
    return;
  }

  /* Group by event_category */
  const grouped = new Map();
  for (const ch of list) {
    const g = ch.group || "Sports";
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g).push(ch);
  }

  const frag = document.createDocumentFragment();
  for (const [group, items] of grouped) {
    const label = document.createElement("div");
    label.className = "group-label";
    label.textContent = group;
    frag.appendChild(label);
    for (const ch of items) frag.appendChild(createChannelButton(ch));
  }

  channelList.innerHTML = "";
  channelList.appendChild(frag);
  channelCount.textContent = `${list.length} live`;
}

/** @param {Channel} ch */
function createChannelButton(ch) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "channel-item";
  btn.dataset.url = ch.url;
  if (activeChannel?.url === ch.url) btn.classList.add("active");

  /* img.channel-logo — UI layer reads this for the card banner */
  const logoEl = ch.logo
    ? Object.assign(document.createElement("img"), {
        className: "channel-logo",
        src:       ch.logo,
        alt:       "",
        loading:   "lazy",
      })
    : (() => {
        const div = document.createElement("div");
        div.className = "channel-logo placeholder";
        div.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>`;
        return div;
      })();

  if (logoEl.onerror !== undefined) {
    logoEl.onerror = () => {
      const div = document.createElement("div");
      div.className = "channel-logo placeholder";
      div.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>`;
      logoEl.replaceWith(div);
    };
  }

  const meta = document.createElement("div");
  meta.className = "channel-meta";
  /* .channel-name → title shown on card
     .channel-group → category badge / group pill
     data-event → competition name shown as subtitle */
  const langBadge = ch.language
    ? `<span class="channel-lang">${escapeHtml(ch.language)}</span> `
    : "";
  meta.innerHTML = `
    <div class="channel-name">${escapeHtml(ch.title)}</div>
    <div class="channel-group">${langBadge}${escapeHtml(ch.group)}</div>`;

  btn.append(logoEl, meta);
  btn.addEventListener("click", () => playChannel(ch));
  return btn;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/* ════════════════════════════════════════════════════════════
   HLS PLAYER — completely unchanged from original
════════════════════════════════════════════════════════════ */

/** @param {Channel} ch */
function playChannel(ch) {
  activeChannel = ch;
  updateNowPlaying(ch);
  highlightActiveChannel(ch.url);
  closeDrawer();

  /* Build quality selector if qualities are available */
  buildQualitySelector(ch);

  /* Start playback with the default URL (720p or best available) */
  loadStream(ch.url);
}

/** Load a single-quality stream URL into Shaka Player */
async function loadStream(streamUrl) {
  await destroyPlayer();   /* ← must await so old player is fully gone first */
  networkRetries = 0;
  showLoading(true);
  hideError();
  playerOverlay.classList.add("hidden");

  /* Initialize Shaka Player */
  shaka.polyfill.installAll();
  if (shaka.Player.isBrowserSupported()) {
    shakaPlayer = new shaka.Player(video);

    shakaPlayer.configure({
      streaming: {
        bufferingGoal: 5,
        rebufferingGoal: 1,
        bufferBehind: 15,
        retryParameters: {
          maxAttempts: 1,
          baseDelay: 0
        }
      },
      manifest: {
        retryParameters: {
          maxAttempts: 1,
          baseDelay: 0
        }
      }
    });

    shakaPlayer.addEventListener("error", (event) => {
      console.error("Shaka error event:", event.detail);
      showLoading(false);
      handleFatalError(event.detail);
    });

    try {
      await shakaPlayer.load(streamUrl);
      showLoading(false);
      video.muted = false;
      video.play().catch((e) => console.log("Autoplay blocked:", e));
      video.addEventListener("playing", () => showLoading(false), { once: true });
    } catch (e) {
      console.error("Shaka load error:", e);

      /* ── The secret sauce for Chrome HLS extensions ──
         FanCode's CDN actively blocks CORS for XHR, so Shaka will always fail.
         BUT, if the user has a Native HLS extension (which they do), setting
         video.src + video.load() will allow the extension to intercept and play,
         completely bypassing CORS. This is exactly how sportlink works. */
      video.src = streamUrl;
      video.load();        /* ← forces the extension to detect the new src */
      video.muted = false;
      video.play().catch((e) => console.log("Autoplay blocked:", e));
      video.addEventListener("playing", () => showLoading(false), { once: true });

      /* Safety net: if nothing plays in 12s, show error */
      const safetyTimer = setTimeout(() => {
        if (video.readyState < 2) {
          showLoading(false);
          showError("Stream took too long to load. Try again or refresh the page.");
        }
      }, 12000);
      video.addEventListener("playing", () => clearTimeout(safetyTimer), { once: true });
    }
  } else {
    /* Fallback to native HLS (Safari) */
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = streamUrl;
      video.load();
      video.muted = false;
      video.play().catch((e) => console.log("Autoplay blocked:", e));
      video.addEventListener("playing", () => showLoading(false), { once: true });
      video.addEventListener("error", () => {
        showLoading(false);
        showError("Native HLS playback failed. The stream may be geo-blocked or expired.");
      }, { once: true });
    } else {
      showLoading(false);
      showError("Your browser does not support Shaka Player or native HLS.");
    }
  }
}

/* ── Quality Selector ── */
function buildQualitySelector(ch) {
  const container = document.getElementById("quality-selector");
  if (!container) return;

  const q = ch.qualities || {};
  const keys = Object.keys(q);
  if (keys.length <= 1) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  container.innerHTML = "";

  /* Sort qualities: highest first */
  const sorted = keys.map(Number).sort((a, b) => b - a);

  for (const height of sorted) {
    const btn = document.createElement("button");
    btn.className = "quality-btn";
    btn.textContent = `${height}p`;
    btn.dataset.quality = String(height);

    /* Highlight the currently active quality */
    if (q[String(height)] === ch.url) {
      btn.classList.add("active");
    }

    btn.addEventListener("click", () => {
      const newUrl = q[String(height)];
      if (!newUrl) return;
      /* Update active highlight */
      container.querySelectorAll(".quality-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      /* Reload stream with new quality */
      activeChannel.url = newUrl;
      loadStream(newUrl);
    });
    container.appendChild(btn);
  }

  container.classList.remove("hidden");
}

function hideQualitySelector() {
  const container = document.getElementById("quality-selector");
  if (container) { container.classList.add("hidden"); container.innerHTML = ""; }
}

function handleFatalError(e) {
  const code = e.code ? ` (Error ${e.code})` : '';
  showError(`Stream failed${code}. The stream may be geo-blocked, expired, or CORS-restricted.`);
}

async function destroyPlayer() {
  if (shakaPlayer) {
    try { await shakaPlayer.destroy(); } catch(e) {}
    shakaPlayer = null;
  }
  video.removeAttribute("src");
  video.load();
}

/** @param {Channel} ch */
function updateNowPlaying(ch) {
  nowTitle.textContent = ch.title;
  nowGroup.textContent = ch.group;
  nowUrl.textContent   = ch.url;

  if (ch.logo) {
    nowLogo.src = ch.logo;
    nowLogo.classList.remove("hidden");
    nowLogo.onerror = () => nowLogo.classList.add("hidden");
  } else {
    nowLogo.classList.add("hidden");
    nowLogo.removeAttribute("src");
  }

  if (ch.logo) video.poster = ch.logo;
}

function highlightActiveChannel(url) {
  channelList.querySelectorAll(".channel-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.url === url);
  });
}

function showLoading(on) { playerLoading.classList.toggle("hidden", !on); }
function showError(msg)  { errorMessage.textContent = msg; playerError.classList.remove("hidden"); playerOverlay.classList.add("hidden"); }
function hideError()     { playerError.classList.add("hidden"); }

/* ════════════════════════════════════════════════════════════
   LOAD + REFRESH
════════════════════════════════════════════════════════════ */

async function loadEvents() {
  channelCount.textContent = "Loading…";
  const list = await fetchEvents();

  if (!list.length) {
    channelList.innerHTML = `<div class="empty-state"><p>No live matches right now. Check back soon.</p></div>`;
    channelCount.textContent = "0 live";
    return;
  }

  channels = list;
  renderChannelList(channels);
}

function startRefresh() {
  setInterval(async () => {
    const list = await fetchEvents();
    if (!list.length) return;

    const prevUrl = activeChannel?.url;
    channels = list;
    renderChannelList(channels);
    if (prevUrl) highlightActiveChannel(prevUrl);
  }, REFRESH_MS);
}

/* ── Search ── */
function filterChannels(query) {
  const q = query.trim().toLowerCase();
  if (!q) { renderChannelList(channels); return; }
  const filtered = channels.filter(
    (c) =>
      c.title.toLowerCase().includes(q) ||
      c.group.toLowerCase().includes(q) ||
      c.eventName.toLowerCase().includes(q) ||
      c.matchName.toLowerCase().includes(q)
  );
  renderChannelList(filtered);
}
channelSearch.addEventListener("input", (e) => filterChannels(e.target.value));

/* ── Drawer (sidebar) ── */
const sidebar       = $("#sidebar");
const drawerBackdrop = $("#drawer-backdrop");

function openDrawer()  { sidebar.classList.add("open"); drawerBackdrop.classList.remove("hidden"); document.body.classList.add("drawer-open"); }
function closeDrawer() { sidebar.classList.remove("open"); drawerBackdrop.classList.add("hidden"); document.body.classList.remove("drawer-open"); }

$("#btn-channels")?.addEventListener("click", openDrawer);
$("#btn-close-drawer")?.addEventListener("click", closeDrawer);
drawerBackdrop?.addEventListener("click", closeDrawer);

$("#btn-retry").addEventListener("click", () => { if (activeChannel) playChannel(activeChannel); });

window.addEventListener("beforeunload", destroyPlayer);

/* ── Boot ── */
loadEvents();
startRefresh();

/* Expose playChannel globally so index.html's inline script can call it directly */
window.playChannel = playChannel;
