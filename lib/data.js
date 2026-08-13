// lib/data.js — loads the two static data files that configure the app:
// bias-db.json (hand-curated outlet ratings) and feeds.json (the outlet lineup).
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "./config.js";

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export const biasDb = loadJson(path.join(ROOT_DIR, "bias-db.json"), { outlets: {} });
export const feeds = loadJson(path.join(ROOT_DIR, "feeds.json"), []);
