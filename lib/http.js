// lib/http.js — small HTTP helpers shared by the route handler: visitor cookie,
// query-param parsing, JSON responses, request body reading, and static serving.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { contentTypeFor } from "./logos.js";

// ---------- anonymous visitor cookie (no login, no accounts, no PII) ----------
export function parseCookies(req) {
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
export function getOrSetVisitorId(req, res) {
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

// ---------- query param parsing ----------
export function csvParam(url, key) {
  const v = url.searchParams.get(key);
  if (!v) return null;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}
export function numParam(url, key, fallback) {
  const v = url.searchParams.get(key);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------- responses ----------
export function json(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Static files: maps the client tree (/, /css/*, /js/*, /sw/*, sw.js) onto disk
// with a strict name guard — the same pattern used for /icons/ and /logo/.
const STATIC_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
export function serveStatic(res, clientDir, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
  if (!SAFE_NAME.test(rel)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const file = path.join(clientDir, rel);
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const type = STATIC_CONTENT_TYPES[path.extname(file).toLowerCase()] || contentTypeFor(buf);
  // The service worker's CacheStorage is the real offline cache for the client
  // tree, so the HTTP cache must never hide a freshly deployed file. Serving
  // with `no-cache` forces every revalidation (SW background refresh and the
  // SW install-time cache.addAll) to check the server — otherwise a deploy
  // could take up to a day to reach installed apps.
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-cache",
  });
  res.end(buf);
}
