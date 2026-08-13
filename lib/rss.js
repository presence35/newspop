// lib/rss.js — tiny RSS parser (no deps).
import { IMG_MAX_WIDTH } from "./config.js";

export function parseRss(xml) {
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
export function extractImage(block) {
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

export function upscaleImage(url) {
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

export function extractTag(block, tag) {
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

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z0-9]+);/g, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}
