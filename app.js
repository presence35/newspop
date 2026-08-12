// NewsPop — single-file Node server.
// RSS ingestion -> embedded JSON store -> cluster articles into stories ->
// tally bias per story -> serve plain JSON API + static HTML feed.
//
// No native dependencies. Data is stored in data/newspop.json via store.js —
// a tiny in-memory + periodic-flush store, chosen because native SQLite
// modules (better-sqlite3, node:sqlite) either need a C++ compiler on the
// host or a Node version this host doesn't have. This app's data volume
// (RSS headlines + click events) is small enough that this is genuinely
// fine, not just a workaround.
//
// Two clustering modes, chosen by CLUSTER_MODE env var:
//   "tfidf"     (default) — zero dependencies, no model, no sidecar. Pure JS
//               token-overlap similarity. Good enough for RSS headlines,
//               which are often near-identical across outlets on wire stories.
//   "embedding" — better recall on paraphrased headlines, needs embed_server.py
//               running locally (still zero API cost — local model, not a paid call).
//
// Run:
//   npm install    (no native deps — this should never fail on any host)
//   node app.js
//   open http://localhost:3000
//
// Run (embedding mode, better clustering):
//   CLUSTER_MODE=embedding node app.js
//   (with python3 embed_server.py running in another terminal)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1"; // set to 0.0.0.0 to accept non-local connections
const CLUSTER_MODE = process.env.CLUSTER_MODE || "tfidf"; // "tfidf" | "embedding"
const EMBED_URL = "http://127.0.0.1:5055/embed";
const CLUSTER_SIM_THRESHOLD = CLUSTER_MODE === "embedding" ? 0.72 : 0.28; // different scales for cosine-on-embeddings vs tfidf overlap
const BLINDSPOT_MIN_SOURCES = 4; // story needs at least this many outlets to qualify
const BLINDSPOT_MAX_SHARE = 0.20; // one side must be <=20% of coverage to be a blindspot
const IMG_MAX_WIDTH = 1280; // cap for CDN image size rewrites (BBC/France24-style token URLs)
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 7; // drop articles older than this on each ingest

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function bootLog(msg, err) {
  const detail = err ? ` — ${(err && err.stack) || err}` : "";
  console.log(`[${new Date().toISOString()}] ${msg}${detail}`);
}

const biasDb = loadJson(path.join(__dirname, "bias-db.json"), { outlets: {} });
const feeds = loadJson(path.join(__dirname, "feeds.json"), []);

// ---------- store setup ----------
const DATA_DIR = path.join(__dirname, "data");
let store;
try {
  store = createStore(DATA_DIR);
} catch (err) {
  console.error(`cannot use ${DATA_DIR} — falling back to ${os.tmpdir()}`, err);
  store = createStore(path.join(os.tmpdir(), "newspop-data"));
}

// Outlet logos are downloaded once (at setup) into `logos/` and served from
// here, so readers' browsers never hit a third-party favicon service. Files
// are named `{source-slug}.{ext}` (e.g. msnbc.png, theglobeandmail.jpg); the
// slug is the outlet's domain minus its TLD. Content type comes from the file.
const LOGO_DIR = path.join(__dirname, "logos");
function logoSlug(domain) {
  let d = (domain || "").replace(/^www\./, "");
  for (const t of [".co.uk", ".com.au", ".com.ua", ".com", ".co", ".org", ".net", ".au", ".ca", ".ua", ".uk", ".eu"]) {
    if (d.endsWith(t)) { d = d.slice(0, -t.length); break; }
  }
  return d.split(".")[0] || "unknown";
}
function logoFileFor(domain) {
  const slug = logoSlug(domain);
  for (const ext of ["png", "jpg", "jpeg", "gif", "webp"]) {
    if (fs.existsSync(path.join(LOGO_DIR, `${slug}.${ext}`))) return `${slug}.${ext}`;
  }
  return `${slug}.png`;
}
function contentTypeFor(buf) {
  if (!buf || buf.length < 4) return "image/x-icon";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "image/webp";
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return "image/x-icon";
  const head = buf.slice(0, 512).toString("utf8");
  if (/^\s*(<\?xml|<svg)/i.test(head)) return "image/svg+xml";
  return "image/x-icon";
}

