// js/views.js — per-tab data loading and rendering, plus the Load-more button.

const loadMoreBtn = document.createElement("button");
loadMoreBtn.id = "load-more";
loadMoreBtn.className = "hidden";
loadMoreBtn.textContent = "Load more";
loadMoreBtn.addEventListener("click", loadMore);

// One in-flight load at a time. Every tab/filter click starts a new load, and a
// slow response (e.g. /api/blindspots) used to overwrite whatever tab the user
// switched to afterwards. Aborting the previous request means stale responses
// never render.
let loadController = null;

function feedParams(off) {
  const p = new URLSearchParams();
  if (filters.geos.size) p.set("geo", [...filters.geos].join(","));
  if (hiddenTopics.size) p.set("notopic", [...hiddenTopics].join(","));
  if (hiddenOutlets.size) p.set("nooutlet", [...hiddenOutlets].join(","));
  if (excludedKeywords.size) p.set("notq", [...excludedKeywords].join(","));
  if (filters.hours) p.set("hours", filters.hours);
  if (filters.q) p.set("q", filters.q);
  if (filters.sort !== "newest") p.set("sort", filters.sort);
  p.set("limit", PAGE);
  p.set("offset", off);
  return p.toString();
}

async function fetchFeedPage(off, signal) {
  const res = await fetch("/api/feed?" + feedParams(off), { signal });
  return res.json();
}

function appendLoadMore() {
  loadMoreBtn.classList.remove("hidden");
  content.appendChild(loadMoreBtn);
}

async function load(opts = {}) {
  if (loadController) loadController.abort();
  loadController = new AbortController();
  const signal = loadController.signal;
  if (opts.reset) offset = 0;
  try {
    if (currentTab === "feed") return await loadFeed(signal);
    if (currentTab === "blindspots") return await loadBlindspots(signal);
    if (currentTab === "mybias") return await loadMyBias(signal);
    if (currentTab === "saved") return await loadSaved(signal);
    if (currentTab === "sources") return await loadSources(signal);
  } catch (err) {
    if (err && err.name === "AbortError") return;
    throw err;
  }
}

async function loadFeed(signal) {
  content.innerHTML = `<div class="empty">Loading...</div>`;
  if (hiddenOutlets.size > 0) {
    const srcRes = await fetch("/api/sources", { signal });
    const { sources } = await srcRes.json();
    if (sources.length > 0 && hiddenOutlets.size >= sources.length) {
      content.innerHTML = `<div class="empty">All sources are hidden. Go to the <strong>Sources</strong> tab to enable some.</div>`;
      return;
    }
  }
  const raw = await fetchFeedPage(offset, signal);
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
  try {
    const raw = await fetchFeedPage(offset, loadController ? loadController.signal : undefined);
    let stories = raw.filter(passesBias).filter(passesUnread);
    hasMore = raw.length === PAGE;
    loadMoreBtn.remove();
    loadMoreBtn.disabled = false;
    stories.forEach(s => content.appendChild(renderStory(s)));
    observeStories();
    if (hasMore) appendLoadMore();
  } catch (err) {
    loadMoreBtn.disabled = false;
    if (err && err.name === "AbortError") return;
    throw err;
  }
}

async function loadBlindspots(signal) {
  content.innerHTML = `<div class="empty">Loading...</div>`;
  const res = await fetch("/api/blindspots", { signal });
  const stories = await res.json();
  content.innerHTML = "";
  if (stories.length === 0) {
    content.innerHTML = `<div class="empty">No blindspots detected right now.</div>`;
    return;
  }
  stories.forEach(s => content.appendChild(renderStory(s, { blindspot: true })));
  observeStories();
}

