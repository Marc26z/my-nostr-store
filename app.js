/* =========================================================================
 * Nostr classifieds (NIP-99) — dependency-free, runs entirely in-browser.
 * ========================================================================= */

/* ----------------------------- Configuration ----------------------------- */

const CONFIG = {
  // Author of the listings. Accepts an npub (npub1…) or a 64-char hex pubkey.
  // Can also be overridden with ?author=npub… in the URL.
  author: "npub1marc26z8nh3xkj5rcx7ufkatvx6ueqhp5vfw9v5teq26z254renshtf3g0",

  // Relays to fetch from. Add/remove as you like.
  // relay.conduit.market + relay.noswhere.com carry Conduit/Shopstr NIP-99 listings.
  relays: [
    "wss://relay.conduit.market",
    "wss://relay.noswhere.com",
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.primal.net",
    "wss://relay.nostr.band",
    "wss://purplepag.es",
    "wss://relay.snort.social",
  ],

  // Listings are kind:30402. (kind:30403 drafts are ignored on purpose.)
  kind: 30402,
};

/* ------------------------------- Bech32 ---------------------------------- */

const BECH32_CHARS = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_MAP = {};
for (let i = 0; i < BECH32_CHARS.length; i++) BECH32_MAP[BECH32_CHARS[i]] = i;

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function bech32Decode(str) {
  if (str.length < 8 || str.length > 1000) throw new Error("invalid bech32 length");
  const lower = str.toLowerCase();
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) throw new Error("invalid bech32 separator");
  const hrp = lower.slice(0, pos);
  const dataPart = lower.slice(pos + 1);
  const data = [];
  for (const c of dataPart) {
    if (!(c in BECH32_MAP)) throw new Error("invalid bech32 character");
    data.push(BECH32_MAP[c]);
  }
  const values = bech32HrpExpand(hrp).concat(data);
  if (bech32Polymod(values) !== 1) throw new Error("invalid bech32 checksum");
  return { hrp, data: data.slice(0, -6) };
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    throw new Error("invalid padding");
  }
  return out;
}

function bech32Encode(hrp, data) {
  const values = bech32HrpExpand(hrp).concat(data);
  const polymod = bech32Polymod(values.concat([0, 0, 0, 0, 0, 0])) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((polymod >> (5 * (5 - i))) & 31);
  return hrp + "1" + data.concat(checksum).map((d) => BECH32_CHARS[d]).join("");
}

