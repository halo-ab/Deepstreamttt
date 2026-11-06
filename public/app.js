/**
 * DeepStream — app.js (Project B)
 * Dual-engine streaming:
 *   • FanCode live matches → HLS (Hls.js) via M3U sources
 *   • Sony Sports & Star Sports TV channels → MPEG-DASH (Shaka Player)
 *     using live ClearKey DRM keys + Akamai tokens from sonujson-v7.pages.dev
 */

"use strict";

/** @typedef {{ title:string, url:string, logo:string, group:string, matchName:string, eventName:string, team1:string, team2:string, matchId:number, language:string, isDash:boolean, dashData:Object|null }} Channel */

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
let hls = null;
let shakaPlayer = null;
let networkRetries = 0;

/* ════════════════════════════════════════════════════════════
   SOURCES
════════════════════════════════════════════════════════════ */

/* FanCode live match M3U playlists */
const M3U_SOURCES = [
  "https://raw.githubusercontent.com/drmlive/fancode-live-events/refs/heads/main/fancode.m3u",
  "https://raw.githubusercontent.com/sportlive18/Fancode-New-Auto-Update/main/fancode2.m3u",
  "https://raw.githubusercontent.com/halo-ab/Matches-playlist-/refs/heads/main/Playlist.m3u"
];

/* Sony Sports & Star Sports DASH+DRM channel API (auto-updated keys + tokens) */
const SONY_STAR_API = "https://sonujson-v7.pages.dev/Data/sports.json";

/* Channel logos map (Sony / Star) */
const CHANNEL_LOGOS = {
  STEN1:  "https://i.imgur.com/OBkeFHp.png",
  STEN2:  "https://i.imgur.com/OBkeFHp.png",
  STEN3:  "https://i.imgur.com/OBkeFHp.png",
  STENT:  "https://i.imgur.com/OBkeFHp.png",
  STENTU: "https://i.imgur.com/OBkeFHp.png",
  STENK:  "https://i.imgur.com/OBkeFHp.png",
  STEN5:  "https://i.imgur.com/OBkeFHp.png",
  E1SD:   "https://i.imgur.com/JNZBX0M.png",
  E1HD:   "https://i.imgur.com/JNZBX0M.png",
  H1SD:   "https://i.imgur.com/JNZBX0M.png",
  H1HD:   "https://i.imgur.com/JNZBX0M.png",
  E2SD:   "https://i.imgur.com/JNZBX0M.png",
  E2HD:   "https://i.imgur.com/JNZBX0M.png",
  H2SD:   "https://i.imgur.com/JNZBX0M.png",
  H2HD:   "https://i.imgur.com/JNZBX0M.png",
};

const REFRESH_MS = 5 * 60 * 1000; // 5 minutes

/* ════════════════════════════════════════════════════════════
   PROXY (FanCode HLS only — not needed for Sony/Star DASH)
════════════════════════════════════════════════════════════ */
function proxiedStreamUrl(url) {
  if (!url) return "";
  const clean = url.split("|")[0].trim();
  return `https://cinexcricket.com/proxy/universal.php/?url=${encodeURIComponent(clean)}`;
}