async function loadSaved(signal) {
  content.innerHTML = `<div class="empty">Loading...</div>`;
  if (savedSet.size === 0) {
    content.innerHTML = `<div class="empty">No saved stories. Tap the bookmark icon on a story to save it here.</div>`;
    return;
  }
  const res = await fetch("/api/feed?" + new URLSearchParams({ ids: [...savedSet].join(","), limit: PAGE * 4 }), { signal });
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
async function loadSources(signal) {
  content.innerHTML = `<div class="empty">Loading sources...</div>`;
  const res = await fetch("/api/sources", { signal });
  const { sources } = await res.json();
  content.innerHTML = "";

  const header = document.createElement("div");
  header.className = "sources-header";
  header.innerHTML = `
    <div class="sources-top">
      <h2>All Sources (${sources.length})</h2>
      <div class="sources-bulk">
        <button id="sources-enable-all"><svg class="ic" aria-hidden="true"><use href="#check"/></svg>All</button>
        <button id="sources-disable-all"><svg class="ic" aria-hidden="true"><use href="#trash-2"/></svg>None</button>
      </div>
    </div>
    <div class="sort-row">
      <span>Sort:</span>
      <div class="sort-controls">
        <button class="sort-btn" data-sort="alpha">A-Z</button>
        <button class="sort-btn" data-sort="spectrum">Spectrum</button>
        <button class="sort-btn" data-sort="factuality">Factuality</button>
        <button class="sort-btn active" data-sort="enabled">Enabled</button>
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

async function loadMyBias(signal) {
  const res = await fetch("/api/my-bias", { signal });
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

  const today = b.history && b.history.length ? b.history[b.history.length - 1] : null;
  let meter = "", missing = "";
  if (today && today.total > 0) {
    const lead = today.leftPct > today.rightPct ? "left" : today.rightPct > today.leftPct ? "right" : "center";
    const leadTxt = lead === "left" ? "left" : lead === "right" ? "right" : "center";
    const otherSide = lead === "left" ? "right" : lead === "right" ? "left" : null;
    meter = `
      <div class="balance-meter">
        <div class="balance-lead">Today you read <strong>${today.leftPct}% ${leadTxt}-leaning</strong></div>
        <div class="hist-bar">
          <div class="l" style="width:${today.leftPct}%"></div>
          <div class="c" style="width:${today.centerPct}%"></div>
          <div class="r" style="width:${today.rightPct}%"></div>
        </div>
        <div class="hist-pct">${today.leftPct}% left · ${today.centerPct}% center · ${today.rightPct}% right</div>
      </div>`;
    if (otherSide) {
      try {
        const feedRes = await fetch("/api/feed?limit=100", { signal });
        const feed = await feedRes.json();
        const missStories = feed.filter(s => dominantBias(s) === otherSide).slice(0, 5);
        if (missStories.length) {
          missing = `
            <div class="hist-title">${otherSide === "left" ? "Left" : "Right"}-leaning coverage you're missing</div>
            <div class="missing-list">
              ${missStories.map(s => `<a class="missing-story" href="#feed" onclick="showSideInFeed('${otherSide}');return false;">${escapeHtml(s.headline)}</a>`).join("")}
            </div>
            <button class="missing-go" onclick="showSideInFeed('${otherSide}')">Show ${otherSide}-leaning in feed</button>`;
        }
      } catch {}
    }
  }

  content.innerHTML = `
    <div class="my-bias-summary">
      <strong style="color:var(--text)">Your reading, ${b.totalClicks} click${b.totalClicks === 1 ? "" : "s"} tracked</strong><br><br>
      Left: ${b.leftPct}% (${b.left}) &nbsp; Center: ${b.centerPct}% (${b.center}) &nbsp; Right: ${b.rightPct}% (${b.right})
      ${b.unrated ? `<br>Unrated outlet clicks: ${b.unrated}` : ""}
    </div>
    ${meter}
    ${missing}
    ${hist || `<div class="empty">No tracked clicks in the last 7 days.</div>`}
  `;
}

function showSideInFeed(side) {
  filters.biases = new Set([side]);
  currentTab = "feed";
  syncTabUI();
  syncChips();
  syncResetButtons();
  writeStateToUrl("push");
  load({ reset: true });
}
window.showSideInFeed = showSideInFeed;

function renderExcludePills() {
  const el = document.getElementById("exclude-chips");
  if (!el) return;
  el.innerHTML = "";
  for (const kw of [...excludedKeywords].sort()) {
    const b = document.createElement("button");
    b.className = "chip off";
    b.innerHTML = `<span class="chip-name">${escapeHtml(kw)}</span><span class="pill-x" title="Remove ${escapeHtml(kw)}" data-exclude="${escapeHtml(kw)}">✕</span>`;
    el.appendChild(b);
  }
}

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
  if (kind === "geo") items = [...items].sort((a, b) => {
    if (a.name === "world") return -1;
    if (b.name === "world") return 1;
    return geoLabel(a.name).localeCompare(geoLabel(b.name));
  });
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
