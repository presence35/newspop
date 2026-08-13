// js/interactions.js — user-event wiring: clicks, filters, keyboard nav,
// read-tracking, and UI sync helpers.

function markSourceClicked(articleId) {
  if (articleId === undefined || articleId === null) return;
  if (!clickedSet.has(String(articleId))) {
    clickedSet.add(String(articleId));
    persistSet(CLICKED_KEY, clickedSet);
  }
  document.querySelectorAll(`[data-aid="${articleId}"]`).forEach(el => {
    el.classList.add("checked");
    if (!el.querySelector(".src-check")) {
      const check = document.createElement("span");
      check.className = "src-check";
      check.textContent = "✓";
      check.title = "You opened this article";
      el.appendChild(check);
    }
  });
}

function trackClick(articleId, clusterId) {
  fetch("/api/click", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ articleId })
  });
  markSourceClicked(articleId);
  if (clusterId !== undefined && clusterId !== null && !readSet.has(clusterId)) {
    readSet.add(clusterId);
    persistSet(READ_KEY, readSet);
    const el = document.querySelector(`.story[data-story="${clusterId}"] .unread-dot`);
    if (el) el.remove();
  }
}
window.trackClick = trackClick;

function maybeNudgeOtherSide(chip, storyEl) {
  if (!chip || !storyEl || !storyEl._sources) return;
  const clicked = chip.classList.contains("bias-l") ? "left"
    : chip.classList.contains("bias-r") ? "right" : "center";
  if (clicked === "center" || storyEl.querySelector(".nudge")) return;
  const cid = storyEl.dataset.story;
  if (nudgedSet.has(cid)) return;
  const otherSide = clicked === "left" ? "right" : "left";
  const target = storyEl._sources.find((s) =>
    otherSide === "right" ? (s.bias !== null && s.bias >= 1) : (s.bias !== null && s.bias <= -1)
  );
  if (!target) return;
  nudgedSet.add(cid);
  persistSet(NUDGED_KEY, nudgedSet);
  const banner = document.createElement("div");
  banner.className = "nudge";
  banner.innerHTML = `Read the other side: you opened a ${clicked}-leaning outlet. <a href="${target.link}" target="_blank" rel="noopener" onclick="trackClick(${target.id}, ${cid})">${escapeHtml(target.name)}</a> covers this story too.`;
  storyEl.querySelector(".sources").after(banner);
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
  const framingToggle = e.target.closest(".framing-toggle");
  if (framingToggle) {
    const story = framingToggle.closest(".story");
    const framing = story && story.querySelector(".framing");
    if (framing) {
      framing.classList.toggle("hidden");
      framingToggle.textContent = framing.classList.contains("hidden")
        ? `Compare ${story.querySelectorAll(".framing-row").length} headline${story.querySelectorAll(".framing-row").length === 1 ? "" : "s"}`
        : "Hide comparison";
    }
    return;
  }
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
  const chip = e.target.closest(".source-chip");
  if (chip) {
    const story = chip.closest(".story");
    maybeNudgeOtherSide(chip, story);
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
      content.innerHTML = `<div class="empty">No saved stories. Tap the bookmark icon on a story to save it here.</div>`;
    }
  } else {
    if (savedSet.has(cid)) savedSet.delete(cid); else savedSet.add(cid);
    persistSet(SAVED_KEY, savedSet);
    const on = savedSet.has(cid);
    btn.classList.toggle("on", on);
    btn.title = on ? "Remove from saved" : "Save for later";
    const use = btn.querySelector("use");
    if (use) use.setAttribute("href", "#" + (on ? "check" : "bookmark"));
  }
});

// ---------- brand click: back to the Feed tab ----------
document.querySelector("header .brand").addEventListener("click", () => {
  currentTab = "feed";
  syncTabUI();
  writeStateToUrl("push");
  load({ reset: true });
});

