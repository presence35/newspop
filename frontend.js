const content = document.getElementById("content");
const tabs = document.getElementById("tabs");
const sidebar = document.getElementById("sidebar");
const searchInput = document.getElementById("search");
const biasChips = document.getElementById("bias-chips");
const timeChips = document.getElementById("time-chips");
let currentTab = "feed";

const filters = { geos: new Set(), biases: new Set(["left", "center", "right"]), hours: null, q: "", sort: "newest" };
let hiddenTopics = new Set(JSON.parse(localStorage.getItem("gz-hidden-topics") || "[]"));
let hiddenOutlets = new Set(JSON.parse(localStorage.getItem("gz-hidden-outlets") || "[]"));
const READ_KEY = "gz-read";
const SAVED_KEY = "gz-saved";
let readSet = new Set(JSON.parse(localStorage.getItem(READ_KEY) || "[]"));
let savedSet = new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || "[]"));
let unreadOnly = false;
const PAGE = 50;
let offset = 0;
let hasMore = true;
let storyObserver = null;
function persistSet(key, set) { localStorage.setItem(key, JSON.stringify([...set])); }

const GEO_FLAGS = { us: "🇺🇸", uk: "🇬🇧", ukraine: "🇺🇦", world: "🌐", canada: "🇨🇦", eu: "🇪🇺", africa: "🦁", australia: "🇦🇺", latam: "🦜", meast: "🕌" };
const GEO_LABELS = { us: "US", uk: "UK", ukraine: "Ukraine", world: "World", canada: "Canada", eu: "EU", africa: "Africa", australia: "Australia", latam: "Latin America", meast: "Middle East" };
const TOPIC_EMOJIS = { Politics: "🏛️", War: "⚔️", Economy: "💰", Tech: "💻", Health: "🏥", Climate: "🌍", Science: "🔬", Crime: "🚨", General: "📰" };
function topicLabel(t) { return (TOPIC_EMOJIS[t] || "") + " " + t; }
function geoLabel(code) {
  return (GEO_FLAGS[code] || "📍") + " " + (GEO_LABELS[code] || code);
}

document.querySelector("header .brand").addEventListener("click", () => {
  filters.geos.clear();
  filters.biases = new Set(["left", "center", "right"]);
  filters.hours = null;
  filters.q = "";
  filters.sort = "newest";
  hiddenTopics.clear();
  localStorage.removeItem("gz-hidden-topics");
  hiddenOutlets.clear();
  localStorage.removeItem("gz-hidden-outlets");
  unreadOnly = false;
  unreadToggle.classList.remove("on");
  searchInput.value = "";
  syncChips();
  syncSortChips();
  load({ reset: true });
});

const collapseBtn = document.getElementById("collapse-sidebar");
let sidebarCollapsed = localStorage.getItem("gz-sidebar") === "1";
function applySidebar() {
  document.getElementById("layout").classList.toggle("collapsed", sidebarCollapsed);
  collapseBtn.textContent = sidebarCollapsed ? "›" : "‹";
  collapseBtn.title = sidebarCollapsed ? "Show filters" : "Hide filters";
}
collapseBtn.addEventListener("click", () => {
  sidebarCollapsed = !sidebarCollapsed;
  localStorage.setItem("gz-sidebar", sidebarCollapsed ? "1" : "0");
  applySidebar();
});
applySidebar();

const loadMoreBtn = document.createElement("button");
loadMoreBtn.id = "load-more";
loadMoreBtn.className = "hidden";
loadMoreBtn.textContent = "Load more";
loadMoreBtn.addEventListener("click", loadMore);

tabs.addEventListener("click", (e) => {
  if (e.target.tagName !== "BUTTON") return;
  document.querySelectorAll("#tabs button").forEach(b => b.classList.remove("active"));
  e.target.classList.add("active");
  currentTab = e.target.dataset.tab;
  document.getElementById("sidebar").style.display = currentTab === "sources" ? "none" : "";
  document.getElementById("layout").classList.toggle("sources-view", currentTab === "sources");
  load({ reset: true });
  writeStateToUrl("push");
});

