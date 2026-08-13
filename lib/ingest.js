// lib/ingest.js — feed ingestion + one-time re-clustering.
import { CLUSTER_MODE, CLUSTER_SIM_THRESHOLD, RETENTION_DAYS } from "./config.js";
import { parseRss } from "./rss.js";
import { classifyArticle, trainTopicModel, labelsForTraining } from "./topics.js";
import {
  getEmbeddings, cosineSim, buildTfidfVectors, sparseCosineSim,
  articleTime, pickClusterReps,
} from "./cluster.js";

function bootLog(msg, err) {
  const detail = err ? ` — ${(err && err.stack) || err}` : "";
  console.log(`[${new Date().toISOString()}] ${msg}${detail}`);
}

// One ingest at a time: boot, the 15-min timer, and manual /api/ingest can
// all overlap, and running two concurrently would double-fetch feeds and
// interleave cluster decisions. A second call while one is in flight just
// logs and returns.
let ingesting = false;
export async function ingestAll(store, feeds) {
  if (ingesting) {
    console.log("[ingest] already running, skipping this tick");
    return;
  }
  ingesting = true;
  try {
    await ingestAllInner(store, feeds);
  } finally {
    ingesting = false;
  }
}

async function ingestAllInner(store, feeds) {
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
  trainTopicModel(labelsForTraining(store, feeds));
  console.log(`[ingest] done`);
}

// ---------- one-time re-cluster (representative-based algorithm) ----------
// Recomputes cluster assignments for every stored article using the same
// representative matching as ingest, so clusters polluted by the old
// per-article chaining (e.g. 143 unrelated articles in one cluster) are
// cleaned up immediately instead of lingering until the 7-day retention prune.
export async function reclusterAll(store) {
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
