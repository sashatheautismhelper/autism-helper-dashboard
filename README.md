# The Autism Helper — Social Media Dashboard

Weekly social media analytics and strategy insights for Instagram, Facebook, Pinterest, TikTok, and YouTube.

**Live at:** https://dashboard.theautismhelper.com

---

## What this is

A static website hosted on GitHub Pages that displays weekly social media KPIs and auto-generated strategy insights for [@theautismhelper](https://www.theautismhelper.com). Every Sunday night, a GitHub Action pulls fresh data from Apify, regenerates the dashboard's JSON, and commits it back to this repo — which triggers a redeploy of the site. By Monday morning, the dashboard shows last week's numbers.

## How it works

```
┌────────────────┐        ┌───────────────────┐        ┌───────────────┐
│ Sunday 11 PM   │───────▶│  GitHub Action    │───────▶│   Apify API   │
│   cron trigger │        │  (scripts/*.js)   │        │   (5 Actors)  │
└────────────────┘        └─────────┬─────────┘        └───────┬───────┘
                                    │                          │
                                    ▼                          ▼
                          ┌───────────────────┐      ┌──────────────────┐
                          │  transform.js     │◀─────┤  raw JSON data   │
                          │  insights.js      │      └──────────────────┘
                          └─────────┬─────────┘
                                    ▼
                          ┌───────────────────┐
                          │  data/*.json      │
                          │  (committed)      │
                          └─────────┬─────────┘
                                    ▼
                          ┌───────────────────┐
                          │  GitHub Pages     │
                          │  redeploys site   │
                          └───────────────────┘
```

## Repository layout

```
.
├── index.html              # the dashboard (static, loads JSON at runtime)
├── CNAME                   # custom domain: dashboard.theautismhelper.com
├── assets/
│   └── TAH-Logo-H.png      # brand logo
├── data/
│   ├── latest.json         # most recent week (also linked from the page)
│   ├── index.json          # list of available weeks for the picker
│   └── weeks/
│       └── YYYY-MM-DD.json # one file per week (end date = Sunday)
├── scripts/
│   ├── config.js           # which Apify Actors to call, with what inputs
│   ├── fetch_apify.js      # thin Apify API wrapper
│   ├── transform.js        # per-platform normalization
│   ├── insights.js         # rule-based insights generator
│   ├── run_weekly.js       # orchestrator (entry point)
│   └── package.json
└── .github/workflows/
    └── weekly-refresh.yml  # Sunday-night schedule
```

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full first-time setup walkthrough (GitHub repo + Pages + DNS + Apify token).

## Making changes

**Change a Sunday job's timing:** edit the `cron` line in `.github/workflows/weekly-refresh.yml`.

**Change the copy on an insight rule:** edit `scripts/insights.js`. Rules are deliberately simple and tunable.

**Add a new platform:** add a new entry to `PLATFORMS` in `scripts/config.js`, add a transformer in `scripts/transform.js`, add a platform entry in `PLATFORM_OPTS` in `index.html`, and add a new tab in the nav.

**Manually trigger a refresh:** go to the **Actions** tab → "Weekly data refresh" → "Run workflow".

**Edit the look:** `index.html` has a single `<style>` block at the top. The `:root` block holds the brand color tokens.

## Cost

Ongoing: roughly $15–20 per month on Apify's starter plan. Hosting is free.