// ---------- tiny RSS parser (no deps) ----------
function parseRss(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate") || extractTag(block, "dc:date");
    if (title && link) items.push({
      title: decodeEntities(title),
      link: decodeEntities(link).trim(),
      pubDate,
      image: extractImage(block),
      categories: (block.match(/<category\b[^>]*>[\s\S]*?<\/category>/gi) || [])
        .map((t) => decodeEntities(t.replace(/<[^>]+>/g, " ")).trim())
        .filter(Boolean),
    });
  }
  return items;
}
// Pick the highest-resolution image an RSS item actually exposes, instead of
// the first tag in the feed (many feeds list small thumbnails first). Collects
// every media:content / media:thumbnail / image enclosure / <img>, reads its
// declared width/height where present, and returns the largest candidate.
// If the winning URL is a known CDN size-token URL (BBC/France24), bump it up
// to IMG_MAX_WIDTH; otherwise the largest variant offered is all we can get.
function extractImage(block) {
  const candidates = [];
  const tagRe = /<(media:content|media:thumbnail|enclosure|img)\b[^>]*>/gi;
  let tag;
  while ((tag = tagRe.exec(block)) !== null) {
    const t = tag[0];
    if (/^<enclosure\b/i.test(t) && !/type\s*=\s*["']image\//i.test(t)) continue;
    const url = t.match(/(?:url|src)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!url) continue;
    // some CDNs emit literal 1x1 placeholder URLs when the real photo is gone
    if (/placeholder|1x1|1px/i.test(url)) continue;
    const w = parseInt(t.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1] || "0", 10) || 0;
    const h = parseInt(t.match(/\bheight\s*=\s*["']?(\d+)/i)?.[1] || "0", 10) || 0;
    candidates.push({ url, w, h });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.w * b.h - a.w * a.h || b.w - a.w);
  return decodeEntities(upscaleImage(candidates[0].url));
}

function upscaleImage(url) {
  try {
    if (/bbci\.co\.uk/i.test(url)) {
      // BBC ichef serves the same image at any width via /standard/<w>/
      return url.replace(/\/standard\/\d+\//, `/standard/${IMG_MAX_WIDTH}/`);
    }
    if (/france24\.com/i.test(url)) {
      // France24 media CDN takes w:NNN tokens
      return url.replace(/w:\d+/, `w:${IMG_MAX_WIDTH}`);
    }
    // Guardian & friends sign each width variant separately (a rewritten
    // ?width= returns 401), so the largest variant the feed offered is the cap.
    return url;
  } catch {
    return url;
  }
}
function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim();
}
const NAMED_ENTITIES = {
  apos: "'", nbsp: "\u00a0", hellip: "\u2026", ndash: "\u2013", mdash: "\u2014",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
  amp: "&", lt: "<", gt: ">", quot: '"', copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
  eacute: "\u00e9", egrave: "\u00e8", agrave: "\u00e0", ntilde: "\u00f1", aacute: "\u00e1",
};
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z0-9]+);/g, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

// ---------- topic classifier (trained from publisher labels, zero-dependency) ----------
// Best practice: don't hand-maintain headline keyword lists (they grow forever).
// Instead, learn from labels the publishers already provide — item-level
// <category> tags and per-feed section topics — and generalize to unlabeled
// headlines with a tiny multinomial Naive Bayes (pure JS, no deps). Retrained
// on every ingest; nothing accumulates by hand.
const TOPIC_FALLBACK = "General";

// Taxonomy bridge: maps the publisher's section/category vocabulary to our
// coarse topics. Word-boundary matched against normalized category tags. This
// is small and fixed — a vocabulary bridge, not a headline-keyword list.
const CATEGORY_SYNONYMS = {
  Politics: ["politics", "election", "congress", "senate", "parliament", "candidate", "campaign", "government", "legislation", "diplomacy"],
  Economy: ["business", "economy", "economic", "markets", "market", "finance", "financial", "money", "companies", "commodities", "jobs", "work", "trade"],
  Tech: ["technology", "tech", "computing", "software", "internet", "digital", "artificial intelligence", "gadgets", "telecoms"],
  Health: ["health", "healthcare", "medicine", "medical", "disease", "wellness", "nutrition", "pandemic", "clinical"],
  Climate: ["climate", "environment", "environmental", "weather", "energy", "pollution", "biodiversity", "conservation"],
  Science: ["science", "research", "space", "astronomy", "archaeology", "discovery", "genetics", "physics"],
  Crime: ["crime", "criminal", "courts", "law", "policing", "justice"],
  War: ["war", "conflict", "military", "armed", "defence", "defense", "frontline"],
};
const CATEGORY_REGEX_CACHE = new Map();
function topicFromCategory(cat) {
  const norm = " " + (cat || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim() + " ";
  for (const [topic, syns] of Object.entries(CATEGORY_SYNONYMS)) {
    for (const s of syns) {
      let re = CATEGORY_REGEX_CACHE.get(s);
      if (!re) {
        re = new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        CATEGORY_REGEX_CACHE.set(s, re);
      }
      if (re.test(norm)) return topic;
    }
  }
  return null;
}

const NAIVE_ALPHA = 1.0; // add-one smoothing, no zero probabilities
const TOPIC_CONF_MIN = 0.4; // below this the model is unsure -> General
const MIN_TRAIN_DOCS = 120; // model needs this much labeled data before its guesses are used
let topicModel = { classes: [], tc: new Map(), wc: new Map(), totals: new Map(), vocSize: 0 };
function trainTopicModel(pairs) {
  const tc = new Map(), wc = new Map(), totals = new Map(), voc = new Set();
  for (const p of pairs) {
    const topic = p.topic || TOPIC_FALLBACK;
    const terms = tokenize(p.title);
    tc.set(topic, (tc.get(topic) || 0) + 1);
    let tw = wc.get(topic);
    if (!tw) { tw = new Map(); wc.set(topic, tw); }
    for (const t of terms) { tw.set(t, (tw.get(t) || 0) + 1); voc.add(t); }
    totals.set(topic, (totals.get(topic) || 0) + terms.length);
  }
  topicModel = { classes: [...tc.keys()], tc, wc, totals, vocSize: voc.size };
}
function modelIsTrustworthy() {
  const { classes, tc } = topicModel;
  if (classes.length < 2) return false; // a single-topic training set predicts everything as that topic
  let total = 0;
  for (const c of classes) total += tc.get(c);
  return total >= MIN_TRAIN_DOCS;
}
function predictTopic(title) {
  const { classes, tc, wc, totals, vocSize } = topicModel;
  if (classes.length === 0) return { topic: TOPIC_FALLBACK, conf: 0 };
  const terms = tokenize(title);
  let totalDocs = 0;
  for (const c of classes) totalDocs += tc.get(c);
  const raw = [];
  for (const c of classes) {
    const tw = wc.get(c) || new Map();
    const denom = (totals.get(c) || 0) + NAIVE_ALPHA * vocSize;
    let logp = Math.log(tc.get(c) / totalDocs);
    for (const t of terms) logp += Math.log(((tw.get(t) || 0) + NAIVE_ALPHA) / denom);
    raw.push([c, logp]);
  }
  const m = Math.max(...raw.map((r) => r[1]));
  let sum = 0;
  const exps = raw.map(([c, l]) => { const e = Math.exp(l - m); sum += e; return [c, e]; });
  const best = exps.reduce((a, b) => (b[1] > a[1] ? b : a));
  const conf = best[1] / sum;
  return { topic: conf >= TOPIC_CONF_MIN ? best[0] : TOPIC_FALLBACK, conf };
}
// Per-domain feed topic, only when unambiguous (a fixed section like Politico's
// politics feed). Domains with several mixed feeds (e.g. Guardian world/au)
// resolve to "no label" rather than an arbitrary guess.
function feedTopicForDomain(domain) {
  const byDomain = new Map();
  for (const f of feeds) {
    if (!f.topic) continue;
    if (!byDomain.has(f.domain)) byDomain.set(f.domain, new Set());
    byDomain.get(f.domain).add(f.topic);
  }
  const s = byDomain.get(domain);
  return s && s.size === 1 ? [...s][0] : null;
}
// Label precedence: item-level publisher category tags (most precise) -> the
// feed's declared section topic -> the trained model's guess. The model only
// gets to speak once it has enough multi-topic evidence; until then unlabeled
// headlines are honestly "General" rather than every-story-one-topic.
// `source` lets the re-tag pass skip model guesses it can't yet trust.
function classifyArticle({ title, categories = [], feedTopic = null }) {
  for (const cat of categories) {
    const t = topicFromCategory(cat);
    if (t) return { topic: t, source: "category" };
  }
  if (feedTopic) return { topic: feedTopic, source: "feed" };
  if (modelIsTrustworthy()) return { topic: predictTopic(title).topic, source: "model" };
  return { topic: TOPIC_FALLBACK, source: "model-untrusted" };
}
function labelsForTraining() {
  const pairs = [];
  for (const a of store.allArticles()) {
    let label = null;
    for (const cat of a.categories || []) { const t = topicFromCategory(cat); if (t) { label = t; break; } }
    if (!label) label = feedTopicForDomain(a.domain);
    if (label) pairs.push({ title: a.title, topic: label });
  }
  return pairs;
}

// ---------- embedding + similarity (embedding mode) ----------
async function getEmbeddings(texts) {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });
  if (!res.ok) throw new Error(`embed sidecar returned ${res.status}`);
  const data = await res.json();
  return data.embeddings;
}
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------- TF-IDF vectors + similarity (zero-model mode, default) ----------
// No model, no API, no sidecar. Builds sparse term-frequency vectors over the
// current ingestion batch + recent clustered headlines, weighted by inverse
// document frequency so common words ("says", "reports") don't dominate.
const STOPWORDS = new Set([
  "the","a","an","and","or","but","of","to","in","on","for","with","at","by",
  "is","are","was","were","be","been","as","it","its","his","her","their",
  "after","over","amid","new","how","why","what","says","said","report",
  "reports","news","after","into","from","this","that","up","down","out",
]);
function stem(word) {
  // crude suffix stripping — enough to match "rate/rates", "cut/cuts/cutting"
  // across differently-worded headlines about the same story
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}
function tokenize(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map(stem);
}
function buildTfidfVectors(titles) {
  const docs = titles.map(tokenize);
  const df = new Map(); // term -> doc count
  for (const doc of docs) {
    for (const term of new Set(doc)) df.set(term, (df.get(term) || 0) + 1);
  }
  const N = docs.length;
  return docs.map((doc) => {
    const tf = new Map();
    for (const term of doc) tf.set(term, (tf.get(term) || 0) + 1);
    const vec = new Map();
    for (const [term, count] of tf) {
      const idf = Math.log((N + 1) / (df.get(term) + 1)) + 1;
      vec.set(term, (count / doc.length) * idf);
    }
    return vec;
  });
}
function sparseCosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [term, val] of a) {
    na += val * val;
    if (b.has(term)) dot += val * b.get(term);
  }
  for (const [, val] of b) nb += val * val;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Effective "when did this story happen" time — same rule the store uses for
