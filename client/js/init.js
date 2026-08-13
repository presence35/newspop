// js/init.js — bootstrap: service worker, offline banner, and initial UI state.
// Loaded last, after all handlers are registered.

if ("serviceWorker" in navigator) {
  // updateViaCache: "none" makes the browser refetch sw.js and its
  // importScripts on every navigation, so a deploy is noticed as soon as the
  // page next loads — no waiting on the HTTP cache.
  navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch((err) => console.error("SW registration failed:", err));

  // When a newly installed worker takes over (e.g. right after a deploy), it
  // already holds fresh precached files — reload once to serve them instead of
  // the stale shell that the current page was built from.
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  // An app left open should pick up a deploy when the user returns to it,
  // without waiting for a manual reload.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      navigator.serviceWorker.ready.then((reg) => reg.update());
    }
  });
}

const offlineBanner = document.createElement("div");
offlineBanner.id = "offline-banner";
offlineBanner.textContent = "You're offline — showing the last loaded stories.";
offlineBanner.hidden = true;
document.body.appendChild(offlineBanner);
window.addEventListener("online", () => { offlineBanner.hidden = true; });
window.addEventListener("offline", () => { offlineBanner.hidden = false; });

const versionBadge = document.getElementById("brand-version");
if (versionBadge) {
  fetch("/api/version")
    .then((r) => (r.ok ? r.json() : null))
    .then((v) => { if (v && v.version) versionBadge.textContent = "v" + v.version; })
    .catch(() => {});
}

// ---------- initial UI state ----------
applySidebar();
readStateFromUrl();
renderExcludePills();
unreadToggle.classList.toggle("on", unreadOnly);
syncTabUI();
syncChips();
syncSortChips();
loadFilters();
load();