function npubToHex(npub) {
  const { hrp, data } = bech32Decode(npub);
  if (hrp !== "npub") throw new Error("expected npub");
  return convertBits(data, 5, 8, false).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToNpub(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bech32Encode("npub", convertBits(bytes, 8, 5, true));
}

function resolveAuthor(input) {
  const v = (input || "").trim();
  if (/^npub1[0-9a-z]{20,}$/i.test(v)) return npubToHex(v);
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
  throw new Error("author must be an npub or 64-char hex pubkey");
}

/* ------------------------------ Utilities -------------------------------- */

const $ = (sel) => document.querySelector(sel);

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getTag(event, name) {
  const t = (event.tags || []).find((tag) => tag[0] === name);
  return t || null;
}

function getTags(event, name) {
  return (event.tags || []).filter((tag) => tag[0] === name);
}

/* --------------------------- NIP-99 parsing ------------------------------ */

function extractMarkdownImages(md) {
  const urls = [];
  const re = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
  let m;
  while ((m = re.exec(md))) urls.push(m[1]);
  return urls;
}

function parseListing(event) {
  const meta = getTag(event, "d");
  const title = getTag(event, "title")?.[1] || firstLine(event.content) || "Untitled listing";
  const summary = getTag(event, "summary")?.[1] || "";
  const location = getTag(event, "location")?.[1] || "";
  const status = (getTag(event, "status")?.[1] || "active").toLowerCase();
  const publishedAt = parseInt(getTag(event, "published_at")?.[1] || "", 10) || event.created_at;

  const priceTag = getTag(event, "price");
  const price = priceTag
    ? { amount: priceTag[1], currency: (priceTag[2] || "").toUpperCase(), frequency: priceTag[3] || "" }
    : null;

  const images = [];
  const addImage = (u) => {
    if (/^https?:\/\//i.test(u || "") && !images.includes(u)) images.push(u);
  };
  for (const t of getTags(event, "image")) addImage(t[1]);
  for (const u of extractMarkdownImages(event.content || "")) addImage(u);

  const tags = getTags(event, "t").map((t) => t[1]).filter(Boolean);

  return {
    id: event.id,
    event,
    d: meta ? meta[1] : event.id,
    title,
    summary,
    content: event.content || "",
    location,
    status,
    sold: status === "sold",
    publishedAt,
    price,
    images,
    tags,
    createdAt: event.created_at,
  };
}

function firstLine(text) {
  const line = (text || "").split("\n").find((l) => l.trim());
  return line ? line.replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim().slice(0, 120) : "";
}

function formatPrice(price) {
  if (!price) return "";
  const num = Number(price.amount);
  const freq = price.frequency ? ` / ${price.frequency}` : "";
  let amountStr = price.amount;

  // Bitcoin units get friendly formatting.
  if (num && /^(SAT|SATS|SATOSHI|SATOSHIS)$/.test(price.currency)) {
    return `${new Intl.NumberFormat(undefined).format(num)} sats${freq}`;
  }
  if (num && price.currency === "BTC") {
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(num)} BTC${freq}`;
  }

  if (num && /^[A-Z]{3}$/.test(price.currency) && isFiat(price.currency)) {
    try {
      const s = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: price.currency,
        maximumFractionDigits: 2,
      }).format(num);
      return s + freq;
    } catch (_) { /* fall through */ }
  }

  if (!Number.isNaN(num)) {
    amountStr = new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(num);
  }
  const cur = price.currency ? ` ${price.currency}` : "";
  return `${amountStr}${cur}${freq}`;
}

function isFiat(code) {
  try {
    new Intl.NumberFormat(undefined, { style: "currency", currency: code });
    return true;
  } catch (_) {
    return false;
  }
}

/* ---------------------- Minimal, safe Markdown render -------------------- */

function renderInline(text) {
  let s = escapeHtml(text);
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, alt, url) => `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  s = s.replace(/nostr:(n[a-z0-9]+)/gi,
    (_, bech) => `<a href="https://njump.me/${bech}" target="_blank" rel="noopener noreferrer">${bech.slice(0, 12)}…</a>`);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  return s;
}

function renderMarkdown(md) {
  const lines = (md || "").replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let listOpen = false;
  const closeList = () => { if (listOpen) { html += "</ul>"; listOpen = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); html += "<br>"; continue; }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { closeList(); html += `<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`; continue; }

    const li = line.match(/^\s*[-*+]\s+(.*)$/);
    if (li) {
      if (!listOpen) { html += "<ul>"; listOpen = true; }
      html += `<li>${renderInline(li[1])}</li>`;
      continue;
    }
    closeList();
    html += `<p>${renderInline(line)}</p>`;
  }
  closeList();
  return html;
}

/* ------------------------------ Relay pool ------------------------------- */

class RelayPool {
  constructor(urls, onEvent, onStatus) {
    this.urls = urls;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.sockets = new Map();
    this.subId = "classifieds-" + Math.random().toString(36).slice(2, 8);
    this.openCount = 0;
  }

  connect(filter) {
    this.close();
    for (const url of this.urls) this._connectOne(url, filter);
  }

  _connectOne(url, filter) {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (_) {
      this.onStatus(url, "error");
      return;
    }
    const entry = { ws, url, eose: false };
    this.sockets.set(url, entry);
    this.onStatus(url, "connecting");

    const timeout = setTimeout(() => {
      if (!entry.eose) { this.onStatus(url, "error"); try { ws.close(); } catch (_) {} }
    }, 12000);

    ws.onopen = () => {
      this.openCount++;
      this.onStatus(url, "open");
      ws.send(JSON.stringify(["REQ", this.subId, filter]));
    };
    ws.onmessage = (msg) => {
      let data;
      try { data = JSON.parse(msg.data); } catch (_) { return; }
      const [type, sub, payload] = data;
      if (sub !== this.subId) return;
      if (type === "EVENT" && payload) {
        this.onEvent(payload, url);
      } else if (type === "EOSE") {
        entry.eose = true;
        clearTimeout(timeout);
        this.onStatus(url, "eose");
        try { ws.send(JSON.stringify(["CLOSE", this.subId])); } catch (_) {}
      } else if (type === "NOTICE") {
        /* informational */
      }
    };
    ws.onerror = () => { this.onStatus(url, "error"); };
    ws.onclose = () => {
      clearTimeout(timeout);
      if (!entry.eose) this.onStatus(url, "closed");
    };
  }

  close() {
    for (const { ws } of this.sockets.values()) {
      try { ws.onclose = null; ws.close(); } catch (_) {}
    }
    this.sockets.clear();
    this.openCount = 0;
  }
}

/* --------------------------------- App ----------------------------------- */

const state = {
  pubkey: "",
  npub: "",
  listings: new Map(), // key: d -> listing (latest created_at wins)
  pool: null,
  search: "",
  tag: "",
  showSold: false,
  eoseSeen: false,
};

function setStatus(stateName, text) {
  const el = $("#conn-status");
  if (el) el.dataset.state = stateName;
  if (text) $("#conn-text").textContent = text;
}

function boot() {
  const params = new URLSearchParams(location.search);
  const authorInput = params.get("author") || CONFIG.author;

  try {
    state.pubkey = resolveAuthor(authorInput);
    state.npub = /^npub1/i.test(authorInput.trim()) ? authorInput.trim() : hexToNpub(state.pubkey);
  } catch (err) {
    setStatus("error", "Bad author");
    showEmpty("Invalid author", err.message);
    return;
  }

  const npubEl = $("#author-npub");
  npubEl.textContent = state.npub;
  $("#author-link").href = `https://njump.me/${state.npub}`;
  document.title = `Classifieds · ${state.npub.slice(0, 16)}…`;

  renderSkeletons();
  bindUI();
  load();
}

function load() {
  state.listings.clear();
  state.eoseSeen = false;
  setStatus("connecting", "Connecting…");
  render();

  const filter = { kinds: [CONFIG.kind], authors: [state.pubkey] };

  const settled = new Set();
  const total = CONFIG.relays.length;

  state.pool = new RelayPool(
    CONFIG.relays,
    (event) => { ingest(event); },
    (url, status) => {
      if (status === "eose" || status === "error" || status === "closed") {
        settled.add(url);
        if (!state.eoseSeen && settled.size >= total) finish();
      }
      if (status === "eose") {
        state.eoseSeen = true;
        setStatus("online", "Live");
        render();
      }
    }
  );
  state.pool.connect(filter);

  // Safety net: stop waiting after 15s.
  setTimeout(finish, 15000);
}

function finish() {
  if (state.eoseSeen) return;
  state.eoseSeen = true;
  const open = state.pool ? state.pool.openCount : 0;
  if (open > 0 || state.listings.size > 0) setStatus("online", "Loaded");
  else setStatus("error", "No relays");
  render();
}

function ingest(event) {
  if (event.kind !== CONFIG.kind) return;
  if (event.pubkey !== state.pubkey) return;

  const listing = parseListing(event);
  const existing = state.listings.get(listing.d);
  if (!existing || listing.createdAt > existing.createdAt) {
    state.listings.set(listing.d, listing);
    scheduleRender();
  }
}

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 120);
}

