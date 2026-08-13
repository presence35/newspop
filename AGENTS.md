# NewsPop — agent instructions

Read **ARCHITECTURE.md** before touching code — it maps every module, the data
flow, and the invariants you must not break.

## Trigger phrase: "release it"

When the user says **"release it"**, deploy the current code to the server
without touching git or versions:

1. Run `node scripts/deploy.mjs` (FTP upload of the app file set via curl).
   Credentials live in `deploy.properties` (git-ignored). Use `--dry-run` to
   preview the file list first.
2. Report per-file results. The user handles `git commit` and the service
   restart themselves.

## Conventions

- Plain Node ESM, zero dependencies, no build step, no compiler.
- Server code in `lib/` (entry: `app.js`). Client code in `client/`.
- JSON-backed store (`lib/store.js`) — never introduce SQLite.
- `CLUSTER_MODE` env: `tfidf` (default) | `embedding` (needs `embed_server.py`).
- Privacy-first: no external APIs, no accounts; data stays local.
- Client is classic scripts sharing one global scope — preserve the load order
  in `client/index.html`.

## When adding a feature

1. Find the owning module in ARCHITECTURE.md and put the change there — no
   parallel systems.
2. No new npm dependencies without a compelling reason.
3. Run `node --check` on changed files; boot `node app.js` and smoke-test the
   affected routes before finishing.