// ordering and the `hours` cutoff: RSS pubDate wins, created_at is the fallback.
function articleTime(a) {
  const pts = a.published_at ? Date.parse(a.published_at) : NaN;
  const cts = a.created_at ? Date.parse(a.created_at) : NaN;
  const t = Math.max(pts, cts);
  return Number.isFinite(t) ? t : 0;
}

// One representative per cluster for similarity: the earliest article (by
// articleTime) is the headline the feed card displays, so matching new
// arrivals against it keeps every member of a cluster on-topic.
function pickClusterReps(entries, timeOf, vecOf) {
  const earliest = new Map();
  for (const e of entries) {
    const t = timeOf(e);
    const cur = earliest.get(e.cluster_id);
    if (!cur || t < cur.t) earliest.set(e.cluster_id, { e, t });
  }
  const reps = [];
  for (const [cluster_id, { e }] of earliest) {
    const vec = vecOf(e);
    if (vec) reps.push({ cluster_id, vec });
  }
  return reps;
}

// ---------- ingestion ----------
// One ingest at a time: boot, the 15-min timer, and manual /api/ingest can
// all overlap, and running two concurrently would double-fetch feeds and
// interleave cluster decisions. A second call while one is in flight just
// logs and returns.
let ingesting = false;
async function ingestAll() {
  if (ingesting) {
    console.log("[ingest] already running, skipping this tick");
    return;
  }
  ingesting = true;
  try {
    await ingestAllInner();
  } finally {
    ingesting = false;
  }
}

