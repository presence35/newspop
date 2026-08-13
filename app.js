// NewsPop — server entry point.
// Wires the lib/ modules together: opens the JSON store, serves the client
// tree + JSON API, and runs ingestion on boot + a 15-minute timer.
//
// No native dependencies. Data is stored in data/newspop.json via lib/store.js —
// a tiny in-memory + periodic-flush store, chosen because native SQLite
// modules (better-sqlite3, node:sqlite) either need a C++ compiler on the
// host or a Node version this host doesn't have. This app's data volume
// (RSS headlines + click events) is small enough that this is genuinely
// fine, not just a workaround.
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
import os from "node:os";
import { createStore } from "./lib/store.js";
import { PORT, HOST, CLUSTER_MODE, DATA_DIR, ROOT_DIR, CLIENT_DIR } from "./lib/config.js";
import { biasDb, feeds } from "./lib/data.js";
import { contentTypeFor, logoFileFor } from "./lib/logos.js";
import { classifyArticle, trainTopicModel, labelsForTraining, feedTopicForDomain, TOPIC_FALLBACK } from "./lib/topics.js";
import { ingestAll, reclusterAll } from "./lib/ingest.js";
import { getFeed, getBlindspots, getMyBias, outletLabel } from "./lib/stories.js";
import { getOrSetVisitorId, csvParam, numParam, json, readBody, serveStatic } from "./lib/http.js";

const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8")).version;

// ---------- store setup ----------
let store;
try {
  store = createStore(DATA_DIR);
} catch (err) {
  console.error(`cannot use ${DATA_DIR} — falling back to ${os.tmpdir()}`, err);
  store = createStore(path.join(os.tmpdir(), "newspop-data"));
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    const visitorId = getOrSetVisitorId(req, res);

    if (url.pathname === "/" || url.pathname.startsWith("/css/") || url.pathname.startsWith("/js/") || url.pathname === "/sw.js" || url.pathname.startsWith("/sw/")) {
      serveStatic(res, CLIENT_DIR, url.pathname);
      return;
    }

    if (url.pathname === "/manifest.webmanifest") {
      serveStatic(res, ROOT_DIR, url.pathname);
      return;
    }

    if (url.pathname.startsWith("/icons/")) {
      const file = decodeURIComponent(url.pathname.slice("/icons/".length));
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(file)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      try {
        const buf = fs.readFileSync(path.join(ROOT_DIR, "icons", file));
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

    if (url.pathname === "/api/feed") {
      const geos = csvParam(url, "geo") || [];
      const topics = csvParam(url, "topic") || [];
      const hideTopics = csvParam(url, "notopic") || [];
      const outlets = csvParam(url, "outlets") || [];
      const hideOutlets = csvParam(url, "nooutlet") || [];
      const notq = csvParam(url, "notq") || [];
      const ids = csvParam(url, "ids") || null;
      const hours = url.searchParams.get("hours") ? numParam(url, "hours", null) : null;
      const q = url.searchParams.get("q") || null;
      const sort = url.searchParams.get("sort") || "newest";
      const limit = numParam(url, "limit", 50);
      const offset = numParam(url, "offset", 0);
      json(res, getFeed(store, biasDb, { geos, topics, hideTopics, outlets, hideOutlets, notq, hours, q, ids, sort, limit, offset }));
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
        const buf = fs.readFileSync(path.join(ROOT_DIR, "logos", file));
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

    if (url.pathname === "/api/version") {
      json(res, { version: APP_VERSION });
      return;
    }

    if (url.pathname === "/api/filters") {
      const opts = store.filterOptions();
      opts.outlets = opts.outlets.map((o) => ({
        ...o,
        label: outletLabel(biasDb, o.name),
        bias: biasDb.outlets[o.name]?.bias ?? null,
        factuality: biasDb.outlets[o.name]?.factuality ?? null,
        owner: biasDb.outlets[o.name]?.owner ?? null,
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
      json(res, getBlindspots(store, biasDb));
      return;
    }

    if (url.pathname === "/api/my-bias") {
      json(res, getMyBias(store, biasDb, visitorId));
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
      ingestAll(store, feeds).catch((e) => console.error(e));
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
      await reclusterAll(store);
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
    trainTopicModel(labelsForTraining(store, feeds));
    const updates = new Map();
    for (const a of store.allArticles()) {
      if (a.cluster_id === null || a.cluster_id === undefined) continue;
      const { topic, source } = classifyArticle({ title: a.title, categories: a.categories || [], feedTopic: feedTopicForDomain(feeds, a.domain) });
      const safe = source === "category" || source === "feed" || (source === "model" && topic !== TOPIC_FALLBACK);
      if (safe) updates.set(a.id, topic);
    }
    const reTagged = store.setArticleTopics(updates);
    store.flush();
    if (reTagged > 0) console.log(`[topics] re-tagged ${reTagged} stored articles`);
  }
  await ingestAll(store, feeds);
}

boot().catch((e) => console.error(e));
setInterval(() => ingestAll(store, feeds).catch((e) => console.error(e)), 15 * 60 * 1000);
