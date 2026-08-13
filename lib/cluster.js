// lib/cluster.js — similarity vectors + clustering utilities.
//
// Two vector backends, chosen by CLUSTER_MODE (see lib/config.js):
//   "tfidf"     (default) — zero dependencies, no model, no sidecar. Pure JS
//               sparse term-frequency vectors weighted by inverse document
//               frequency, so common words ("says", "reports") don't dominate.
//   "embedding" — better recall on paraphrased headlines, needs embed_server.py
//               running locally (still zero API cost — local model, not a paid call).
import { EMBED_URL } from "./config.js";

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

export function stem(word) {
  // crude suffix stripping — enough to match "rate/rates", "cut/cuts/cutting"
  // across differently-worded headlines about the same story
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

export function tokenize(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map(stem);
}

export function buildTfidfVectors(titles) {
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

export function sparseCosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [term, val] of a) {
    na += val * val;
    if (b.has(term)) dot += val * b.get(term);
  }
  for (const [, val] of b) nb += val * val;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------- embedding + similarity (embedding mode) ----------
export async function getEmbeddings(texts) {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });
  if (!res.ok) throw new Error(`embed sidecar returned ${res.status}`);
  const data = await res.json();
  return data.embeddings;
}

export function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Effective "when did this story happen" time — same rule the store uses for
// ordering and the `hours` cutoff: RSS pubDate wins, created_at is the fallback.
export function articleTime(a) {
  const pts = a.published_at ? Date.parse(a.published_at) : NaN;
  const cts = a.created_at ? Date.parse(a.created_at) : NaN;
  const t = Math.max(pts, cts);
  return Number.isFinite(t) ? t : 0;
}

// One representative per cluster for similarity: the earliest article (by
// articleTime) is the headline the feed card displays, so matching new
// arrivals against it keeps every member of a cluster on-topic.
export function pickClusterReps(entries, timeOf, vecOf) {
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