async function ingestAllInner() {
  console.log(`[ingest] starting, ${feeds.length} feeds`);
  const newArticles = [];

  // retention: drop anything older than RETENTION_DAYS so newspop.json stays small
  const cutoffIso = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  if (store.pruneBefore(cutoffIso)) console.log(`[ingest] pruned articles older than ${RETENTION_DAYS} days`);

  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url, { signal: AbortSignal.timeout(10000), headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" } });
      const xml = await res.text();
      const items = parseRss(xml).slice(0, 20); // cap per feed per run
      let added = 0;
      for (const item of items) {
        if (store.findArticleByLink(item.link)) continue;
        newArticles.push({ ...item, domain: feed.domain, geo: feed.geo, topic: classifyArticle({ title: item.title, categories: item.categories || [], feedTopic: feed.topic || null }).topic });
        added++;
      }
      bootLog(`[ingest] ${feed.domain}: ${items.length} items, ${added} new`);
    } catch (err) {
      bootLog(`[ingest] failed for ${feed.domain}: ${err.message}`);
    }
  }

  if (newArticles.length === 0) {
    console.log("[ingest] no new articles");
    return;
  }
  console.log(`[ingest] ${newArticles.length} new articles, clustering via ${CLUSTER_MODE}...`);

  // Load existing recent clustered articles (last 48h) to compare new arrivals against
  const recentClustered = store.recentClusteredArticles(48);

  let newVectors, clusterReps, simFn;

  if (CLUSTER_MODE === "embedding") {
    try {
      const embeddings = await getEmbeddings(newArticles.map((a) => a.title));
      newVectors = embeddings;
      clusterReps = pickClusterReps(
        recentClustered.filter((r) => r.embedding),
        articleTime,
        (r) => JSON.parse(r.embedding)
      );
      simFn = cosineSim;
    } catch (err) {
      console.error(`[ingest] embed sidecar unreachable (${err.message}) — falling back to tfidf for this run`);
    }
  }

  if (!newVectors) {
    // tfidf mode, or embedding mode fallback: build vectors over new titles
    // plus recent cluster titles so IDF is computed over a realistic corpus
    const allTitles = [...newArticles.map((a) => a.title), ...recentClustered.map((r) => r.title)];
    const allVecs = buildTfidfVectors(allTitles);
    newVectors = allVecs.slice(0, newArticles.length);
    clusterReps = pickClusterReps(
      recentClustered.map((r, i) => ({ cluster_id: r.cluster_id, t: articleTime(r), vec: allVecs[newArticles.length + i] })),
      (e) => e.t,
      (e) => e.vec
    );
    simFn = sparseCosineSim;
  }

  // Match new articles against ONE representative vector per existing cluster
  // (the earliest article — the headline the card displays), not against every
  // member. Per-article matching let stories chain transitively: one cluster
  // grew to 143 unrelated articles. Joined articles are never added as new
  // candidates, and only freshly created clusters get a representative, which
  // also stops same-batch chaining.
  const repsByCluster = new Map(clusterReps.map((r) => [r.cluster_id, r.vec]));

  for (let i = 0; i < newArticles.length; i++) {
    const art = newArticles[i];
    const vec = newVectors[i];
    let clusterId = null;
    let bestSim = 0, bestCluster = null;

    for (const [cid, repVec] of repsByCluster) {
      const sim = simFn(vec, repVec);
      if (sim > bestSim) { bestSim = sim; bestCluster = cid; }
    }

    if (bestSim >= CLUSTER_SIM_THRESHOLD) {
      clusterId = bestCluster;
    } else {
      clusterId = store.insertCluster(art.title);
      repsByCluster.set(clusterId, vec);
    }

    const embeddingToStore =
      CLUSTER_MODE === "embedding" && Array.isArray(vec) ? JSON.stringify(vec) : null;

    store.insertArticle({
      domain: art.domain,
      title: art.title,
      link: art.link,
      published_at: art.pubDate || null,
      geo: art.geo,
      topic: art.topic,
      cluster_id: clusterId,
      embedding: embeddingToStore,
      image: art.image || null,
      categories: art.categories || [],
    });
  }

  store.flush();
  trainTopicModel(labelsForTraining());
  console.log(`[ingest] done`);
}

