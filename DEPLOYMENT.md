# Deployment guide — first-time setup

Follow these steps in order. Takes about 30–45 minutes end to end, not counting DNS propagation time.

---

## Step 1 — Create the GitHub repository

1. Sign in to [github.com](https://github.com).
2. Click the green **New** button to create a repository.
3. Name it something like `autism-helper-dashboard` (or anything — the name only shows up in admin areas, not on the public site).
4. Set it to **Public** (required for free GitHub Pages hosting).
5. Do **not** initialize with a README, .gitignore, or license — we already have those files.

## Step 2 — Upload the project files

**Option A (easiest, no command line):**
1. On the new empty repo's page, click **uploading an existing file**.
2. Drag every file and folder from this project into the upload area.
3. Make sure the folder structure stays intact (`index.html` at the root, `scripts/` as a subfolder, `.github/workflows/` as a subfolder, etc.).
4. Scroll down, write a commit message like "initial commit", click **Commit changes**.

**Option B (using Git on the command line):**
```bash
cd <path-to-this-folder>
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/<YOUR-USERNAME>/autism-helper-dashboard.git
git push -u origin main
```

## Step 3 — Get your Apify API token

1. Sign in to [apify.com](https://apify.com).
2. Go to **Settings** → **Integrations** → **API & Integrations**.
3. Copy the **Personal API token**. Treat this like a password.

## Step 4 — Add the token to GitHub as a secret

1. In your new GitHub repo, click **Settings** → **Secrets and variables** → **Actions**.
2. Click **New repository secret**.
3. Name: `APIFY_TOKEN`. Value: paste the token from step 3. Click **Add secret**.

> 🔒 The token will never be visible in code, logs, or commits. GitHub injects it into the refresh job at runtime.

## Step 5 — Confirm Apify Actors (one-time)

Open `scripts/config.js`. There are five placeholder Actor IDs — one per platform. During build week 1, swap each for the current best-maintained Actor on Apify's marketplace by:

1. Going to [Apify Store](https://apify.com/store).
2. Searching for "instagram scraper" (or the relevant platform).
3. Picking one with strong ratings and a Freemium/Starter pricing tier.
4. Opening its page, copying its ID from the URL (e.g., `apify/instagram-scraper`).
5. Pasting that ID into `config.js`.

Do a test run after each one by going to **Actions** → **Weekly data refresh** → **Run workflow**. Check the logs for errors, and adjust Actor inputs if needed.

## Step 6 — Enable GitHub Pages

1. In the repo, go to **Settings** → **Pages**.
2. Source: **Deploy from a branch**. Branch: `main`, folder: `/ (root)`. Click **Save**.
3. Wait a minute or two. GitHub will show you a preview URL like `https://<YOUR-USERNAME>.github.io/autism-helper-dashboard/`.

## Step 7 — Set up the custom domain (`dashboard.theautismhelper.com`)

### 7a. Confirm the CNAME file

The repo already includes a `CNAME` file at the root with `dashboard.theautismhelper.com`. That file tells GitHub Pages which custom domain to accept. Leave it in place.

### 7b. Add a DNS record at your domain registrar

Log in to wherever `theautismhelper.com` is registered (GoDaddy, Namecheap, Cloudflare, etc.) and find the DNS management section. Add a new record with:

| Field | Value |
|---|---|
| Type | `CNAME` |
| Host / Name | `dashboard` |
| Target / Value | `<YOUR-GITHUB-USERNAME>.github.io` *(exactly that — no `https://`, no trailing path)* |
| TTL | Default (or 300 seconds if you want faster updates) |

Save. DNS typically propagates in 5–30 minutes, though it can take up to a few hours.

### 7c. Tell GitHub Pages about the custom domain

1. Back in the repo's **Settings** → **Pages**.
2. In the "Custom domain" field, enter `dashboard.theautismhelper.com` and click **Save**.
3. Wait for GitHub's DNS check to go green (refresh the page if needed).
4. Once green, check the **Enforce HTTPS** box.

In 5–15 minutes, `https://dashboard.theautismhelper.com` will load the dashboard.

## Step 8 — Kick off the first refresh

1. Go to **Actions** → **Weekly data refresh**.
2. Click **Run workflow** (dropdown on the right) → **Run workflow**.
3. Watch the logs. If everything's wired up correctly, you'll see a new commit show up within 2–5 minutes with that week's JSON files.
4. Refresh `https://dashboard.theautismhelper.com` to see real data.

The job will then run automatically every Sunday at 11 PM Central going forward.

---

## Troubleshooting

**The site loads but says "Unable to load dashboard data":** likely a missing or malformed `data/latest.json`. Check the most recent commit from the bot — did the refresh run succeed? If not, read the Action's log.

**An Actor is erroring out:** some Apify Actors occasionally break when platforms change their HTML. Switch to a different Actor in `config.js` and re-run.

**Custom domain isn't resolving:** DNS can take a few hours. Use [whatsmydns.net](https://www.whatsmydns.net/) to check propagation. Make sure the CNAME value is exactly `<username>.github.io` (no path).

**The dashboard shows sample data after the refresh:** the data files in `/data/` include sample data so the site works before the first real refresh. Once the Sunday job runs, sample data gets overwritten. You can also delete `data/weeks/2026-04-13.json` and `data/latest.json` and `data/index.json` if you want them gone immediately.

**I want to trigger a refresh more often than weekly:** edit the `cron` line in `.github/workflows/weekly-refresh.yml`. Be aware: more frequent runs = more Apify usage = higher bill. Also consider whether the platforms will notice repeated scraping and rate-limit.

**Something else:** check the repo's **Issues** tab — failed refreshes auto-create an issue with a link to the failing log.
