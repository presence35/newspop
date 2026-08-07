// store.js — tiny embedded JSON-backed data store. Zero dependencies,
// no native bindings, no compiler needed. Works on any Node version.
//
// Why not SQLite: better-sqlite3 needs a native build (g++, python, make)
// which many shared hosts (including this Plesk box) don't provide, and
// there's no prebuilt binary for every Node version/platform combo. This
// app's data size (RSS headlines, clicks) is small enough that a flat
// in-memory array with periodic disk flush is simpler and just as fast.
//
// Trade-offs vs real SQLite, worth knowing:
// - No concurrent-writer safety beyond a single Node process (fine here —
//   one process owns the data).
// - Everything loads into memory. Fine up to tens of thousands of rows;
//   would need real SQLite/Postgres well before that becomes a problem
//   for a personal/small-group news aggregator.
// - Writes are batched to disk every FLUSH_INTERVAL_MS, not immediate.
//   A crash within that window loses the most recent writes — acceptable
//   for this app (RSS re-ingests are idempotent, clicks are low-stakes).

import fs from "node:fs";
import path from "node:path";

const FLUSH_INTERVAL_MS = 5000;

export function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, "ground.json");

  let data = { articles: [], clusters: [], clicks: [], nextId: { article: 1, cluster: 1, click: 1 } };
  if (fs.existsSync(filePath)) {
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      // backfill in case of older/partial files
      data.articles ??= [];
      data.clusters ??= [];
      data.clicks ??= [];
      data.nextId ??= { article: 1, cluster: 1, click: 1 };
    } catch (err) {
      console.error(`[store] failed to load ${filePath}, starting fresh: ${err.message}`);
    }
  }

  // Backfill fields older data files may lack, so sorting/tallying never hits nulls.
  const fallbackCreated = new Date().toISOString();
  for (const a of data.articles) {
    if (!a.created_at) a.created_at = fallbackCreated;
    if (a.geo === undefined) a.geo = null;
  }

  let dirty = false;
  function markDirty() { dirty = true; }
  function flush() {
    if (!dirty) return;
    fs.writeFileSync(filePath, JSON.stringify(data));
    dirty = false;
  }
  setInterval(flush, FLUSH_INTERVAL_MS).unref();
  process.on("exit", flush);
  process.on("SIGINT", () => { flush(); process.exit(0); });
  process.on("SIGTERM", () => { flush(); process.exit(0); });

  return {
    // ---- articles ----
    findArticleByLink(link) {
      return data.articles.find((a) => a.link === link) || null;
    },
    insertArticle({ domain, title, link, published_at, geo, cluster_id, embedding }) {
      if (data.articles.some((a) => a.link === link)) return null; // INSERT OR IGNORE equivalent
      const id = data.nextId.article++;
      const row = {
        id, domain, title, link,
        published_at: published_at || null,
        geo, cluster_id, embedding: embedding || null,
        created_at: new Date().toISOString(),
      };
      data.articles.push(row);
      markDirty();
      return row;
    },
    articlesByCluster(clusterId) {
      return data.articles
        .filter((a) => a.cluster_id === clusterId)
        .sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
    },
    recentClusteredArticles(hoursAgo = 48) {
      const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
      return data.articles.filter(
        (a) => a.cluster_id !== null && a.cluster_id !== undefined && new Date(a.created_at).getTime() > cutoff
      );
    },
    distinctClusterIds({ geo = null, limit = 50 } = {}) {
      const pool = geo ? data.articles.filter((a) => a.geo === geo) : data.articles;
      const seen = new Map(); // cluster_id -> most recent created_at, for ordering
      for (const a of pool) {
        if (a.cluster_id === null || a.cluster_id === undefined) continue;
        const existing = seen.get(a.cluster_id);
        if (!existing || a.created_at > existing) seen.set(a.cluster_id, a.created_at);
      }
      return [...seen.entries()]
        .sort((a, b) => (b[1] || "").localeCompare(a[1] || ""))
        .slice(0, limit)
        .map(([cluster_id]) => cluster_id);
    },

    // ---- clusters ----
    insertCluster(headline) {
      const id = data.nextId.cluster++;
      data.clusters.push({ id, headline, created_at: new Date().toISOString() });
      markDirty();
      return id;
    },

    // ---- clicks ----
    insertClick(articleId, visitorId) {
      const id = data.nextId.click++;
      data.clicks.push({ id, article_id: articleId, visitor_id: visitorId, clicked_at: new Date().toISOString() });
      markDirty();
      return id;
    },
    clicksByVisitor(visitorId) {
      const clickRows = data.clicks.filter((c) => c.visitor_id === visitorId);
      const articlesById = new Map(data.articles.map((a) => [a.id, a]));
      return clickRows
        .map((c) => articlesById.get(c.article_id))
        .filter(Boolean)
        .map((a) => ({ domain: a.domain }));
    },

    flush, // exposed for explicit calls (e.g. after ingestion batch)
  };
}