// ---------- one-time re-cluster (representative-based algorithm) ----------
// Recomputes cluster assignments for every stored article using the same
// representative matching as ingest, so clusters polluted by the old
// per-article chaining (e.g. 143 unrelated articles in one cluster) are
// cleaned up immediately instead of lingering until the 7-day retention prune.
async function reclusterAll() {
  const articles = store.allArticles().filter((a) => a.cluster_id !== null && a.cluster_id !== undefined);
  if (articles.length === 0) return;
  console.log(`[recluster] re-clustering ${articles.length} stored articles via ${CLUSTER_MODE}...`);

  articles.sort((a, b) => articleTime(a) - articleTime(b));

  let vectors, simFn;
  if (CLUSTER_MODE === "embedding") {
    try {
      vectors = await getEmbeddings(articles.map((a) => a.title));
      simFn = cosineSim;
    } catch (err) {
      console.error(`[recluster] embed sidecar unreachable (${err.message}) — using tfidf for this run`);
    }
  }
  if (!vectors) {
    vectors = buildTfidfVectors(articles.map((a) => a.title));
    simFn = sparseCosineSim;
  }

  const newClusters = [];
  const repsByCluster = new Map();
  let created = 0;
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const vec = vectors[i];
    let bestSim = 0, bestCid = null;
    for (const [cid, repVec] of repsByCluster) {
      const sim = simFn(vec, repVec);
      if (sim > bestSim) { bestSim = sim; bestCid = cid; }
    }
    let cid;
    if (bestSim >= CLUSTER_SIM_THRESHOLD) {
      cid = bestCid;
    } else {
      cid = store.nextClusterId();
      newClusters.push({ id: cid, headline: a.title, created_at: a.created_at || new Date().toISOString() });
      repsByCluster.set(cid, vec);
      created++;
    }
    store.setArticleCluster(a.id, cid);
  }
  store.replaceClusters(newClusters);
  store.flush();
  console.log(`[recluster] done — ${created} new clusters`);
}

