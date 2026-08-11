# NewsPop

A local-first news reader that shows you how the same story is covered across
the political spectrum — and where your own blind spots are.

## Features

- **Coverage across the spectrum** — pulls RSS from 57 outlets, from far-left
  to far-right and everywhere in between.
- **Same story, all angles** — automatically groups coverage of the same event
  across different outlets, so you can compare how each side frames it.
- **Bias bar per story** — every story shows a left/center/right breakdown,
  rated from a hand-curated table (55 outlets).
- **Blindspot feed** — surfaces stories one side of the spectrum covered
  heavily while the other barely touched. See what you're missing.
- **My Bias** — learns from which outlets you actually read and shows you your
  own lean over time.
- **Privacy-first** — everything runs on your machine. No AI API calls, no
  subscriptions, no tracking, no accounts. Just your own data file.
- **Zero setup friction** — runs with plain Node.js, no dependencies to
  install, no compiler required.

## Getting started

<a href="https://newspop.odesaplay.com.ua/">Try it out on OdesaPlay</a>

```bash
node app.js
```

Open http://localhost:3000 and start reading.

Optional: for even better story grouping, run the local embedding sidecar —
still fully private, no API key, no cost.

## Tabs

- **Feed** — grouped stories with per-outlet coverage and bias bars.
- **Blindspot** — stories one side of the spectrum ignored.
- **My Bias** — your reading habits, tallied.
- **Saved** — your bookmarks.
- **Sources** — the outlet lineup.