/* ------------------------------ Rendering -------------------------------- */

function currentListings() {
  let items = [...state.listings.values()];
  items.sort((a, b) => (b.publishedAt || b.createdAt) - (a.publishedAt || a.createdAt));

  const q = state.search.trim().toLowerCase();
  if (q) {
    items = items.filter((l) =>
      l.title.toLowerCase().includes(q) ||
      l.summary.toLowerCase().includes(q) ||
      l.location.toLowerCase().includes(q) ||
      l.tags.some((t) => t.toLowerCase().includes(q))
    );
  }
  if (state.tag) items = items.filter((l) => l.tags.includes(state.tag));
  if (!state.showSold) items = items.filter((l) => !l.sold);
  return items;
}

function renderSkeletons() {
  const grid = $("#grid");
  grid.innerHTML = Array.from({ length: 6 }).map(() => `
    <div class="skeleton">
      <div class="sk-media sk-shimmer"></div>
      <div class="sk-line sk-shimmer" style="width:70%"></div>
      <div class="sk-line sk-shimmer" style="width:45%"></div>
    </div>`).join("");
  grid.hidden = false;
  grid.setAttribute("aria-busy", "true");
  $("#empty").hidden = true;
}

function render() {
  const grid = $("#grid");
  const items = currentListings();
  updateTagFilter();
  updateCount(items);

  if (!state.eoseSeen && state.listings.size === 0) {
    grid.setAttribute("aria-busy", "true");
    return; // keep skeletons
  }

  grid.setAttribute("aria-busy", "false");

  if (items.length === 0) {
    grid.innerHTML = "";
    grid.hidden = true;
    const anyLoaded = state.listings.size > 0;
    showEmpty(
      anyLoaded ? "Nothing matches your filters" : "No listings found",
      anyLoaded
        ? "Try clearing the search box or enabling “Show sold”."
        : "This key has no active NIP-99 listings on the connected relays."
    );
    return;
  }

  $("#empty").hidden = true;
  grid.hidden = false;
  grid.innerHTML = items.map(cardHtml).join("");

  grid.querySelectorAll(".card").forEach((el) => {
    el.addEventListener("click", () => openModal(el.dataset.d));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openModal(el.dataset.d); }
    });
  });
}