function biasClass(bias) {
  if (bias === null) return "c";
  if (bias <= -1) return "l";
  if (bias >= 1) return "r";
  return "c";
}

function renderStory(story, opts = {}) {
  const div = document.createElement("div");
  div.className = "story";
  div.dataset.story = story.clusterId;

  let blindspotTag = "";
  if (opts.blindspot) {
    blindspotTag = `<div class="blindspot-tag ${story.blindspotSide}">Blindspot — ${story.note}</div>`;
  }

  const barWidth = story.ratedCount || 1;
  const bar = `
    <div class="bias-bar">
      <div class="l" style="width:${(story.left / barWidth) * 100}%"></div>
      <div class="c" style="width:${(story.center / barWidth) * 100}%"></div>
      <div class="r" style="width:${(story.right / barWidth) * 100}%"></div>
    </div>`;

  const chips = story.sources.map(s => {
    const seen = s.created_at ? new Date(s.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
    const extras = (s.extra && s.extra.length) ? s.extra.map(x => `
      <a class="src-extra-link" href="${x.link}" target="_blank" rel="noopener" title="${escapeHtml(x.title || "")}" onclick="trackClick(${x.id}, ${story.clusterId})">${escapeHtml(x.title || "Article")}</a>`).join("") : "";
    const moreBtn = (s.extra && s.extra.length)
      ? `<button class="src-more" title="${s.extra.length} more update${s.extra.length > 1 ? "s" : ""} from ${escapeHtml(s.name)}">▾${s.extra.length}</button>`
      : "";
    return `
    <div class="source-group">
      <div class="src-row">
        <a href="${s.link}" target="_blank" rel="noopener" class="source-chip bias-${biasClass(s.bias)}" title="${escapeHtml(s.name + (seen ? " — seen " + seen : ""))}"
           onclick="trackClick(${s.id}, ${story.clusterId})"><img class="src-logo" src="/logo/${encodeURIComponent(s.logo)}?v=3" alt="" loading="lazy" onerror="this.style.display='none'">${s.name}</a>
        ${moreBtn}
      </div>
      ${extras ? `<div class="src-extra">${extras}</div>` : ""}
    </div>`;
  }).join("");

  const img = story.image
    ? `<img class="story-img" src="${escapeHtml(story.image)}" loading="lazy" onerror="this.style.display='none'" onload="if(this.naturalWidth<50||this.naturalHeight<50)this.style.display='none'" alt="">`
    : "";

  const topic = story.topic || (story.sources[0] && story.sources[0].topic);
  const topicTag = topic && topic !== "General" ? `<span class="topic-tag">${escapeHtml(topicLabel(topic))}</span>` : "";

  const saved = savedSet.has(String(story.clusterId));
  const unread = !readSet.has(String(story.clusterId));
  const saveBtn = opts.saved
    ? `<button class="save-btn on" data-save="${story.clusterId}" title="Remove from saved">🗑️</button>`
    : `<button class="save-btn ${saved ? "on" : ""}" data-save="${story.clusterId}" title="${saved ? "Remove from saved" : "Save for later"}">${saved ? "✓" : "🔖"}</button>`;

  div.innerHTML = `
    ${blindspotTag}
    ${img}
    <div class="story-head">${unread ? `<span class="unread-dot" title="Unread"></span>` : ""}<h2>${escapeHtml(story.headline)}</h2></div>
    ${bar}
    <div class="meta">
      ${story.publishedAt ? `<span title="${new Date(story.publishedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}">${timeAgo(story.publishedAt)}</span>` : ""}
      ${topicTag}
      ${story.ratedCount ? `<span>${story.leftPct}% left · ${story.centerPct}% center · ${story.rightPct}% right</span>` : ""}
      ${saveBtn}
    </div>
    <div class="sources">${chips}</div>
    <button class="sources-toggle hidden">Show all sources</button>
  `;

  // Show the expand toggle only when the source chips overflow 3 rows or any
  // outlet has grouped extra links. Runs after append (rAF) so heights exist.
  requestAnimationFrame(() => {
    const srcEl = div.querySelector(".sources");
    const srcToggle = div.querySelector(".sources-toggle");
    const hasExtras = story.sources.some((s) => s.extra && s.extra.length);
    if (srcEl && srcToggle && (srcEl.scrollHeight > srcEl.clientHeight + 2 || hasExtras)) {
      srcToggle.classList.remove("hidden");
      updateSourcesToggle(srcEl);
    }
  });
  return div;
}

function updateSourcesToggle(section) {
  const story = section.closest(".story");
  if (!story) return;
  const toggle = story.querySelector(".sources-toggle");
  if (!toggle) return;
  const n = section.querySelectorAll(".source-group").length;
  toggle.textContent = section.classList.contains("expanded") ? "Show less" : `Show all ${n} sources`;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return min === 1 ? "1 minute ago" : `${min} minutes ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return hrs === 1 ? "1 hour ago" : `${hrs} hours ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return days === 1 ? "1 day ago" : `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

function trackClick(articleId, clusterId) {
  fetch("/api/click", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ articleId })
  });
  if (clusterId !== undefined && clusterId !== null && !readSet.has(clusterId)) {
    readSet.add(clusterId);
    persistSet(READ_KEY, readSet);
    const el = document.querySelector(`.story[data-story="${clusterId}"] .unread-dot`);
    if (el) el.remove();
  }
}
window.trackClick = trackClick;

// ---------- feed fetching + filters ----------
function feedParams(off) {
  const p = new URLSearchParams();
  if (filters.geos.size) p.set("geo", [...filters.geos].join(","));
  if (hiddenTopics.size) p.set("notopic", [...hiddenTopics].join(","));
  if (hiddenOutlets.size) p.set("nooutlet", [...hiddenOutlets].join(","));
  if (filters.hours) p.set("hours", filters.hours);
  if (filters.q) p.set("q", filters.q);
  if (filters.sort !== "newest") p.set("sort", filters.sort);
  p.set("limit", PAGE);
  p.set("offset", off);
  return p.toString();
}

// ---------- URL state (tab only, back button navigates tabs) ----------
const VALID_TABS = new Set(["feed", "blindspots", "mybias", "saved", "sources"]);
function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  const tab = p.get("tab");
  if (tab && VALID_TABS.has(tab)) currentTab = tab;
  hiddenTopics = new Set(JSON.parse(localStorage.getItem("gz-hidden-topics") || "[]"));
  hiddenOutlets = new Set(JSON.parse(localStorage.getItem("gz-hidden-outlets") || "[]"));
}

function stateParams() {
  const p = new URLSearchParams();
  if (currentTab !== "feed") p.set("tab", currentTab);
  return p;
}

function writeStateToUrl(mode) {
  const qs = stateParams().toString();
  history[mode === "replace" ? "replaceState" : "pushState"](null, "", qs ? "?" + qs : location.pathname);
}

function dominantBias(s) {
  if (!s.ratedCount) return null;
  if (s.left >= s.center && s.left >= s.right) return "left";
  if (s.right >= s.center && s.right >= s.left) return "right";
  return "center";
}

function passesBias(s) {
  const d = dominantBias(s);
  if (d === null) return true;
  return filters.biases.has(d);
}

function passesUnread(s) {
  return !unreadOnly || !readSet.has(s.clusterId);
}

async function fetchFeedPage(off) {
  const res = await fetch("/api/feed?" + feedParams(off));
  return res.json();
}

function appendLoadMore() {
  loadMoreBtn.classList.remove("hidden");
  content.appendChild(loadMoreBtn);
}

async function load(opts = {}) {
  if (opts.reset) offset = 0;
  if (currentTab === "feed") return loadFeed();
  if (currentTab === "blindspots") return loadBlindspots();
  if (currentTab === "mybias") return loadMyBias();
  if (currentTab === "saved") return loadSaved();
  if (currentTab === "sources") return loadSources();
}

async function loadFeed() {
  content.innerHTML = `<div class="empty">Loading...</div>`;
  if (hiddenOutlets.size > 0) {
    const srcRes = await fetch("/api/sources");
    const { sources } = await srcRes.json();
    if (sources.length > 0 && hiddenOutlets.size >= sources.length) {
      content.innerHTML = `<div class="empty">All sources are hidden. Go to the <strong>Sources</strong> tab to enable some.</div>`;
      return;
    }
  }
  const raw = await fetchFeedPage(offset);
  let stories = raw.filter(passesBias).filter(passesUnread);
  hasMore = raw.length === PAGE;
  content.innerHTML = "";
  if (stories.length === 0) {
    content.innerHTML = `<div class="empty">No stories match your filters. Ingestion may still be running — check back in a minute.</div>`;
    return;
  }
  stories.forEach(s => content.appendChild(renderStory(s)));
  observeStories();
  appendLoadMore();
}

async function loadMore() {
  offset += PAGE;
  loadMoreBtn.disabled = true;
  const raw = await fetchFeedPage(offset);
  let stories = raw.filter(passesBias).filter(passesUnread);
  hasMore = raw.length === PAGE;
  loadMoreBtn.remove();
  loadMoreBtn.disabled = false;
  stories.forEach(s => content.appendChild(renderStory(s)));
  observeStories();
  if (hasMore) appendLoadMore();
}

async function loadBlindspots() {
  const res = await fetch("/api/blindspots");
  const stories = await res.json();
  content.innerHTML = "";
  if (stories.length === 0) {
    content.innerHTML = `<div class="empty">No blindspots detected right now.</div>`;
    return;
  }
  stories.forEach(s => content.appendChild(renderStory(s, { blindspot: true })));
  observeStories();
}

async function loadSaved() {
  content.innerHTML = `<div class="empty">Loading...</div>`;
  if (savedSet.size === 0) {
    content.innerHTML = `<div class="empty">No saved stories. Tap the 🔖 on a story to save it here.</div>`;
    return;
  }
  const res = await fetch("/api/feed?" + new URLSearchParams({ ids: [...savedSet].join(","), limit: PAGE * 4 }));
  const stories = await res.json();
  content.innerHTML = "";
  if (stories.length === 0) {
    content.innerHTML = `<div class="empty">No saved stories found.</div>`;
    return;
  }
  stories.forEach(s => content.appendChild(renderStory(s, { saved: true })));
  observeStories();
}

let sourcesSortMode = "enabled";
let sourcesSortDir = 1;
async function loadSources() {
  content.innerHTML = `<div class="empty">Loading sources...</div>`;
  const res = await fetch("/api/sources");
  const { sources } = await res.json();
  content.innerHTML = "";

  const header = document.createElement("div");
  header.className = "sources-header";
  header.innerHTML = `
    <h2>All Sources (${sources.length})</h2>
    <div class="sort-row">
      <span>Sort:</span>
      <div class="sort-controls">
        <button class="sort-btn" data-sort="alpha">A-Z</button>
        <button class="sort-btn" data-sort="spectrum">Spectrum</button>
        <button class="sort-btn" data-sort="factuality">Factuality</button>
        <button class="sort-btn active" data-sort="enabled">Enabled</button>
      </div>
      <div class="sources-bulk">
        <button id="sources-enable-all">All</button>
        <button id="sources-disable-all">None</button>
      </div>
    </div>`;
  content.appendChild(header);
  header.querySelector(".sort-btn[data-sort='" + sourcesSortMode + "']").textContent += sourcesSortDir === 1 ? " ↑" : " ↓";

  header.querySelector("#sources-enable-all").addEventListener("click", () => {
    hiddenOutlets.clear();
    persistSet("gz-hidden-outlets", hiddenOutlets);
    writeStateToUrl("replace");
    renderSourceCards(sources);
  });
  header.querySelector("#sources-disable-all").addEventListener("click", () => {
    sources.forEach(s => hiddenOutlets.add(s.domain));
    persistSet("gz-hidden-outlets", hiddenOutlets);
    writeStateToUrl("replace");
    renderSourceCards(sources);
  });
  header.querySelectorAll(".sort-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (sourcesSortMode === btn.dataset.sort) sourcesSortDir *= -1;
      else { sourcesSortMode = btn.dataset.sort; sourcesSortDir = 1; }
      header.querySelectorAll(".sort-btn").forEach(b => {
        b.classList.toggle("active", b === btn);
        b.textContent = b.dataset.sort === sourcesSortMode ? b.textContent.replace(/ [↑↓]$/, "") + (sourcesSortDir === 1 ? " ↑" : " ↓") : b.textContent.replace(/ [↑↓]$/, "");
      });
      renderSourceCards(sources);
    });
  });

  const grid = document.createElement("div");
  grid.className = "sources-grid";
  grid.id = "sources-grid";
  content.appendChild(grid);

  const footer = document.createElement("div");
  footer.className = "sources-footer";
  footer.innerHTML = `
    Bias &amp; factuality ratings curated from
    <a href="https://www.allsides.com/media-bias/media-bias-ratings" target="_blank" rel="noopener">AllSides</a>,
    <a href="https://adfontesmedia.com/" target="_blank" rel="noopener">Ad Fontes Media</a>, and
    <a href="https://mediabiasfactcheck.com/" target="_blank" rel="noopener">Media Bias/Fact Check</a>.`;
  content.appendChild(footer);

  renderSourceCards(sources);
}

function sortKey(name) { return (name || "").replace(/^The\s+/i, ""); }
function renderSourceCards(sources) {
  const grid = document.getElementById("sources-grid");
  if (!grid) return;
  grid.innerHTML = "";

  let sorted = [...sources];
  const d = sourcesSortDir;
  if (sourcesSortMode === "enabled") {
    sorted.sort((a, b) => d * ((hiddenOutlets.has(a.domain) ? 1 : 0) - (hiddenOutlets.has(b.domain) ? 1 : 0)) || sortKey(a.name).localeCompare(sortKey(b.name)));
  } else if (sourcesSortMode === "spectrum") {
    sorted.sort((a, b) => d * (a.bias - b.bias) || sortKey(a.name).localeCompare(sortKey(b.name)));
  } else if (sourcesSortMode === "alpha") {
    sorted.sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)) * d || 0);
  } else if (sourcesSortMode === "factuality") {
    sorted.sort((a, b) => d * (b.factuality - a.factuality) || sortKey(a.name).localeCompare(sortKey(b.name)));
  }

  for (const s of sorted) {
    const enabled = !hiddenOutlets.has(s.domain);
    const card = document.createElement("div");
    card.className = "source-card " + (enabled ? "on" : "off");

    const biasPct = ((s.bias + 3) / 6) * 100;
    const biasColor = s.bias < 0 ? "var(--left)" : s.bias > 0 ? "var(--right)" : "var(--center)";
    const biasCls = s.bias < 0 ? "bl" : s.bias > 0 ? "br" : "bc";
    const biasLabel = s.bias <= -3 ? "Far-left" : s.bias === -2 ? "Left" : s.bias === -1 ? "Lean-left" : s.bias === 0 ? "Center" : s.bias === 1 ? "Lean-right" : s.bias === 2 ? "Right" : "Far-right";

    const geoFlag = GEO_FLAGS[s.geo] || "📍";
    const geoLbl = GEO_LABELS[s.geo] || s.geo || "Unknown";

    let factualityPips = "";
    for (let i = 0; i < 10; i++) {
      factualityPips += `<div class="factuality-pip${i < s.factuality ? " filled" : ""}"></div>`;
    }

    card.innerHTML = `
      <div class="source-card-top">
        <img class="source-card-logo" src="/logo/${encodeURIComponent(s.logo)}?v=3" alt="" loading="lazy" onerror="this.style.display='none'">
        <div class="source-card-name" title="${escapeHtml(s.domain)}">${escapeHtml(s.name)}</div>
        <span class="source-card-flag" title="${geoLbl}">${geoFlag}</span>
      </div>
      <div class="source-card-row">
        <span class="source-card-label">Bias</span>
        <div class="bias-bar-track">
          <div class="bias-bar-fill" style="left:0;width:${biasPct}%;background:${biasColor};opacity:0.3"></div>
          <div class="bias-bar-marker" style="left:calc(${biasPct}% - 1px)"></div>
        </div>
        <span class="bias-label ${biasCls}">${biasLabel}</span>
      </div>
      <div class="source-card-row">
        <span class="source-card-label">Factual</span>
        <div class="factuality-bar">${factualityPips}</div>
        <span style="font-size:11px;color:var(--muted)">${s.factuality}/10</span>
      </div>
      <div class="source-card-meta">
        <span class="source-badge owner-badge" title="Parent company / ownership">${escapeHtml(s.owner || "Unknown")}</span>
        <span class="source-badge" title="Who rated this outlet's bias & factuality">${escapeHtml(s.source || "Unknown source")}</span>
      </div>`;

    card.addEventListener("click", () => {
      const nowOn = hiddenOutlets.has(s.domain);
      if (nowOn) hiddenOutlets.delete(s.domain);
      else hiddenOutlets.add(s.domain);
      persistSet("gz-hidden-outlets", hiddenOutlets);
      writeStateToUrl("replace");
      card.classList.toggle("on", !hiddenOutlets.has(s.domain));
      card.classList.toggle("off", hiddenOutlets.has(s.domain));
    });

    grid.appendChild(card);
  }
}

// Mark a story read the first time it scrolls into view, so the Unread-only
// filter and the dot badge reflect what you've actually seen.
function observeStories() {
  if (!("IntersectionObserver" in window)) return;
  if (!storyObserver) {
    storyObserver = new IntersectionObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const cid = e.target.dataset.story;
        if (cid && !readSet.has(cid)) { readSet.add(cid); changed = true; }
        storyObserver.unobserve(e.target);
      }
      if (changed) {
        persistSet(READ_KEY, readSet);
        document.querySelectorAll("#content .story").forEach((el) => {
          if (readSet.has(el.dataset.story)) {
            const dot = el.querySelector(".unread-dot");
            if (dot) dot.remove();
          }
        });
      }
    }, { threshold: 0.15 });
  }
  content.querySelectorAll(".story").forEach((el) => {
    if (!readSet.has(el.dataset.story)) storyObserver.observe(el);
  });
}

content.addEventListener("click", (e) => {
  const moreBtn = e.target.closest(".src-more");
  if (moreBtn) {
    const section = moreBtn.closest(".sources");
    if (section) {
      section.classList.toggle("expanded");
      updateSourcesToggle(section);
    }
    return;
  }
  const srcToggle = e.target.closest(".sources-toggle");
  if (srcToggle) {
    const story = srcToggle.closest(".story");
    const section = story && story.querySelector(".sources");
    if (section) {
      section.classList.toggle("expanded");
      updateSourcesToggle(section);
    }
    return;
  }
  const btn = e.target.closest(".save-btn");
  if (!btn) return;
  const cid = btn.dataset.save;
  if (currentTab === "saved") {
    savedSet.delete(cid);
    persistSet(SAVED_KEY, savedSet);
    const story = btn.closest(".story");
    if (story) story.remove();
    if (!content.querySelector(".story")) {
      content.innerHTML = `<div class="empty">No saved stories. Tap the 🔖 on a story to save it here.</div>`;
    }
  } else {
    if (savedSet.has(cid)) savedSet.delete(cid); else savedSet.add(cid);
    persistSet(SAVED_KEY, savedSet);
    const on = savedSet.has(cid);
    btn.classList.toggle("on", on);
    btn.title = on ? "Remove from saved" : "Save for later";
    btn.textContent = on ? "✓" : "🔖";
  }
});

async function loadMyBias() {
  const res = await fetch("/api/my-bias");
  const b = await res.json();
  let hist = "";
  if (b.history && b.history.some(d => d.total > 0)) {
    hist = `<div class="hist-title">Last 7 days</div>` + b.history.map(d => `
      <div class="hist-day">
        <span class="hist-date">${d.date}</span>
        <div class="hist-bar">
          <div class="l" style="width:${d.leftPct}%"></div>
          <div class="c" style="width:${d.centerPct}%"></div>
          <div class="r" style="width:${d.rightPct}%"></div>
        </div>
        <span class="hist-pct">${d.left}L · ${d.center}C · ${d.right}R</span>
      </div>`).join("");
  }
  content.innerHTML = `
    <div class="my-bias-summary">
      <strong style="color:var(--text)">Your reading, ${b.totalClicks} click${b.totalClicks === 1 ? "" : "s"} tracked</strong><br><br>
      Left: ${b.leftPct}% (${b.left}) &nbsp; Center: ${b.centerPct}% (${b.center}) &nbsp; Right: ${b.rightPct}% (${b.right})
      ${b.unrated ? `<br>Unrated outlet clicks: ${b.unrated}` : ""}
    </div>
    ${hist || `<div class="empty">No tracked clicks in the last 7 days.</div>`}
  `;
}

// ---------- sidebar: filter chips ----------
async function loadFilters() {
  const res = await fetch("/api/filters");
  const data = await res.json();
  buildChips("geo", data.geos || []);
  buildChips("topic", data.topics || []);
  syncChips();
}

function buildChips(kind, items) {
  const el = document.getElementById(kind + "-chips");
  el.innerHTML = "";
  if (kind === "geo") items = [...items].sort((a, b) => geoLabel(a.name).localeCompare(geoLabel(b.name)));
  for (const item of items) {
    const b = document.createElement("button");
    b.className = "chip";
    b.dataset.kind = kind;
    b.dataset.value = item.name;
    let label = "";
    if (kind === "geo") label = geoLabel(item.name);
    else if (kind === "topic") label = topicLabel(item.name);
    b.innerHTML = `<span class="chip-name">${escapeHtml(label)}</span><span class="chip-count">${item.count}</span>`;
    if (kind === "topic") b.classList.toggle("on", !hiddenTopics.has(item.name));
    el.appendChild(b);
  }
}

function toggleFilter(kind, value) {
  const set = kind === "geo" ? filters.geos : null;
  if (!set) return;
  const active = !set.has(value);
  if (active) { set.delete("__none__"); set.add(value); } else set.delete(value);
  syncChips();
  load({ reset: true });
}

function toggleHidden(kind, value) {
  const hidden = kind === "topic" ? hiddenTopics : hiddenOutlets;
  if (hidden.has(value)) hidden.delete(value); else hidden.add(value);
  localStorage.setItem("gz-hidden-" + (kind === "topic" ? "topics" : "outlets"), JSON.stringify([...hidden]));
  syncChips();
  load({ reset: true });
}

sidebar.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip[data-kind]");
  if (!chip) return;
  if (chip.dataset.kind === "topic") toggleHidden(chip.dataset.kind, chip.dataset.value);
  else toggleFilter(chip.dataset.kind, chip.dataset.value);
});

biasChips.addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (!c) return;
  const v = c.dataset.bias;
  if (filters.biases.has(v)) filters.biases.delete(v); else filters.biases.add(v);
  c.classList.toggle("on", filters.biases.has(v));
  syncResetButtons();
  load({ reset: true });
});

timeChips.addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (!c) return;
  document.querySelectorAll("#time-chips .chip").forEach(x => x.classList.remove("on"));
  c.classList.add("on");
  filters.hours = c.dataset.hours ? Number(c.dataset.hours) : null;
  syncResetButtons();
  load({ reset: true });
});

const sortChips = document.getElementById("sort-chips");
sortChips.addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (!c) return;
  filters.sort = c.dataset.sort;
  document.querySelectorAll("#sort-chips .chip").forEach(x => x.classList.toggle("on", x.dataset.sort === filters.sort));
  load({ reset: true });
});

const unreadToggle = document.getElementById("unread-toggle");
unreadToggle.addEventListener("click", () => {
  unreadOnly = !unreadOnly;
  unreadToggle.classList.toggle("on", unreadOnly);
  load({ reset: true });
});

let searchTimer;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    filters.q = searchInput.value.trim().toLowerCase();
    syncResetButtons();
    load({ reset: true });
  }, 400);
});

function resetFilters(kind) {
  if (kind === "search") { filters.q = ""; searchInput.value = ""; }
  else if (kind === "geo") filters.geos.clear();
  else if (kind === "topics") { hiddenTopics.clear(); localStorage.removeItem("gz-hidden-topics"); }
  else if (kind === "bias") filters.biases = new Set(["left", "center", "right"]);
  else if (kind === "time") filters.hours = null;
  if (kind === "time") {
    document.querySelectorAll("#time-chips .chip").forEach(x => x.classList.toggle("on", x.dataset.hours === ""));
  } else {
    syncChips();
  }
  syncResetButtons();
  load({ reset: true });
}
const resetMap = {
  "reset-search": "search",
  "reset-topics": "topics",
  "reset-bias": "bias",
  "reset-time": "time"
};
for (const [id, kind] of Object.entries(resetMap)) {
  const btn = document.getElementById(id);
  if (btn) btn.addEventListener("click", () => resetFilters(kind));
}

function syncChips() {
  document.querySelectorAll("#sidebar .chip[data-kind]").forEach(c => {
    if (c.dataset.kind === "topic") {
      c.classList.toggle("on", !hiddenTopics.has(c.dataset.value));
      c.classList.toggle("off", hiddenTopics.has(c.dataset.value));
      return;
    }
    const set = c.dataset.kind === "geo" ? filters.geos : null;
    c.classList.toggle("on", set ? (set.size === 0 || set.has(c.dataset.value)) : false);
  });
  document.querySelectorAll("#bias-chips .chip").forEach(c => {
    c.classList.toggle("on", filters.biases.has(c.dataset.bias));
  });
  document.querySelectorAll("#time-chips .chip").forEach(c => {
    const v = c.dataset.hours;
    c.classList.toggle("on", v === "" ? filters.hours === null : filters.hours === Number(v));
  });
  syncResetButtons();
}

function syncResetButtons() {
  const dirty = {
    "reset-search": filters.q !== "",
    "reset-bias": filters.biases.size !== 3,
    "reset-time": filters.hours !== null,
    "reset-topics": hiddenTopics.size > 0,
  };
  document.querySelectorAll('#sidebar .reset-btn[id^="reset-"]').forEach(btn => {
    btn.classList.toggle("hidden", !dirty[btn.id]);
  });
}

document.querySelectorAll(".bulk-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const kind = btn.dataset.bulk;
    const chips = document.querySelectorAll(`#${kind}-chips .chip`);
    if (kind === "geo") {
      if (btn.dataset.mode === "on") filters.geos = new Set([...chips].map(c => c.dataset.value));
      else filters.geos = new Set(["__none__"]);
      syncChips();
      load({ reset: true });
      return;
    }
    if (kind === "topic") {
      if (btn.dataset.mode === "on") hiddenTopics.clear();
      else chips.forEach(c => hiddenTopics.add(c.dataset.value));
      localStorage.setItem("gz-hidden-topics", JSON.stringify([...hiddenTopics]));
      syncChips();
      load({ reset: true });
    }
  });
});

window.addEventListener("popstate", () => {
  readStateFromUrl();
  unreadToggle.classList.toggle("on", unreadOnly);
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === currentTab));
  document.getElementById("sidebar").style.display = currentTab === "sources" ? "none" : "";
  document.getElementById("layout").classList.toggle("sources-view", currentTab === "sources");
  syncChips();
  syncSortChips();
  load();
});

function syncSortChips() {
  document.querySelectorAll("#sort-chips .chip").forEach(c => {
    c.classList.toggle("on", c.dataset.sort === filters.sort);
  });
}

readStateFromUrl();
unreadToggle.classList.toggle("on", unreadOnly);
document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === currentTab));
document.getElementById("sidebar").style.display = currentTab === "sources" ? "none" : "";
document.getElementById("layout").classList.toggle("sources-view", currentTab === "sources");
syncChips();
syncSortChips();
loadFilters();
load();
