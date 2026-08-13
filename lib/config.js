// lib/config.js — env-derived runtime configuration for the server.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.join(__dirname, "..");

export const PORT = process.env.PORT || 3000;
export const HOST = process.env.HOST || "127.0.0.1"; // set to 0.0.0.0 to accept non-local connections
export const CLUSTER_MODE = process.env.CLUSTER_MODE || "tfidf"; // "tfidf" | "embedding"
export const EMBED_URL = "http://127.0.0.1:5055/embed";
export const CLUSTER_SIM_THRESHOLD = CLUSTER_MODE === "embedding" ? 0.72 : 0.28; // different scales for cosine-on-embeddings vs tfidf overlap
export const BLINDSPOT_MIN_SOURCES = 4; // story needs at least this many outlets to qualify
export const BLINDSPOT_MAX_SHARE = 0.2; // one side must be <=20% of coverage to be a blindspot
export const IMG_MAX_WIDTH = 1280; // cap for CDN image size rewrites (BBC/France24-style token URLs)
export const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 7; // drop articles older than this on each ingest

export const DATA_DIR = path.join(ROOT_DIR, "data");
export const LOGO_DIR = path.join(ROOT_DIR, "logos");
export const CLIENT_DIR = path.join(ROOT_DIR, "client");
