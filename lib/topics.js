// lib/topics.js — topic classifier (trained from publisher labels, zero-dependency).
// Best practice: don't hand-maintain headline keyword lists (they grow forever).
// Instead, learn from labels the publishers already provide — item-level
// <category> tags and per-feed section topics — and generalize to unlabeled
// headlines with a tiny multinomial Naive Bayes (pure JS, no deps). Retrained
// on every ingest; nothing accumulates by hand.
import { tokenize } from "./cluster.js";

export const TOPIC_FALLBACK = "General";

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
export function topicFromCategory(cat) {
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
export function trainTopicModel(pairs) {
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
export function modelIsTrustworthy() {
  const { classes, tc } = topicModel;
  if (classes.length < 2) return false; // a single-topic training set predicts everything as that topic
  let total = 0;
  for (const c of classes) total += tc.get(c);
  return total >= MIN_TRAIN_DOCS;
}
export function predictTopic(title) {
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
export function feedTopicForDomain(feeds, domain) {
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
export function classifyArticle({ title, categories = [], feedTopic = null }) {
  for (const cat of categories) {
    const t = topicFromCategory(cat);
    if (t) return { topic: t, source: "category" };
  }
  if (feedTopic) return { topic: feedTopic, source: "feed" };
  if (modelIsTrustworthy()) return { topic: predictTopic(title).topic, source: "model" };
  return { topic: TOPIC_FALLBACK, source: "model-untrusted" };
}
export function labelsForTraining(store, feeds) {
  const pairs = [];
  for (const a of store.allArticles()) {
    let label = null;
    for (const cat of a.categories || []) { const t = topicFromCategory(cat); if (t) { label = t; break; } }
    if (!label) label = feedTopicForDomain(feeds, a.domain);
    if (label) pairs.push({ title: a.title, topic: label });
  }
  return pairs;
}
