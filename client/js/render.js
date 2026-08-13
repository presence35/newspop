// js/render.js — DOM builders for story cards, framing comparison, and source cards.

function renderStory(story, opts = {}) {
  const div = document.createElement("div");
  div.className = "story";
  div.dataset.story = story.clusterId;
  div._sources = story.sources;

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
      <a class="src-extra-link${clickedSet.has(String(x.id)) ? " checked" : ""}" data-aid="${x.id}" href="${x.link}" target="_blank" rel="noopener" title="${escapeHtml(x.title || "")}" onclick="trackClick(${x.id}, ${story.clusterId})"><span class="src-extra-title">${escapeHtml(x.title || "Article")}</span>${clickedSet.has(String(x.id)) ? `<span class="src-check" title="You opened this article">✓</span>` : ""}</a>`).join("") : "";
    const moreBtn = (s.extra && s.extra.length)
      ? `<button class="src-more" title="${s.extra.length} more update${s.extra.length > 1 ? "s" : ""} from ${escapeHtml(s.name)}">▾${s.extra.length}</button>`
      : "";
    const facDot = (s.factuality !== null && s.factuality !== undefined)
      ? `<span class="fac-dot fac-${s.factuality >= 7 ? "hi" : s.factuality >= 5 ? "mid" : "lo"}" title="Factuality ${s.factuality}/10"></span>`
      : "";
    const ownerTip = s.owner ? ` · ${s.owner}` : "";
    const checked = clickedSet.has(String(s.id));
    return `
    <div class="source-group">
      <div class="src-row">
        <a href="${s.link}" target="_blank" rel="noopener" class="source-chip bias-${biasClass(s.bias)}${checked ? " checked" : ""}" data-aid="${s.id}"
           title="${escapeHtml(s.name + (s.factuality !== null && s.factuality !== undefined ? ` — factuality ${s.factuality}/10` : "") + ownerTip + (seen ? " · seen " + seen : ""))}"
           onclick="trackClick(${s.id}, ${story.clusterId})"><img class="src-logo" src="/logo/${encodeURIComponent(s.logo)}?v=3" alt="" loading="lazy" onerror="this.style.display='none'">${s.name}${facDot}${checked ? `<span class="src-check" title="You opened this article">✓</span>` : ""}</a>
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
    ? `<button class="save-btn on" data-save="${story.clusterId}" title="Remove from saved"><svg class="ic" aria-hidden="true"><use href="#trash-2"/></svg></button>`
    : `<button class="save-btn ${saved ? "on" : ""}" data-save="${story.clusterId}" title="${saved ? "Remove from saved" : "Save for later"}"><svg class="ic" aria-hidden="true"><use href="#${saved ? "check" : "bookmark"}"/></svg></button>`;

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
    ${story.sources.length > 1 ? `<button class="framing-toggle">Compare ${story.sources.length} headline${story.sources.length === 1 ? "" : "s"}</button>
    <div class="framing hidden">${buildFraming(story)}</div>` : ""}
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
  toggle.textContent = section.classList.contains("expanded") ? "Show less" : `Show ${n} source${n === 1 ? "" : "s"}`;
}

function buildFraming(story) {
  const sides = [
    { key: "l", label: "Left-leaning", pick: (s) => s.bias !== null && s.bias <= -1 },
    { key: "c", label: "Center / unrated", pick: (s) => s.bias === null || s.bias === 0 },
    { key: "r", label: "Right-leaning", pick: (s) => s.bias !== null && s.bias >= 1 },
  ];
  const byTime = (s) => {
    const t = s.published_at || s.created_at;
    return t ? new Date(t).getTime() : Infinity;
  };
  let first = null, firstTs = Infinity;
  for (const s of story.sources) {
    const t = byTime(s);
    if (t < firstTs) { firstTs = t; first = s.name; }
  }
  const cols = sides.map((side) => {
    const items = story.sources.filter(side.pick).sort((a, b) => byTime(a) - byTime(b)).map((s) => {
      const t = s.published_at || s.created_at;
      const firstBadge = s.name === first ? `<span class="framing-first" title="Earliest outlet on this story">First to break</span>` : "";
      const checked = clickedSet.has(String(s.id));
      return `
      <a class="framing-card${checked ? " checked" : ""}" data-aid="${s.id}" href="${s.link}" target="_blank" rel="noopener" onclick="trackClick(${s.id}, ${story.clusterId})">
        <div class="framing-card-head">
          <img class="src-logo" src="/logo/${encodeURIComponent(s.logo)}?v=3" alt="" loading="lazy" onerror="this.style.display='none'">
          <span class="framing-name">${escapeHtml(s.name)}${firstBadge}</span>
          ${checked ? `<span class="src-check" title="You opened this article">✓</span>` : ""}
        </div>
        <div class="framing-headline">${escapeHtml(s.title || "")}</div>
        ${t ? `<div class="framing-time" title="${new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}">${timeAgo(t)}</div>` : ""}
      </a>`;
    });
    return items.length
      ? `<div class="framing-col ${side.key}"><div class="framing-col-head">${side.label}</div><div class="framing-col-body">${items.join("")}</div></div>`
      : "";
  }).join("");
  return cols;
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
