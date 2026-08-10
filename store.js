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
  const filePath = path.join(dataDir, "newspop.json");

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
    if (a.image === undefined) a.image = null;
    if (a.topic === undefined) a.topic = "general";
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
    insertArticle({ domain, title, link, published_at, geo, topic, cluster_id, embedding, image }) {
      if (data.articles.some((a) => a.link === link)) return null; // INSERT OR IGNORE equivalent
      const id = data.nextId.article++;
      const row = {
        id, domain, title, link,
        published_at: published_at || null,
        geo, topic: topic || "general",
        cluster_id, embedding: embedding || null,
        image: image || null,
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
    // Returns distinct cluster ids whose articles match all active filters.
    // Empty array/`null` for a filter means "no filter". `hours` is a created_at
    // cutoff. `q` is a case-insensitive headline substring search.
    distinctClusterIds({ geos = [], topics = [], hideTopics = [], outlets = [], hideOutlets = [], hours = null, q = null, limit = 50, offset = 0 } = {}) {
      const cutoff = hours ? Date.now() - hours * 60 * 60 * 1000 : null;
      const geosSet = new Set(geos);
      const topicsSet = new Set(topics);
      const hideTopicsSet = new Set(hideTopics);
      const outletsSet = new Set(outlets);
      const hideOutletsSet = new Set(hideOutlets);
      const needle = q ? q.toLowerCase() : null;

      const pool = data.articles.filter((a) => {
        if (a.cluster_id === null || a.cluster_id === undefined) return false;
        if (cutoff && new Date(a.created_at).getTime() <= cutoff) return false;
        if (geosSet.size && !geosSet.has(a.geo)) return false;
        if (topicsSet.size && !topicsSet.has(a.topic)) return false;
        if (outletsSet.size && !outletsSet.has(a.domain)) return false;
        if (needle && !(a.title || "").toLowerCase().includes(needle)) return false;
        return true;
      });

      const byCluster = new Map(); // cluster_id -> articles, for cluster-level filters
      for (const a of data.articles) {
        if (a.cluster_id === null || a.cluster_id === undefined) continue;
        if (!byCluster.has(a.cluster_id)) byCluster.set(a.cluster_id, []);
        byCluster.get(a.cluster_id).push(a);
      }
      // Dominant topic of a cluster, so the filtered story matches the tag shown.
      function clusterTopic(articles) {
        const cnt = new Map();
        for (const a of articles) {
          const t = a.topic || "general";
          cnt.set(t, (cnt.get(t) || 0) + 1);
        }
        let best = "general", bestN = -1;
        for (const [t, n] of cnt) if (n > bestN) { best = t; bestN = n; }
        return best;
      }

      const seen = new Map(); // cluster_id -> most recent created_at, for ordering
      for (const a of pool) {
        const existing = seen.get(a.cluster_id);
        if (!existing || a.created_at > existing) seen.set(a.cluster_id, a.created_at);
      }
      let ids = [...seen.entries()];
      // Hide filters are cluster-level: a story stays only if none of its outlets
      // are hidden and its dominant topic isn't hidden. Article-level matching
      // alone kept multi-source/mixed-topic clusters that users expect removed.
      if (hideOutletsSet.size || hideTopicsSet.size) {
        ids = ids.filter(([cid]) => {
          const all = byCluster.get(cid) || [];
          if (hideOutletsSet.size && all.some((x) => hideOutletsSet.has(x.domain))) return false;
          if (hideTopicsSet.size && hideTopicsSet.has(clusterTopic(all))) return false;
          return true;
        });
      }
      return ids
        .sort((a, b) => (b[1] || "").localeCompare(a[1] || ""))
        .slice(offset, offset + limit)
        .map(([cluster_id]) => cluster_id);
    },

    // Distinct geo/topic/outlet values with article counts, for filter chips.
    filterOptions() {
      const geos = new Map(), topics = new Map(), outlets = new Map();
      for (const a of data.articles) {
        if (a.geo) geos.set(a.geo, (geos.get(a.geo) || 0) + 1);
        if (a.topic) topics.set(a.topic, (topics.get(a.topic) || 0) + 1);
        outlets.set(a.domain, (outlets.get(a.domain) || 0) + 1);
      }
      const byCount = (entries) => entries.sort((a, b) => b.count - a.count);
      return {
        geos: byCount([...geos.entries()].map(([name, count]) => ({ name, count }))),
        topics: byCount([...topics.entries()].map(([name, count]) => ({ name, count }))),
        outlets: byCount([...outlets.entries()].map(([name, count]) => ({ name, count }))),
      };
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
    clicksByVisitorDetail(visitorId) {
      const clickRows = data.clicks.filter((c) => c.visitor_id === visitorId);
      const articlesById = new Map(data.articles.map((a) => [a.id, a]));
      return clickRows
        .map((c) => ({ article: articlesById.get(c.article_id), clicked_at: c.clicked_at }))
        .filter((r) => r.article)
        .map((r) => ({ domain: r.article.domain, clicked_at: r.clicked_at }));
    },

    // Drop articles older than the cutoff (plus their orphaned clusters).
    // Keeps newspop.json tiny when only a few days of data are wanted.
    pruneBefore(cutoffIso) {
      const cutoff = new Date(cutoffIso).getTime();
      const before = data.articles.length;
      data.articles = data.articles.filter((a) => {
        const t = new Date(a.created_at || 0).getTime();
        return t >= cutoff;
      });
      if (data.articles.length === before) return false;
      const live = new Set(data.articles.map((a) => a.cluster_id).filter((c) => c !== null && c !== undefined));
      data.clusters = data.clusters.filter((c) => live.has(c.id));
      markDirty();
      return true;
    },

    flush, // exposed for explicit calls (e.g. after ingestion batch)
  };
}
