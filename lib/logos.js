// lib/logos.js — resolves outlet logos to local files.
//
// Outlet logos are downloaded once (at setup) into `logos/` and served from
// here, so readers' browsers never hit a third-party favicon service. Files
// are named `{source-slug}.{ext}` (e.g. msnbc.png, theglobeandmail.jpg); the
// slug is the outlet's domain minus its TLD. Content type comes from the file.
import fs from "node:fs";
import path from "node:path";
import { LOGO_DIR } from "./config.js";

export function logoSlug(domain) {
  let d = (domain || "").replace(/^www\./, "");
  for (const t of [".co.uk", ".com.au", ".com.ua", ".com", ".co", ".org", ".net", ".au", ".ca", ".ua", ".uk", ".eu"]) {
    if (d.endsWith(t)) { d = d.slice(0, -t.length); break; }
  }
  return d.split(".")[0] || "unknown";
}

const LOGO_CACHE = new Map(); // domain -> resolved file; dozens of outlets, static after setup
export function logoFileFor(domain) {
  const cached = LOGO_CACHE.get(domain);
  if (cached) return cached;
  const slug = logoSlug(domain);
  let file = `${slug}.png`;
  for (const ext of ["png", "jpg", "jpeg", "gif", "webp"]) {
    if (fs.existsSync(path.join(LOGO_DIR, `${slug}.${ext}`))) { file = `${slug}.${ext}`; break; }
  }
  LOGO_CACHE.set(domain, file);
  return file;
}

export function contentTypeFor(buf) {
  if (!buf || buf.length < 4) return "image/x-icon";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "image/webp";
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return "image/x-icon";
  const head = buf.slice(0, 512).toString("utf8");
  if (/^\s*(<\?xml|<svg)/i.test(head)) return "image/svg+xml";
  return "image/x-icon";
}