// ---------- sidebar collapse + mobile drawer ----------
const collapseBtn = document.getElementById("collapse-sidebar");
let sidebarCollapsed = localStorage.getItem("gz-sidebar") === "1";
function applySidebar() {
  document.getElementById("layout").classList.toggle("collapsed", sidebarCollapsed);
  collapseBtn.classList.toggle("collapsed", sidebarCollapsed);
  collapseBtn.title = sidebarCollapsed ? "Show filters" : "Hide filters";
}
const mqMobile = window.matchMedia("(max-width: 800px)");
const mobileFilterBtn = document.getElementById("mobile-filters");
const filterBackdrop = document.getElementById("filter-backdrop");
function setDrawer(open) {
  sidebar.classList.toggle("mobile-open", open);
  filterBackdrop.classList.toggle("show", open);
}
mobileFilterBtn.addEventListener("click", () => setDrawer(true));
filterBackdrop.addEventListener("click", () => setDrawer(false));
mqMobile.addEventListener("change", (e) => { if (!e.matches) setDrawer(false); });
collapseBtn.addEventListener("click", () => {
  if (mqMobile.matches) { setDrawer(false); return; }
  sidebarCollapsed = !sidebarCollapsed;
  localStorage.setItem("gz-sidebar", sidebarCollapsed ? "1" : "0");
  applySidebar();
});

// ---------- tabs ----------
function syncTabUI() {
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === currentTab));
  document.getElementById("sidebar").style.display = currentTab === "sources" ? "none" : "";
  document.getElementById("layout").classList.toggle("sources-view", currentTab === "sources");
  mobileFilterBtn.classList.toggle("hidden", currentTab !== "feed");
}
tabs.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  currentTab = btn.dataset.tab;
  if (mqMobile.matches) setDrawer(false);
  syncTabUI();
  load({ reset: true });
  writeStateToUrl("push");
});

// ---------- sidebar: filter chips ----------
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

const excludeInput = document.getElementById("exclude-input");
function addExcludeKeyword() {
  const kw = excludeInput.value.trim().toLowerCase();
  excludeInput.value = "";
  if (!kw || excludedKeywords.has(kw)) return;
  excludedKeywords.add(kw);
  persistSet("gz-exclude", excludedKeywords);
  renderExcludePills();
  syncResetButtons();
  load({ reset: true });
}
excludeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addExcludeKeyword(); }
});
excludeInput.addEventListener("blur", addExcludeKeyword);
const excludeChips = document.getElementById("exclude-chips");
excludeChips.addEventListener("click", (e) => {
  const x = e.target.closest(".pill-x");
  if (!x) return;
  excludedKeywords.delete(x.dataset.exclude);
  persistSet("gz-exclude", excludedKeywords);
  renderExcludePills();
  syncResetButtons();
  load({ reset: true });
});

function resetFilters(kind) {
  if (kind === "search") { filters.q = ""; searchInput.value = ""; }
  else if (kind === "geo") filters.geos.clear();
  else if (kind === "topics") { hiddenTopics.clear(); localStorage.removeItem("gz-hidden-topics"); }
  else if (kind === "exclude") {
    excludedKeywords.clear();
    localStorage.removeItem("gz-exclude");
    renderExcludePills();
  }
  syncChips();
  syncResetButtons();
  load({ reset: true });
}
const resetMap = {
  "reset-search": "search",
  "reset-topics": "topics",
  "reset-exclude": "exclude"
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
    "reset-topics": hiddenTopics.size > 0,
    "reset-exclude": excludedKeywords.size > 0,
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
  syncTabUI();
  syncChips();
  syncSortChips();
  load();
});

// ---------- ESC toggles the desktop filter panel ----------
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || mqMobile.matches) return;
  sidebarCollapsed = !sidebarCollapsed;
  localStorage.setItem("gz-sidebar", sidebarCollapsed ? "1" : "0");
  applySidebar();
});

// ---------- keyboard navigation: j / k move through story cards ----------
document.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (currentTab === "sources") return;
  if (e.key !== "j" && e.key !== "k") return;
  e.preventDefault();
  const storyEls = [...content.querySelectorAll(".story")];
  if (!storyEls.length) return;
  const active = content.querySelector(".story.active-key");
  let idx = active ? storyEls.indexOf(active) : -1;
  idx = Math.max(0, Math.min(storyEls.length - 1, idx + (e.key === "j" ? 1 : -1)));
  storyEls.forEach(el => el.classList.remove("active-key"));
  const el = storyEls[idx];
  el.classList.add("active-key");
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

// ---------- header tab counts removed ----------

function syncSortChips() {
  document.querySelectorAll("#sort-chips .chip").forEach(c => {
    c.classList.toggle("on", c.dataset.sort === filters.sort);
  });
}
