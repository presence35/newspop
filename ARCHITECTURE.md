# NewsPop — Architecture

Reference for agents working in this repo. Read before making changes.

## Stack

- Plain **Node.js (>=18) ESM**, zero npm dependencies, no build step, no compiler.
- Browser client is **classic scripts loaded in order** in `client/index.html` (functions
  land on `window`, top-level `const`/`let` are shared across scripts). No bundler.
- Data lives in `data/newspop.json` via `lib/store.js` — an in-memory + periodic-flush
  JSON store. Deliberately **not** SQLite (host has no native build toolchain).

## Layout

```
app.js                 Server entry: store setup, HTTP routes, boot sequence, 15-min timer
lib/
  config.js            Env + constants (PORT, HOST, CLUSTER_MODE, thresholds, dirs)
  data.js              Loads bias-db.json (outlet ratings) + feeds.json (outlet lineup)
  store.js             JSON-backed data store (articles, clusters, clicks, flags)
  rss.js               RSS parsing: parseRss, extractImage, extractTag, decodeEntities
  topics.js            Naive-Bayes topic classifier trained from publisher labels
  cluster.js           Similarity vectors: TF-IDF (default) or local embeddings + cosine
  ingest.js            ingestAll + reclusterAll (representative-based clustering)
  stories.js           Feed/query layer: tallyStory, getFeed, getBlindspots, getMyBias
  logos.js             Outlet logo filename/slug/content-type resolution
  http.js              Cookie/param helpers, json, readBody, static file serving
client/
  index.html           Loads css/* and js/* in order
  css/                 base.css feed.css sources.css mybias.css responsive.css
  js/                  state.js util.js render.js views.js interactions.js init.js
  sw.js + sw/strategies.js   Service worker + cache strategies
data/                  newspop.json (gitignored)
logos/                 Downloaded outlet favicons, served from /logo/
icons/                 PWA icons
bias-db.json, feeds.json   Static data (source of truth for ratings + feeds)
embed_server.py        Optional local embedding sidecar (port 5055) for CLUSTER_MODE=embedding
```

## Data flow

1. **Ingest** (`lib/ingest.js`, boot + every 15 min + manual `POST /api/ingest`):
   fetch each feed in `feeds.json`, parse RSS (`lib/rss.js`), classify topic
   (`lib/topics.js`), cluster by headline similarity (`lib/cluster.js`), write rows
   to the store. Retention: articles older than `RETENTION_DAYS` are pruned.
2. **Store** (`lib/store.js`): articles each carry `cluster_id`; clusters are separate
   rows holding the headline + created_at.
3. **Query** (`lib/stories.js`): `getFeed` selects distinct cluster ids via
   `store.distinctClusterIds` (filters are applied at the store level), then
   `tallyStory` per cluster produces the API shape: headline, image, per-outlet
   sources (one primary + extras), and left/center/right tallies + percentages.
4. **Client** (`client/js/views.js`) fetches `/api/feed` and renders cards
   (`render.js`), managing filter state (`state.js`) and interactions
   (`interactions.js`).

## Key invariants (do not break)

- **Clustering is representative-based**: new articles match against ONE vector per
  existing cluster (the earliest article), never against every member. This prevents
  transitive chaining (a cluster once grew to 143 unrelated articles). Joined articles
  are never added as new candidates; only freshly created clusters get a representative.
- **Bias tally counts unique outlets**, not articles — one outlet publishing many
  versions of the same wire story must not skew the left/center/right bar.
- **`hours` filter** is a cutoff on article publication time (`published_at`, else
  `created_at`); a cluster surfaces when ANY of its articles is inside the window, so
  the card's displayed time is the max publish time across the cluster.
- **Topic precedence**: publisher category tags → feed-declared section → model guess.
  The model only guesses once trained on ≥120 multi-topic docs; until then unlabeled
  headlines are "General".
- **Blindspot rule**: `ratedCount >= BLINDSPOT_MIN_SOURCES (4)` and one side's share
  `<= BLINDSPOT_MAX_SHARE (0.20)`.
- **Privacy/zero-dep**: no external APIs, no AI calls in the default mode, no accounts.
  The optional embedding mode is still local (no paid call).

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `HOST` | 127.0.0.1 | Bind address (`0.0.0.0` for LAN) |
| `CLUSTER_MODE` | `tfidf` | `tfidf` (zero deps) or `embedding` (needs `embed_server.py`) |
| `RETENTION_DAYS` | 7 | Drop articles older than this on ingest |

## API surface

- `GET /api/feed` — stories. Params: `geo`, `topic`, `notopic`, `outlets`, `nooutlet`,
  `ids` (Saved), `hours`, `q`, `sort` (`newest|coverage|lopsided`), `limit`, `offset`.
- `GET /api/filters` — distinct geo/topic/outlet values with counts.
- `GET /api/sources` — full outlet lineup with bias/factuality/owner/geo/logo.
- `GET /api/blindspots` — stories one side of the spectrum ignored.
- `GET /api/my-bias` — reader's lean from click history (per visitor cookie).
- `POST /api/click` — record a read (`{ articleId }`).
- `POST /api/ingest` — trigger an ingest in the background.
- Static: `/`, `/css/*`, `/js/*`, `/sw.js`, `/sw/*`, `/manifest.webmanifest`,
  `/icons/*`, `/logo/*`.

## Where a new feature belongs

- RSS/similarity/topics → `lib/rss.js`, `lib/cluster.js`, `lib/topics.js`.
- Store/query shape → `lib/store.js`, `lib/stories.js`.
- HTTP routes → `app.js` (routes are the only place that knows the URL surface).
- Client rendering/filters → `client/js/render.js`, `client/js/views.js`,
  `client/js/interactions.js`, `client/js/state.js`.
- Styling → split across `client/css/*` by feature (base/feed/sources/mybias/responsive).
- Service worker caching → `client/sw/strategies.js` + `client/sw.js`.

## Conventions

- No new npm dependencies without a compelling reason.
- Keep the classic-script load order in `client/index.html` when adding client files.
- Client files use global functions/state (shared scope) — no modules/bundler.
- Comment style: explain *why* (historical decisions), not *what*.