// ---------- bias tally per story ----------
function biasForDomain(domain) {
  return biasDb.outlets[domain] || null;
}
function outletLabel(domain) {
  const known = biasDb.outlets[domain];
  if (known && known.name) return known.name;
  const base = domain.replace(/^www\./, "").replace(/\.(com|co\.uk|co|org|net|io|gov|info|ua|uk)$/, "");
  return base.split(/[-.]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
function tallyStory(clusterId) {
  const articles = store.articlesByCluster(clusterId); // sorted by publish time asc

  // Per-outlet sources: one primary chip per domain (the outlet's latest
  // article), with the rest kept under `extra` for the grouped chip UI.
  // Bias tallies count unique outlets, so one outlet publishing many versions
  // of the same wire story doesn't skew the left/center/right bar.
  const byDomain = new Map();
  for (const a of articles) {
    const g = byDomain.get(a.domain);
    if (g) {
      if (articleTime(a) > articleTime(g.primary)) {
        g.extras.push(g.primary);
        g.primary = a;
      } else {
        g.extras.push(a);
      }
    } else {
      byDomain.set(a.domain, { primary: a, extras: [] });
    }
  }

  let left = 0, center = 0, right = 0, rated = 0;
  const sources = [...byDomain.entries()].map(([domain, g]) => {
    const info = biasForDomain(domain);
    if (info) {
      rated++;
      if (info.bias <= -1) left++;
      else if (info.bias >= 1) right++;
      else center++;
    }
    return {
      id: g.primary.id,
      domain,
      title: g.primary.title,
      link: g.primary.link,
      published_at: g.primary.published_at,
      created_at: g.primary.created_at,
      topic: g.primary.topic || "General",
      image: g.primary.image || null,
      bias: info ? info.bias : null,
      name: info ? info.name : outletLabel(domain),
      factuality: info ? info.factuality : null,
      owner: info ? info.owner : null,
      logo: logoFileFor(domain),
      extra: g.extras.map((x) => ({ id: x.id, link: x.link, title: x.title, published_at: x.published_at || x.created_at || null })),
    };
  });

  // Dominant topic across the cluster's articles (same rule the filter uses),
  // so the tag shown on the card always matches what the filters are doing.
  const topicCount = new Map();
  for (const a of articles) {
    const t = a.topic || "General";
    topicCount.set(t, (topicCount.get(t) || 0) + 1);
  }
  let topic = "General", topicN = -1;
  for (const [t, n] of topicCount) if (n > topicN) { topic = t; topicN = n; }

  // Most recent coverage time across the cluster (max effective publish ts).
  // The `hours` filter surfaces a cluster when any of its articles is inside
  // the window, so the card's time must be that same "latest" time — otherwise
  // a still-active wire story would show an old date while passing a 24h filter.
  let publishedAt = null, publishedTs = 0;
  for (const a of articles) {
    const t = articleTime(a);
    if (t === 0) continue;
    if (t > publishedTs) { publishedTs = t; publishedAt = new Date(t).toISOString(); }
  }

  return {
    clusterId,
    topic,
    headline: articles[0]?.title || "",
    image: articles.find((a) => a.image)?.image || null,
    publishedAt,
    publishedTs,
    sourceCount: sources.length,
    ratedCount: rated,
    left, center, right,
    leftPct: rated ? Math.round((left / rated) * 100) : null,
    centerPct: rated ? Math.round((center / rated) * 100) : null,
    rightPct: rated ? Math.round((right / rated) * 100) : null,
    sources,
  };
}

function applySort(stories, sort) {
  if (sort === "coverage") {
    return [...stories].sort((a, b) => b.sourceCount - a.sourceCount || b.publishedTs - a.publishedTs);
  }
  if (sort === "lopsided") {
    const score = (s) => (Math.max(s.left, s.right) - Math.min(s.left, s.right)) / (s.ratedCount || 1);
    return [...stories].sort((a, b) => score(b) - score(a) || b.publishedTs - a.publishedTs);
  }
  return stories; // "newest" — distinctClusterIds already orders by publish ts desc
}

function getFeed({ geos = [], topics = [], hideTopics = [], outlets = [], hideOutlets = [], hours = null, q = null, ids = null, sort = "newest", limit = 50, offset = 0, skipCap = false } = {}) {
  const pool = store.distinctClusterIds({ geos, topics, hideTopics, outlets, hideOutlets, hours, q, ids, limit: limit * 3, offset });
  const stories = pool.map((id) => tallyStory(id)).filter((s) => s.sourceCount > 0);
  // Sort the whole pool first when the user picked an explicit ordering, so the
  // cap below can't hide the most-covered/lopsided stories behind newer ones.
  const ordered = sort === "newest" ? stories : applySort(stories, sort);
  // The per-outlet cap prevents a single outlet (e.g. pravda) flooding the
  // unfiltered feed. When the user explicitly filters by outlet(s), asks for
  // specific story ids (Saved), or needs the whole pool (blindspot scan), skip it.
  if (outlets.length > 0 || (ids && ids.length) || skipCap) return ordered.slice(0, limit);
  const perOutletCap = Math.max(3, Math.ceil(limit * 0.25));
  const outletCount = new Map();
  const picked = [];
  for (const story of ordered) {
    const domains = new Set(story.sources.map((s) => s.domain));
    const over = [...domains].some((d) => (outletCount.get(d) || 0) >= perOutletCap);
    if (over) continue;
    for (const d of domains) outletCount.set(d, (outletCount.get(d) || 0) + 1);
    picked.push(story);
    if (picked.length >= limit) break;
  }
  return picked;
}

function getBlindspots({ limit = 20 } = {}) {
  const all = getFeed({ limit: 5000, skipCap: true });
  const blindspots = [];
  for (const story of all) {
    if (story.ratedCount < BLINDSPOT_MIN_SOURCES) continue;
    const leftShare = story.left / story.ratedCount;
    const rightShare = story.right / story.ratedCount;
    if (rightShare <= BLINDSPOT_MAX_SHARE && story.left > 0) {
      blindspots.push({ ...story, blindspotSide: "right", note: "Right-leaning outlets barely covered this." });
    } else if (leftShare <= BLINDSPOT_MAX_SHARE && story.right > 0) {
      blindspots.push({ ...story, blindspotSide: "left", note: "Left-leaning outlets barely covered this." });
    }
  }
  return blindspots.slice(0, limit);
}

function getMyBias(visitorId) {
  const rows = store.clicksByVisitor(visitorId);
  let left = 0, center = 0, right = 0, unrated = 0;
  for (const r of rows) {
    const info = biasForDomain(r.domain);
    if (!info) { unrated++; continue; }
    if (info.bias <= -1) left++;
    else if (info.bias >= 1) right++;
    else center++;
  }
  const total = left + center + right;

  // Daily history, last 7 days (oldest -> newest)
  const detail = store.clicksByVisitorDetail(visitorId);
  const dayBuckets = new Map(); // YYYY-MM-DD -> { left, center, right }
  for (const r of detail) {
    const info = biasForDomain(r.domain);
    if (!info) continue;
    const day = (r.clicked_at || "").slice(0, 10);
    if (!day) continue;
    const b = dayBuckets.get(day) || { left: 0, center: 0, right: 0 };
    if (info.bias <= -1) b.left++;
    else if (info.bias >= 1) b.right++;
    else b.center++;
    dayBuckets.set(day, b);
  }
  const history = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const b = dayBuckets.get(key) || { left: 0, center: 0, right: 0 };
    const t = b.left + b.center + b.right;
    history.push({
      date: key,
      left: b.left, center: b.center, right: b.right, total: t,
      leftPct: t ? Math.round((b.left / t) * 100) : 0,
      centerPct: t ? Math.round((b.center / t) * 100) : 0,
      rightPct: t ? Math.round((b.right / t) * 100) : 0,
    });
  }

  return {
    totalClicks: rows.length,
    left, center, right, unrated,
    leftPct: total ? Math.round((left / total) * 100) : 0,
    centerPct: total ? Math.round((center / total) * 100) : 0,
    rightPct: total ? Math.round((right / total) * 100) : 0,
    history,
  };
}

// ---------- anonymous visitor cookie (no login, no accounts, no PII) ----------
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const pair of header.split(";")) {
    const [k, ...v] = pair.trim().split("=");
    if (k) {
      const raw = v.join("=");
      try {
        out[k] = decodeURIComponent(raw);
      } catch {
        out[k] = raw; // malformed cookie value — never let it take down the server
      }
    }
  }
  return out;
}
function getOrSetVisitorId(req, res) {
  const cookies = parseCookies(req);
  if (cookies.visitor_id) return cookies.visitor_id;
  const id = crypto.randomUUID();
  // 1 year, HttpOnly (JS doesn't need to read it), SameSite=Lax is enough for same-site fetches
  res.setHeader(
    "Set-Cookie",
    `visitor_id=${id}; Max-Age=${60 * 60 * 24 * 365}; Path=/; HttpOnly; SameSite=Lax`
  );
  return id;
}

