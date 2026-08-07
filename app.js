// GroundZero — single-file Node server.
// RSS ingestion -> embedded JSON store -> cluster articles into stories ->
// tally bias per story -> serve plain JSON API + static HTML feed.
//
// No native dependencies. Data is stored in data/ground.json via store.js —
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
const CLUSTER_SIM_THRESHOLD = CLUSTER_MODE === "embedding" ? 0.72 : 0.20; // different scales for cosine-on-embeddings vs tfidf overlap
const BLINDSPOT_MIN_SOURCES = 4; // story needs at least this many outlets to qualify
const BLINDSPOT_MAX_SHARE = 0.20; // one side must be <=20% of coverage to be a blindspot

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
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
  store = createStore(path.join(os.tmpdir(), "groundzero-data"));
}

// ---------- tiny RSS parser (no deps) ----------
function parseRss(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate") || extractTag(block, "dc:date");
    if (title && link) items.push({ title: decodeEntities(title), link: link.trim(), pubDate });
  }
  return items;
}
function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim();
}
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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

// ---------- ingestion ----------
async function ingestAll() {
  console.log(`[ingest] starting, ${feeds.length} feeds`);
  const newArticles = [];

  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url, { signal: AbortSignal.timeout(10000) });
      const xml = await res.text();
      const items = parseRss(xml).slice(0, 20); // cap per feed per run
      for (const item of items) {
        if (store.findArticleByLink(item.link)) continue;
        newArticles.push({ ...item, domain: feed.domain, geo: feed.geo });
      }
    } catch (err) {
      console.warn(`[ingest] failed for ${feed.domain}: ${err.message}`);
    }
  }

  if (newArticles.length === 0) {
    console.log("[ingest] no new articles");
    return;
  }
  console.log(`[ingest] ${newArticles.length} new articles, clustering via ${CLUSTER_MODE}...`);

  // Load existing recent clustered articles (last 48h) to compare new arrivals against
  const recentClustered = store.recentClusteredArticles(48);

  let newVectors, recentVectors, simFn;

  if (CLUSTER_MODE === "embedding") {
    try {
      const embeddings = await getEmbeddings(newArticles.map((a) => a.title));
      newVectors = embeddings;
      recentVectors = recentClustered
        .filter((r) => r.embedding)
        .map((r) => ({ cluster_id: r.cluster_id, vec: JSON.parse(r.embedding) }));
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
    recentVectors = recentClustered.map((r, i) => ({
      cluster_id: r.cluster_id,
      vec: allVecs[newArticles.length + i],
    }));
    simFn = sparseCosineSim;
  }

  const growingRecent = [...recentVectors];

  for (let i = 0; i < newArticles.length; i++) {
    const art = newArticles[i];
    const vec = newVectors[i];
    let clusterId = null;
    let bestSim = 0, bestCluster = null;

    for (const existing of growingRecent) {
      const sim = simFn(vec, existing.vec);
      if (sim > bestSim) { bestSim = sim; bestCluster = existing.cluster_id; }
    }

    if (bestSim >= CLUSTER_SIM_THRESHOLD) {
      clusterId = bestCluster;
    } else {
      clusterId = store.insertCluster(art.title);
    }
    growingRecent.push({ cluster_id: clusterId, vec });

    const embeddingToStore =
      CLUSTER_MODE === "embedding" && Array.isArray(vec) ? JSON.stringify(vec) : null;

    store.insertArticle({
      domain: art.domain,
      title: art.title,
      link: art.link,
      published_at: art.pubDate || null,
      geo: art.geo,
      cluster_id: clusterId,
      embedding: embeddingToStore,
    });
  }

  store.flush();
  console.log(`[ingest] done`);
}

// ---------- bias tally per story ----------
function biasForDomain(domain) {
  return biasDb.outlets[domain] || null;
}
function tallyStory(clusterId) {
  const articles = store.articlesByCluster(clusterId);

  let left = 0, center = 0, right = 0, rated = 0;
  const sources = articles.map((a) => {
    const info = biasForDomain(a.domain);
    if (info) {
      rated++;
      if (info.bias <= -1) left++;
      else if (info.bias >= 1) right++;
      else center++;
    }
    return { ...a, bias: info ? info.bias : null, name: info ? info.name : a.domain, factuality: info ? info.factuality : null };
  });

  return {
    clusterId,
    headline: articles[0]?.title || "",
    sourceCount: articles.length,
    ratedCount: rated,
    left, center, right,
    leftPct: rated ? Math.round((left / rated) * 100) : null,
    centerPct: rated ? Math.round((center / rated) * 100) : null,
    rightPct: rated ? Math.round((right / rated) * 100) : null,
    sources,
  };
}

function getFeed({ geo = null, limit = 50 } = {}) {
  const clusterIds = store.distinctClusterIds({ geo, limit });
  return clusterIds.map((id) => tallyStory(id)).filter((s) => s.sourceCount > 0);
}

function getBlindspots({ limit = 20 } = {}) {
  const all = getFeed({ limit: 200 });
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
  return {
    totalClicks: rows.length,
    left, center, right, unrated,
    leftPct: total ? Math.round((left / total) * 100) : 0,
    centerPct: total ? Math.round((center / total) * 100) : 0,
    rightPct: total ? Math.round((right / total) * 100) : 0,
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

    if (url.pathname === "/api/feed") {
      const geo = url.searchParams.get("geo");
      const feed = getFeed({ geo });
      json(res, feed);
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
  console.log(`GroundZero running at http://localhost:${PORT}`);
  if (CLUSTER_MODE === "embedding") {
    console.log(`CLUSTER_MODE=embedding — make sure embed_server.py is running on port 5055.`);
  } else {
    console.log(`CLUSTER_MODE=tfidf — no sidecar needed.`);
  }
});
server.on("error", (err) => {
  console.error(err);
});

// Ingest on boot, then every 15 minutes
ingestAll().catch((e) => console.error(e));
setInterval(() => ingestAll().catch((e) => console.error(e)), 15 * 60 * 1000);
