/**
 * DeepStream — app.js
 * Data source switched from M3U playlist → fancode.json
 * Only shows matches where status === "LIVE".
 *
 * Everything below the data layer is IDENTICAL to the original:
 *  - HLS playback via hls.js (proxied through /api/hls)
 *  - Same DOM IDs, same error/loading states
 *  - Same retry / network-error recovery
 *  - Same 5-minute auto-refresh
 */

/** @typedef {{ title:string, url:string, logo:string, group:string, matchName:string, eventName:string, team1:string, team2:string, matchId:number, language:string }} Channel */

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
let hls = null;
let networkRetries = 0;

/* ── JSON sources ── */
/* fan.json has cnptv_cdn URLs (fancode-cdn.pages.dev) which actually work.
   fancode.json has the raw FanCode CDN URLs which are CORS/IP-blocked. */
const FAN_JSON =
  "https://raw.githubusercontent.com/kajju027/Fancode-Events-Json/main/fan.json";
const FANCODE_JSON =
  "https://raw.githubusercontent.com/kajju027/Fancode-Events-Json/main/fancode.json";
const REFRESH_MS = 5 * 60 * 1000;   // 5 minutes

/* Stream URLs from cnptv_cdn are direct — no proxy needed */
function proxiedStreamUrl(url) {
  return url;
}

/* ════════════════════════════════════════════════════════════
   JSON FETCH & PARSE
   Converts fancode.json matches → Channel objects.
   Only includes entries where status === "LIVE".
════════════════════════════════════════════════════════════ */

/**
 * Fetch the events JSON.
 * Tries /api/events (server-side proxy) first, then raw GitHub URL.
 * @returns {Promise<Channel[]>}
 */
async function fetchEvents() {
  const bust = Date.now();

  /* ── Try fan.json first (has cnptv_cdn URLs that actually work) ── */
  try {
    const res = await fetch(`${FAN_JSON}?_=${bust}`, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      const raw = data.matches || [];
      const live = raw.filter((m) => m.status === "LIVE");
      if (live.length > 0) {
        const channels = live
          .filter((m) => m.cnptv_cdn)   /* only entries with working CDN */
          .map((m) => ({
            url:       m.cnptv_cdn,
            title:     m.title || "Untitled",
            matchName: m.title || "",
            eventName: m.tournament || "",
            team1:     "",
            team2:     "",
            group:     m.category || "Sports",
            logo:      m.image || "",
            matchId:   m.match_id || 0,
            startTime: m.startTime || "",
            language:  m.language || "",
          }));
        if (channels.length > 0) return channels;
      }
    }
  } catch { /* fall through */ }

  /* ── Fallback: fancode.json (has more data but CDN may be blocked) ── */
  try {
    const res = await fetch(`${FANCODE_JSON}?_=${bust}`, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      const raw = data.matches || [];
      const live = raw.filter((m) => m.status === "LIVE");
      if (live.length > 0) return parseMatches(live);
    }
  } catch { /* nothing */ }

  return [];
}

/**
 * Fallback parser for fancode.json (no cnptv_cdn).
 * @param {object[]} matches
 * @returns {Channel[]}
 */
function parseMatches(matches) {
  return matches.map((m) => {
    const streams = m.streams || {};
    const url =
      streams.primary || streams.fancode_cdn ||
      m.adfree_url || m.dai_url || m.url || "";
    return {
      url,
      title:     m.title  || m.match || m.match_name || "Untitled",
      matchName: m.match  || m.match_name || "",
      eventName: m.tournament || m.event_name || "",
      team1:     m.team_1 || "",
      team2:     m.team_2 || "",
      group:     m.category || m.event_category || "Sports",
      logo:      m.image  || m.src || "",
      matchId:   m.match_id || 0,
      startTime: m.startTime || "",
      language:  m.language || "",
    };
  }).filter((c) => c.url);
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
    ? `<span class="channel-lang">${escapeHtml(ch.language)}</span>`
    : "";
  meta.innerHTML = `
    <div class="channel-name">${escapeHtml(ch.title)}</div>
    <div class="channel-group">${escapeHtml(ch.group)}</div>
    <div class="channel-event">${escapeHtml(ch.eventName)}${langBadge}</div>`;

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

  destroyPlayer();
  networkRetries = 0;
  showLoading(true);
  hideError();
  playerOverlay.classList.add("hidden");

  if (Hls.isSupported()) {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    /* Exact config from the working fanncode.pages.dev player */
    hls = new Hls({
      enableWorker:        true,
      maxBufferLength:     30,
      backBufferLength:    60,
      liveSyncDurationCount: 3,
    });

    hls.loadSource(proxiedStreamUrl(ch.url));
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, (_ev, data) => {
      showLoading(false);
      /* Auto-play muted, then unmute — same as working site */
      video.muted = true;
      video.play()
        .then(() => { video.muted = false; })
        .catch((e) => showError(`Playback blocked: ${e.message}`));
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      /* Log every error so the browser console shows what's failing */
      console.warn('[HLS]', data.type, data.details, 'fatal:', data.fatal,
                   'url:', data.url, 'status:', data.response?.code);
      if (data.fatal) {
        showLoading(false);
        handleFatalError(data);
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = proxiedStreamUrl(ch.url);
    video.addEventListener("loadedmetadata", () => {
      showLoading(false);
      video.play().catch(() => {});
    }, { once: true });
    video.addEventListener("error", () => {
      showLoading(false);
      showError("Native HLS playback failed. The stream may be geo-blocked or expired.");
    }, { once: true });
  } else {
    showLoading(false);
    showError("HLS is not supported in this browser.");
  }
}

function handleFatalError(data) {
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
    hls?.recoverMediaError();
    return;
  }
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 1) {
    networkRetries += 1;
    hls?.startLoad();
    return;
  }
  /* Show the real error so it's easy to diagnose */
  const code = data.response?.code ? ` — HTTP ${data.response.code}` : '';
  const det  = data.details || data.type;
  showError(`Stream failed: ${det}${code}. The stream may be geo-blocked, expired, or CORS-restricted.`);
}

function destroyPlayer() {
  if (hls) { hls.destroy(); hls = null; }
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