function csvParam(url, key) {
  const v = url.searchParams.get(key);
  if (!v) return null;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}
function numParam(url, key, fallback) {
  const v = url.searchParams.get(key);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    const visitorId = getOrSetVisitorId(req, res);
    if (url.pathname === "/" ) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(path.join(__dirname, "index.html")));
      return;
    }

    if (url.pathname === "/styles.css") {
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=86400" });
      res.end(fs.readFileSync(path.join(__dirname, "styles.css")));
      return;
    }

    if (url.pathname === "/frontend.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" });
      res.end(fs.readFileSync(path.join(__dirname, "frontend.js")));
      return;
    }

    if (url.pathname === "/api/feed") {
      const geos = csvParam(url, "geo") || [];
      const topics = csvParam(url, "topic") || [];
      const hideTopics = csvParam(url, "notopic") || [];
      const outlets = csvParam(url, "outlets") || [];
      const hideOutlets = csvParam(url, "nooutlet") || [];
      const ids = csvParam(url, "ids") || null;
      const hours = url.searchParams.get("hours") ? numParam(url, "hours", null) : null;
      const q = url.searchParams.get("q") || null;
      const sort = url.searchParams.get("sort") || "newest";
      const limit = numParam(url, "limit", 50);
      const offset = numParam(url, "offset", 0);
      json(res, getFeed({ geos, topics, hideTopics, outlets, hideOutlets, hours, q, ids, sort, limit, offset }));
      return;
    }

    if (url.pathname.startsWith("/logo/")) {
      const file = decodeURIComponent(url.pathname.slice("/logo/".length));
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(file)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      try {
        const buf = fs.readFileSync(path.join(LOGO_DIR, file));
        res.writeHead(200, {
          "Content-Type": contentTypeFor(buf),
          "Cache-Control": "public, max-age=86400",
        });
        res.end(buf);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
      return;
    }

    if (url.pathname === "/api/filters") {
      const opts = store.filterOptions();
      opts.outlets = opts.outlets.map((o) => ({
        ...o,
        label: outletLabel(o.name),
        bias: biasForDomain(o.name)?.bias ?? null,
        factuality: biasForDomain(o.name)?.factuality ?? null,
        owner: biasForDomain(o.name)?.owner ?? null,
      }));
      json(res, opts);
      return;
    }

    if (url.pathname === "/api/sources") {
      const sources = Object.entries(biasDb.outlets).map(([domain, info]) => ({
        domain,
        name: info.name,
        bias: info.bias,
        factuality: info.factuality,
        owner: info.owner,
        source: info.source || null,
        geo: feeds.find(f => f.domain === domain)?.geo || null,
        logo: logoFileFor(domain),
      }));
      json(res, { sources });
      return;
    }

    if (url.pathname === "/api/blindspots") {
      json(res, getBlindspots());
      return;
    }

    if (url.pathname === "/api/my-bias") {
      json(res, getMyBias(visitorId));
      return;
    }

    if (url.pathname === "/api/click" && req.method === "POST") {
      const body = await readBody(req);
      const { articleId } = JSON.parse(body);
      store.insertClick(articleId, visitorId);
      json(res, { ok: true });
      return;
    }

    if (url.pathname === "/api/ingest" && req.method === "POST") {
      ingestAll().catch((e) => console.error(e));
      json(res, { ok: true, message: "ingestion started in background" });
      return;
    }

    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`server error: ${err && err.message ? err.message : err}`);
  }
});

