# NewsPop

Local-first Ground News clone. No AI API calls, no subscription, no tracking
beyond your own `data/newspop.json` file.

## What it does

- Pulls RSS from ~17 outlets across the political spectrum (edit `feeds.json` to add more)
- Clusters articles into "same story, different outlets" using a **local**
  similarity pass — default is a zero-dependency TF-IDF token-overlap matcher
  (no model, no API); optionally a local embedding model via `embed_server.py`
  (still runs on your machine, not an API — free, no tokens)
- Shows a left/center/right bias bar per story, sourced from a hand-curated
  bias table (`bias-db.json`, same idea as AllSides/MBFC/Ad Fontes averaged)
- Blindspot feed: stories where one side of the spectrum covered it and the
  other side barely touched it (rule-based threshold, not AI)
- My Bias: tracks which outlets you actually click, tallies your own lean

## Deploying on Plesk (shared hosting, e.g. odesaplay.com.ua)

Zero native dependencies — no `npm install` required at all, no compiler
needed on the host. Data is stored in `data/newspop.json` via `store.js`, a
small embedded JSON store (see comments in that file for why, and its
trade-offs vs real SQLite).

Steps:
1. In Plesk, create a **subdomain** for this app (e.g.
   `newspop.yourdomain.com`) rather than a subpath like
   `yourdomain.com/other_apps/newspop/`. Plesk's Node.js extension routes
   one app per domain/subdomain — a subpath under your main domain would get
   routed into your *other* app's process, and its `/api/*` requests would
   never reach NewsPop (this is what "Unexpected token < in JSON" usually
   means — you're getting the other app's HTML/error page back instead).
2. Point the subdomain's **Application Root** at this folder.
3. Set **Application Startup File** to `app.js`.
4. No `npm install` needed — `app.js` and `store.js` use only Node built-ins.
5. Restart the app from the Plesk dashboard.
6. First boot creates `data/newspop.json` automatically and kicks off RSS
   ingestion — give it 15-30 seconds before checking the feed.

Because it's on its own subdomain, all the frontend's `/api/*` calls are
relative to NewsPop itself — no path rewriting needed.

## Setup

```bash
# Node server — only Node built-ins, no npm install needed at all (Node 18+)
node app.js
```

Open http://localhost:3000

Clustering uses the built-in zero-dependency `tfidf` mode by default. For
better recall on paraphrased headlines you can instead run a local embedding
sidecar (pure local math, no API key, no cost):

```bash
pip install sentence-transformers flask
python3 embed_server.py &
CLUSTER_MODE=embedding node app.js
```

First run of the sidecar downloads the embedding model (~80MB) once, then it's
fully offline. First ingestion cycle takes ~10-20s depending on feed response
times.

## Files

- `app.js` — RSS ingestion, the JSON store wiring, bias tally, blindspot
  detection, HTTP API, static file serving. One file (plus `store.js`), no
  npm install needed at all.
- `store.js` — tiny in-memory + periodic-flush JSON store backed by
  `data/newspop.json`. Deliberately replaces SQLite: native modules need a
  compiler (g++, python, make) that shared Plesk hosts don't provide. See the
  header comment for trade-offs vs real SQLite.
- `embed_server.py` — the only "AI" piece, and it's not really AI in the LLM
  sense — a small sentence-embedding model used purely to compute similarity
  between headlines for clustering. No generation, no reasoning, no per-call
  cost.
- `bias-db.json` — static outlet ratings. Extend this by hand; it's the same
  approach Ground News itself uses (aggregating existing bias raters rather
  than inventing its own).
- `feeds.json` — RSS source list with geo tags. Add outlets here + a matching
  entry in `bias-db.json` to expand coverage.
- `index.html` — the entire frontend. No framework, no build step,
  no JS bundler. Three tabs: Feed, Blindspot, My Bias.

## Known gaps vs. Ground News (intentionally out of v1 scope)

- No browser extension yet (same API could power one — /api/feed accepts a
  `?geo=` param, would need a `?url=` matcher for arbitrary pages)
- No ownership data table yet (same pattern as bias-db.json, just needs data)
- No paywall detection
- No push/email alerts
- Clustering threshold (`CLUSTER_SIM_THRESHOLD` in app.js: `0.72` embedding,
  `0.20` tfidf) may need tuning once you see real data — lower if same stories
  aren't clustering together, raise if unrelated stories are merging.

## My Bias tracking

Uses an anonymous `visitor_id` cookie (random UUID, HttpOnly, no login, no
accounts, no PII) so each browser gets its own click history and bias
percentage — safe for multiple friends sharing one server instance without
their reading habits blending together. Clearing cookies resets it; nothing
to delete server-side unless you want to prune old rows from `clicks`.

Ground News covers 50,000+ outlets; this starter file has ~33. To add one,
find its rating on mediabiasfactcheck.com or allsides.com and add a line to
`bias-db.json` in the same shape. No code changes needed — `feeds.json` and
`bias-db.json` are read at startup.
