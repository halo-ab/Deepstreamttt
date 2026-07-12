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

/** @typedef {{ title:string, url:string, logo:string, group:string, matchName:string, eventName:string, team1:string, team2:string, matchId:number }} Channel */

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

/* ── JSON source (server-side proxy first, raw fallback) ── */
const JSON_URL =
  "https://raw.githubusercontent.com/drmlive/fancode-live-events/refs/heads/main/fancode.json";
const REFRESH_MS = 5 * 60 * 1000;   // 5 minutes

/* Route ALL stream requests through the /api/hls proxy so the
   server can inject the required Referer/Origin headers.
   (Browsers forbid setting those headers via XHR.) */
function proxiedStreamUrl(url) {
  return `/api/hls?url=${encodeURIComponent(url)}`;
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
  const sources = [
    `/api/events?_=${bust}`,
    `${JSON_URL}?_=${bust}`,
  ];

  for (const src of sources) {
    try {
      const res = await fetch(src, { cache: "no-store" });
      if (!res.ok) continue;

      const data = await res.json();

      /* /api/events returns { matches, lastUpdate }
         raw GitHub URL returns { matches, "last update time", ... } */
      const raw = data.matches || [];

      /* Filter to LIVE only */
      const live = raw.filter((m) => m.status === "LIVE");

      if (live.length > 0) return parseMatches(live);
    } catch {
      /* try next source */
    }
  }

  return [];
}

/**
 * Map raw JSON match objects → Channel shape the rest of the app uses.
 * @param {object[]} matches
 * @returns {Channel[]}
 */
function parseMatches(matches) {
  return matches.map((m) => ({
    /* Stream URL — prefer adfree_url, fall back to dai_url */
    url:       m.adfree_url || m.dai_url || "",

    /* Display fields */
    title:     m.title      || m.match_name || "Untitled",
    matchName: m.match_name || "",
    eventName: m.event_name || "",
    team1:     m.team_1     || "",
    team2:     m.team_2     || "",

    /* Category used for grouping / filter pills */
    group:     m.event_category || "Sports",

    /* Banner / thumbnail — fancode match-card images */
    logo:      m.src        || "",

    /* Extras */
    matchId:   m.match_id   || 0,
    startTime: m.startTime  || "",
  })).filter((c) => c.url);   /* drop any entry with no stream URL */
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
  meta.innerHTML = `
    <div class="channel-name">${escapeHtml(ch.title)}</div>
    <div class="channel-group">${escapeHtml(ch.group)}</div>
    <div class="channel-event" style="display:none">${escapeHtml(ch.eventName)}</div>`;

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

    hls = new Hls({
      enableWorker:            !isMobile,
      lowLatencyMode:          true,
      backBufferLength:        30,
      maxBufferLength:         30,
      maxMaxBufferLength:      60,
      manifestLoadingTimeOut:  20000,
      manifestLoadingMaxRetry: 4,
      levelLoadingTimeOut:     20000,
      fragLoadingTimeOut:      30000,
      fragLoadingMaxRetry:     6,
    });

    hls.loadSource(proxiedStreamUrl(ch.url));
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      showLoading(false);
      video.play().catch(() => {});
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
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
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 2) {
    networkRetries += 1;
    hls?.startLoad();
    return;
  }
  showError("Stream unavailable — may be offline, expired, or geo-blocked in your region.");
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