function json(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// A bad request (e.g. malformed cookie) must never take the whole process down.
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

server.listen(PORT, () => {
  console.log(`NewsPop running at http://localhost:${PORT}`);
  if (CLUSTER_MODE === "embedding") {
    console.log(`CLUSTER_MODE=embedding — make sure embed_server.py is running on port 5055.`);
  } else {
    console.log(`CLUSTER_MODE=tfidf — no sidecar needed.`);
  }
});
server.on("error", (err) => {
  console.error(err);
});

// One-time migration: re-cluster everything with the representative-based
// algorithm before the first ingest so they don't fight over the same data.
async function boot() {
  if (!store.getFlag("reclusteredV2")) {
    try {
      await reclusterAll();
      store.setFlag("reclusteredV2", true);
    } catch (err) {
      console.error("[recluster] failed — will retry next boot", err);
    }
  }
  // Re-topic pass: stored articles carry labels from the old keyword classifier.
  // Re-run every boot, but only apply labels the classifier can stand behind —
  // publisher category tags, feed-declared sections, or model guesses only once
  // the model is trained on real multi-topic data. Low-confidence guesses
  // ("General") never overwrite an existing label, so this converges instead of
  // clobbering. As more tagged articles accumulate, more stored stories improve.
  {
    trainTopicModel(labelsForTraining());
    const updates = new Map();
    for (const a of store.allArticles()) {
      if (a.cluster_id === null || a.cluster_id === undefined) continue;
      const { topic, source } = classifyArticle({ title: a.title, categories: a.categories || [], feedTopic: feedTopicForDomain(a.domain) });
      const safe = source === "category" || source === "feed" || (source === "model" && topic !== TOPIC_FALLBACK);
      if (safe) updates.set(a.id, topic);
    }
    const reTagged = store.setArticleTopics(updates);
    store.flush();
    if (reTagged > 0) console.log(`[topics] re-tagged ${reTagged} stored articles`);
  }
  await ingestAll();
}

boot().catch((e) => console.error(e));
setInterval(() => ingestAll().catch((e) => console.error(e)), 15 * 60 * 1000);