function cardHtml(item) {
  const img = item.images[0];
  const media = img
    ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(item.title)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.innerHTML='<div class=\\'noimg\\'>🖼️</div>'">`
    : `<div class="noimg">🖼️</div>`;
  const price = item.price ? formatPrice(item.price) : "";
  const freqSplit = price.split(" / ");
  const priceHtml = price
    ? `<span class="price">${escapeHtml(freqSplit[0])}${freqSplit[1] ? ` <span class="freq">/ ${escapeHtml(freqSplit[1])}</span>` : ""}</span>`
    : "";

  return `
    <article class="card" tabindex="0" role="button" data-d="${escapeHtml(item.d)}"
             aria-label="${escapeHtml(item.title)}">
      <div class="card-media">
        ${item.sold ? '<span class="badge sold">Sold</span>' : ""}
        ${media}
      </div>
      <div class="card-body">
        <h3 class="card-title">${escapeHtml(item.title)}</h3>
        ${item.summary ? `<p class="card-summary">${escapeHtml(item.summary)}</p>` : ""}
        ${item.tags.length ? `<div class="tags">${item.tags.slice(0, 3).map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join("")}</div>` : ""}
        <div class="card-foot">
          ${priceHtml}
          ${item.location ? `<span class="location">📍 ${escapeHtml(item.location)}</span>` : ""}
        </div>
      </div>
    </article>`;
}

function updateCount(items) {
  const el = $("#result-count");
  if (!state.eoseSeen && state.listings.size === 0) { el.textContent = "Loading listings…"; return; }
  const total = state.listings.size;
  el.textContent = `${items.length} of ${total} listing${total === 1 ? "" : "s"} shown`;
}

function updateTagFilter() {
  const select = $("#tag-filter");
  const tags = new Set();
  for (const l of state.listings.values()) for (const t of l.tags) tags.add(t);
  const current = select.value;
  const opts = ['<option value="">All categories</option>']
    .concat([...tags].sort().map((t) => `<option value="${escapeHtml(t)}">#${escapeHtml(t)}</option>`));
  select.innerHTML = opts.join("");
  if (current && tags.has(current)) select.value = current;
}

function showEmpty(title, body) {
  const empty = $("#empty");
  $("#empty-title").textContent = title;
  $("#empty-body").textContent = body || "";
  empty.hidden = false;
}

/* -------------------------------- Modal ---------------------------------- */

function openModal(d) {
  const item = state.listings.get(d);
  if (!item) return;

  const priceHtml = item.price ? `<span class="m-price">${escapeHtml(formatPrice(item.price))}</span>` : "";
  const meta = [
    priceHtml,
    item.location ? `📍 ${escapeHtml(item.location)}` : "",
    item.sold ? "🔴 Sold" : "",
    item.publishedAt ? `🗓 ${new Date(item.publishedAt * 1000).toLocaleDateString()}` : "",
  ].filter(Boolean).join(" · ");

  const gallery = item.images.length > 1
    ? `<div class="m-gallery">${item.images.map((u) => `<img src="${escapeHtml(u)}" alt="" loading="lazy" referrerpolicy="no-referrer">`).join("")}</div>`
    : "";

  $("#modal-body").innerHTML = `
    ${item.images[0] ? `<img class="m-hero" src="${escapeHtml(item.images[0])}" alt="${escapeHtml(item.title)}" referrerpolicy="no-referrer">` : ""}
    <div class="m-body">
      <h2 class="m-title" id="modal-title">${escapeHtml(item.title)}</h2>
      ${meta ? `<div class="m-meta">${meta}</div>` : ""}
      ${item.tags.length ? `<div class="tags">${item.tags.map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      <div class="m-content">${renderMarkdown(item.content)}</div>
      ${gallery}
      <div class="m-footer">
        <a class="btn btn-ghost" href="https://njump.me/${item.id}" target="_blank" rel="noopener noreferrer">View on Nostr</a>
      </div>
    </div>`;

  $("#modal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal() {
  $("#modal").hidden = true;
  $("#modal-body").innerHTML = "";
  document.body.style.overflow = "";
}

/* --------------------------------- UI ------------------------------------ */

function bindUI() {
  let searchTimer = null;
  $("#search").addEventListener("input", (e) => {
    const v = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = v; render(); }, 120);
  });
  $("#tag-filter").addEventListener("change", (e) => { state.tag = e.target.value; render(); });
  $("#show-sold").addEventListener("change", (e) => { state.showSold = e.target.checked; render(); });
  $("#refresh-btn").addEventListener("click", () => { state.pool && state.pool.close(); load(); });

  $("#modal").addEventListener("click", (e) => { if (e.target.dataset.close !== undefined) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
}

document.addEventListener("DOMContentLoaded", boot);
