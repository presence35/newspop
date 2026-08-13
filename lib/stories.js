// lib/stories.js — turns stored clusters into feed stories: per-story bias
// tally, feed queries, blindspots, and the reader's own bias from click data.
import { BLINDSPOT_MIN_SOURCES, BLINDSPOT_MAX_SHARE } from "./config.js";
import { articleTime } from "./cluster.js";
import { logoFileFor } from "./logos.js";

export function biasForDomain(biasDb, domain) {
  return biasDb.outlets[domain] || null;
}
export function outletLabel(biasDb, domain) {
  const known = biasDb.outlets[domain];
  if (known && known.name) return known.name;
  const base = domain.replace(/^www\./, "").replace(/\.(com|co\.uk|co|org|net|io|gov|info|ua|uk)$/, "");
  return base.split(/[-.]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

export function tallyStory(store, biasDb, clusterId, articlesArg) {
  // Pre-grouped articles (used by getBlindspots' single-pass scan) avoid a full
  // store scan per cluster; otherwise pull the cluster's own rows as before.
  const articles = (articlesArg || store.articlesByCluster(clusterId))
    .sort((a, b) => articleTime(a) - articleTime(b)); // earliest first; headline is the first item

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
    const info = biasForDomain(biasDb, domain);
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
      name: info ? info.name : outletLabel(biasDb, domain),
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

export function getFeed(store, biasDb, { geos = [], topics = [], hideTopics = [], outlets = [], hideOutlets = [], notq = [], hours = null, q = null, ids = null, sort = "newest", limit = 50, offset = 0, skipCap = false } = {}) {
  const pool = store.distinctClusterIds({ geos, topics, hideTopics, outlets, hideOutlets, notq, hours, q, ids, limit: limit * 3, offset });
  const stories = pool.map((id) => tallyStory(store, biasDb, id)).filter((s) => s.sourceCount > 0);
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

export function getBlindspots(store, biasDb, { limit = 20, hours = 72 } = {}) {
  // Blindspots are about current coverage, so bound the scan to the recent
  // window (same "any article in the window" rule the feed filter uses).
  // Group articles by cluster in one pass and tally each cluster's own rows,
  // instead of getFeed's per-cluster full-store scan — O(clusters x articles)
  // grew to multi-second once the store got bigger.
  const cutoff = hours ? Date.now() - hours * 3600 * 1000 : null;
  const byCluster = new Map();
  for (const a of store.allArticles()) {
    if (a.cluster_id === null || a.cluster_id === undefined) continue;
    if (cutoff && articleTime(a) <= cutoff) continue;
    let list = byCluster.get(a.cluster_id);
    if (!list) { list = []; byCluster.set(a.cluster_id, list); }
    list.push(a);
  }
  const blindspots = [];
  for (const [cid, articles] of byCluster) {
    const story = tallyStory(store, biasDb, cid, articles);
    if (story.ratedCount < BLINDSPOT_MIN_SOURCES) continue;
    const leftShare = story.left / story.ratedCount;
    const rightShare = story.right / story.ratedCount;
    if (rightShare <= BLINDSPOT_MAX_SHARE && story.left > 0) {
      blindspots.push({ ...story, blindspotSide: "right", note: "Right-leaning outlets barely covered this." });
    } else if (leftShare <= BLINDSPOT_MAX_SHARE && story.right > 0) {
      blindspots.push({ ...story, blindspotSide: "left", note: "Left-leaning outlets barely covered this." });
    }
  }
  return blindspots.sort((a, b) => b.publishedTs - a.publishedTs).slice(0, limit);
}

export function getMyBias(store, biasDb, visitorId) {
  const rows = store.clicksByVisitor(visitorId);
  let left = 0, center = 0, right = 0, unrated = 0;
  for (const r of rows) {
    const info = biasForDomain(biasDb, r.domain);
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
    const info = biasForDomain(biasDb, r.domain);
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
