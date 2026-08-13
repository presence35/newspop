// js/state.js — shared app state: DOM refs, filters, persisted sets, pagination.
// Loaded first; every other script reads these globals.
const content = document.getElementById("content");
const tabs = document.getElementById("tabs");
const sidebar = document.getElementById("sidebar");
const searchInput = document.getElementById("search");
const biasChips = document.getElementById("bias-chips");
const timeChips = document.getElementById("time-chips");
let currentTab = "feed";

const filters = { geos: new Set(), biases: new Set(["left", "center", "right"]), hours: 24, q: "", sort: "newest" };
let hiddenTopics = new Set(JSON.parse(localStorage.getItem("gz-hidden-topics") || "[]"));
let hiddenOutlets = new Set(JSON.parse(localStorage.getItem("gz-hidden-outlets") || "[]"));
let excludedKeywords = new Set(JSON.parse(localStorage.getItem("gz-exclude") || "[]"));
const READ_KEY = "gz-read";
const SAVED_KEY = "gz-saved";
const NUDGED_KEY = "gz-nudged";
const CLICKED_KEY = "gz-clicked-sources";
let readSet = new Set(JSON.parse(localStorage.getItem(READ_KEY) || "[]"));
let savedSet = new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || "[]"));
let nudgedSet = new Set(JSON.parse(localStorage.getItem(NUDGED_KEY) || "[]"));
let clickedSet = new Set(JSON.parse(localStorage.getItem(CLICKED_KEY) || "[]"));
let unreadOnly = false;
const PAGE = 50;
let offset = 0;
let hasMore = true;
let storyObserver = null;

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