/* ════════════════════════════════════════════════════════════
   SONY / STAR SPORTS — fetch channel data
════════════════════════════════════════════════════════════ */
async function fetchSonyStarChannels() {
  try {
    const res = await fetch(`${SONY_STAR_API}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.channels)) return [];

    return data.channels.map((ch) => {
      /* Build ClearKey map from sonuxs array + key_id/key */
      const clearKeys = {};
      if (ch.key_id && ch.key) {
        clearKeys[ch.key_id.trim().toLowerCase()] = ch.key.trim().toLowerCase();
      }
      if (Array.isArray(ch.sonuxs)) {
        ch.sonuxs.forEach((entry) => {
          const parts = String(entry).split(":");
          if (parts.length >= 2) {
            clearKeys[parts[0].trim().toLowerCase()] = parts[1].trim().toLowerCase();
          }
        });
      }

      /* Raw Akamai token (strip "__hdnea__=" prefix if present) */
      const rawToken = ch.cookie && ch.cookie.startsWith("__hdnea__=")
        ? ch.cookie.slice(10)
        : (ch.cookie || "");

      /* Determine group */
      const name = ch.name || "";
      let group = "Sony Sports";
      if (name.toLowerCase().includes("star")) group = "Star Sports";

      return {
        url:       ch.stream_url || "",
        title:     name,
        matchName: name,
        eventName: "",
        team1:     "",
        team2:     "",
        group,
        logo:      CHANNEL_LOGOS[ch.id] || "",
        matchId:   0,
        language:  "",
        isDash:    true,
        dashData: {
          clearKeys,
          rawToken,
          cookie: ch.cookie || "",
        },
      };
    }).filter(ch => ch.url);
  } catch (err) {
    console.warn("[DeepStream] Failed to fetch Sony/Star channels:", err);
    return [];
  }
}

/* ════════════════════════════════════════════════════════════
   FANCODE — M3U fetch & parse
════════════════════════════════════════════════════════════ */
async function fetchFancodeChannels() {
  const bust = Date.now();
  const seenUrls = new Set();
  const allChannels = [];

  for (const src of M3U_SOURCES) {
    try {
      const res = await fetch(`${src}?_=${bust}`, { cache: "no-store" });
      if (!res.ok) continue;
      const text = await res.text();
      const parsed = parseM3U(text);
      for (const ch of parsed) {
        if (!seenUrls.has(ch.url)) {
          seenUrls.add(ch.url);
          allChannels.push(ch);
        }
      }
    } catch (err) {
      console.warn("[DeepStream] Failed to fetch M3U from:", src, err);
    }
  }
  return allChannels;
}

/** Fetch all channels: Sony/Star first (top of list), then FanCode */
async function fetchEvents() {
  const [sonyStarChannels, fancodeChannels] = await Promise.all([
    fetchSonyStarChannels(),
    fetchFancodeChannels(),
  ]);
  return [...sonyStarChannels, ...fancodeChannels];
}

/** @param {string} text */
function parseM3U(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const list = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("#EXTINF:")) continue;

    const logoMatch  = line.match(/tvg-logo="([^"]*)"/i);
    const groupMatch = line.match(/group-title="([^"]*)"/i);

    let title = "Live Match";
    const quoteCommaMatch = line.match(/",\s*(.+)$/);
    if (quoteCommaMatch) {
      title = quoteCommaMatch[1].trim();
    } else {
      const commaIdx = line.indexOf(",");
      if (commaIdx !== -1) title = line.substring(commaIdx + 1).trim();
    }

    let url = "";
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] && !lines[j].startsWith("#")) { url = lines[j]; break; }
    }
    if (!url) continue;

    let group = (groupMatch ? groupMatch[1] : "Sports")
      .replace(/^Fancode-/i, "")
      .replace(/^(ENGLISH|HINDI|TAMIL|TELUGU|KANNADA|MALAYALAM|BENGALI|PUNJABI|GUJARATI|MARATHI)\s+/i, "")
      .trim() || "Sports";

    list.push({
      url,
      title,
      matchName: title,
      eventName: "",
      team1:     "",
      team2:     "",
      group,
      logo:      logoMatch ? logoMatch[1] : "",
      matchId:   0,
      language:  "",
      isDash:    false,
      dashData:  null,
    });
  }
  return list;
}

/* ════════════════════════════════════════════════════════════
   RENDER CHANNEL LIST
════════════════════════════════════════════════════════════ */
/** @param {Channel[]} list */
function renderChannelList(list) {
  if (!list.length) {
    channelList.innerHTML = `<div class="empty-state"><p>No live matches right now</p></div>`;
    channelCount.textContent = "0 live";
    return;
  }

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

  /* Badge for Sony/Star channels */
  if (ch.isDash) btn.dataset.isDash = "1";

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

  /* Show "LIVE TV" badge for Sony/Star channels */
  const tvBadge = ch.isDash
    ? `<span class="channel-lang" style="background:rgba(239,68,68,0.15);color:#f87171;border-color:rgba(239,68,68,0.3)">LIVE TV</span> `
    : "";

  meta.innerHTML = `
    <div class="channel-name">${escapeHtml(ch.title)}</div>
    <div class="channel-group">${tvBadge}${escapeHtml(ch.group)}</div>`;

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
   STREAM PLAYBACK — Smart Router
   • Sony/Star: Shaka Player (MPEG-DASH + ClearKey DRM)
   • FanCode:   Hls.js (HLS via proxy)
════════════════════════════════════════════════════════════ */

/** @param {Channel} ch */
function playChannel(ch) {
  activeChannel = ch;
  updateNowPlaying(ch);
  highlightActiveChannel(ch.url);
  closeDrawer();

  if (ch.isDash && ch.dashData) {
    loadDashStream(ch);
  } else {
    loadHlsStream(ch.url);
  }
}

/* ── SHAKA PLAYER (Sony / Star Sports) ── */
async function loadDashStream(ch) {
  await destroyPlayer();
  networkRetries = 0;
  showLoading(true);
  hideError();
  playerOverlay.classList.add("hidden");
  hideQualitySelector();

  const { clearKeys, rawToken, cookie } = ch.dashData;

  try {
    if (typeof shaka === "undefined") {
      throw new Error("Shaka Player not loaded.");
    }
    shaka.polyfill.installAll();

    shakaPlayer = new shaka.Player();
    await shakaPlayer.attach(video);

    shakaPlayer.configure({
      drm:       { clearKeys },
      manifest:  { dash: { ignoreMinBufferTime: true } },
      streaming: { bufferingGoal: 8, rebufferingGoal: 1.5, bufferBehind: 15 },
    });

    const T = shaka.net.NetworkingEngine.RequestType;
    shakaPlayer.getNetworkingEngine().registerRequestFilter(function(type, req) {
      req.headers["Referer"]    = "https://www.jiotv.com/";
      req.headers["User-Agent"] = "Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36";
      if (cookie) req.headers["Cookie"] = cookie;
      /* Append Akamai edge token to every manifest/segment request */
      if (rawToken && (type === T.MANIFEST || type === T.SEGMENT)) {
        req.uris = req.uris.map(u =>
          u.includes("__hdnea__") ? u : u + (u.includes("?") ? "&" : "?") + "__hdnea__=" + rawToken
        );
      }
    });

    shakaPlayer.addEventListener("error", (e) => {
      console.warn("[Shaka Error]", e.detail);
      if (e.detail && e.detail.severity === 2) {
        showLoading(false);
        showError("Stream error. Please retry or try another channel.");
      }
    });

    video.addEventListener("waiting",  () => { if (!video.paused) showLoading(true);  });
    video.addEventListener("playing",  () => { showLoading(false); }, { once: false });

    video.muted = false;
    await shakaPlayer.load(ch.url);
    showLoading(false);
    video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });

  } catch (err) {
    console.error("[DeepStream] Shaka load failed:", err);
    showLoading(false);
    showError("Failed to load Sony/Star stream: " + err.message);
  }
}

/* ── HLS.JS (FanCode matches) ── */
async function loadHlsStream(rawUrl) {
  await destroyPlayer();
  networkRetries = 0;
  showLoading(true);
  hideError();
  playerOverlay.classList.add("hidden");

  const streamUrl = proxiedStreamUrl(rawUrl);
  console.log("[DeepStream] Loading HLS via proxy:", streamUrl);

  if (Hls.isSupported()) {
    hls = new Hls({ maxMaxBufferLength: 60, enableWorker: true, lowLatencyMode: true });
    window.__hlsInstance = hls;

    hls.loadSource(streamUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
      showLoading(false);
      buildQualitySelectorHls(data.levels);
      setDefault720p(data.levels);
      video.muted = false;
      video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
      updateActiveQualityButton(data.level);
    });

    hls.on(Hls.Events.ERROR, (event, data) => {
      console.warn("[HLS Error]", data);
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            destroyPlayer();
            showError("Stream error. The match may have ended or is temporarily unavailable.");
            break;
        }
      }
    });

    video.addEventListener("playing", () => showLoading(false), { once: true });

  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = streamUrl;
    video.load();
    video.muted = false;
    video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
    video.addEventListener("playing", () => showLoading(false), { once: true });
    video.addEventListener("error", () => { showLoading(false); showError("Native HLS playback failed."); }, { once: true });
  } else {
    showLoading(false);
    showError("Your browser does not support HLS playback.");
  }
}

/* ── Quality Selector UI ── */
function buildQualitySelectorHls(levels) {
  const container = document.getElementById("quality-selector");
  if (!container) return;

  if (!levels || levels.length <= 1) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  container.innerHTML = "";

  const autoBtn = document.createElement("button");
  autoBtn.type = "button";
  autoBtn.className = "quality-btn";
  autoBtn.textContent = "Auto";
  autoBtn.dataset.level = "-1";
  autoBtn.addEventListener("click", () => {
    if (hls) hls.currentLevel = -1;
    container.querySelectorAll(".quality-btn").forEach(b => b.classList.remove("active"));
    autoBtn.classList.add("active");
  });
  container.appendChild(autoBtn);

  const sorted = levels
    .map((lvl, idx) => ({ ...lvl, index: idx }))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  let defaultIdx = -1;
  const level720 = sorted.find(l => l.height === 720);
  if (level720) defaultIdx = level720.index;
  else if (sorted.length > 0) defaultIdx = sorted[0].index;

  sorted.forEach((lvl) => {
    if (!lvl.height) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quality-btn";
    btn.textContent = `${lvl.height}p`;
    btn.dataset.level = String(lvl.index);
    if (lvl.index === defaultIdx) btn.classList.add("active");
    btn.addEventListener("click", () => {
      if (hls) hls.currentLevel = lvl.index;
      container.querySelectorAll(".quality-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
    container.appendChild(btn);
  });

  container.classList.remove("hidden");
}

function setDefault720p(levels) {
  if (!hls || !levels || !levels.length) return;
  const idx720 = levels.findIndex(l => l.height === 720);
  if (idx720 !== -1) hls.currentLevel = idx720;
}

function updateActiveQualityButton(levelIdx) {
  const container = document.getElementById("quality-selector");
  if (!container) return;
  const targetLevel = hls && hls.autoLevelEnabled ? "-1" : String(levelIdx);
  container.querySelectorAll(".quality-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.level === targetLevel);
  });
}

function hideQualitySelector() {
  const container = document.getElementById("quality-selector");
  if (container) { container.classList.add("hidden"); container.innerHTML = ""; }
}

/* ── Destroy Player (both engines) ── */
async function destroyPlayer() {
  if (hls) {
    try { hls.destroy(); } catch(e) {}
    hls = null;
  }
  if (shakaPlayer) {
    try { await shakaPlayer.destroy(); } catch(e) {}
    shakaPlayer = null;
  }
  window.__hlsInstance = null;
  video.pause();
  video.removeAttribute("src");
  video.load();
  hideQualitySelector();
}

/* ── Now Playing ── */
/** @param {Channel} ch */
function updateNowPlaying(ch) {
  nowTitle.textContent = ch.title;
  nowGroup.textContent = ch.group;
  nowUrl.textContent   = ch.url;

  if (ch.logo) {
    nowLogo.src = ch.logo;
    nowLogo.classList.remove("hidden");
    nowLogo.onerror = () => nowLogo.classList.add("hidden");
    video.poster = ch.logo;
  } else {
    nowLogo.classList.add("hidden");
    nowLogo.removeAttribute("src");
    video.removeAttribute("poster");
  }
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
    (c) => c.title.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)
  );
  renderChannelList(filtered);
}
channelSearch.addEventListener("input", (e) => filterChannels(e.target.value));

/* ── Drawer ── */
const sidebar        = $("#sidebar");
const drawerBackdrop = $("#drawer-backdrop");

function openDrawer()  { sidebar.classList.add("open"); drawerBackdrop.classList.remove("hidden"); document.body.classList.add("drawer-open"); }
function closeDrawer() { sidebar.classList.remove("open"); drawerBackdrop.classList.add("hidden"); document.body.classList.remove("drawer-open"); }

$("#btn-channels")?.addEventListener("click", openDrawer);
$("#btn-close-drawer")?.addEventListener("click", closeDrawer);
drawerBackdrop?.addEventListener("click", closeDrawer);

$("#btn-retry")?.addEventListener("click", () => { if (activeChannel) playChannel(activeChannel); });

window.addEventListener("beforeunload", destroyPlayer);

/* ── Boot ── */
loadEvents();
startRefresh();

/* Expose globally for index.html inline script */
window.playChannel = playChannel;
