// ---------------------------------------------------------------------------
// Weekly refresh orchestrator
//
// Called by .github/workflows/weekly-refresh.yml every Sunday night.
//
// Flow:
//   1. Figure out the week we're reporting on (previous Mon–Sun window).
//   2. For each platform, call the Apify Actor and get raw data.
//   3. Transform each payload into our normalized shape.
//   4. Load last week's file (if it exists) for WoW comparisons.
//   5. Generate insights per platform + overview.
//   6. Build the full dashboard JSON and write it to data/weeks/YYYY-MM-DD.json
//      plus data/latest.json + data/index.json.
//
// Failure mode: if a single platform's Actor fails, we log + keep going with
// that platform's data from last week. If everything fails, we exit non-zero
// and GitHub Actions notifies Sasha.
// ---------------------------------------------------------------------------

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLATFORMS, WEEKS_TO_KEEP } from "./config.js";
import { fetchPlatform } from "./fetch_apify.js";
import { TRANSFORMERS } from "./transform.js";
import { platformInsights, overviewInsights } from "./insights.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const DATA_DIR   = path.join(__dirname, "..", "data");
const WEEKS_DIR  = path.join(DATA_DIR, "weeks");

const PLATFORM_COLORS = {
  instagram: "#E4405F", facebook: "#1877F2", pinterest: "#E60023", tiktok: "#111", youtube: "#FF0000"
};

// ---------- Week window (previous Mon 00:00 UTC → Sun 23:59 UTC) ----------
function previousWeekWindow(now = new Date()) {
  const d = new Date(now);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon
  const sunOffset = day === 0 ? 7 : day;           // how many days back to last Sunday
  const sunday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sunOffset));
  const monday = new Date(sunday); monday.setUTCDate(sunday.getUTCDate() - 6);
  const iso = x => x.toISOString().slice(0, 10);
  const label = `${monday.toLocaleString("en-US", { month:"short", day:"numeric", timeZone:"UTC" })} – ${sunday.toLocaleString("en-US", { month:"short", day:"numeric", year:"numeric", timeZone:"UTC" })}`;
  return { start: iso(monday), end: iso(sunday), label };
}

// ---------- File helpers ----------
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf-8")); }
  catch { return null; }
}
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
  console.log(`✓ wrote ${path.relative(process.cwd(), file)}`);
}
async function listWeekFiles() {
  try {
    const files = await fs.readdir(WEEKS_DIR);
    return files.filter(f => f.endsWith(".json")).sort().reverse();
  } catch { return []; }
}

// ---------- Main ----------
async function main() {
  if (!process.env.APIFY_TOKEN) {
    console.error("APIFY_TOKEN not set. Aborting.");
    process.exit(1);
  }

  const week = previousWeekWindow();
  console.log(`Refreshing for week: ${week.label}  (${week.start} → ${week.end})`);

  // Load prior week for WoW comparisons
  const priorFiles = await listWeekFiles();
  const priorWeek = priorFiles.length ? await readJson(path.join(WEEKS_DIR, priorFiles[0])) : null;

  // Fetch + transform each platform
  const platformData = {};
  for (const [name, cfg] of Object.entries(PLATFORMS)) {
    try {
      const raw = await fetchPlatform(name, cfg);
      const t = TRANSFORMERS[name](raw, week);
      platformData[name] = t;
      // Carry the follower count forward from last week if THIS run returned null
      // (some actors return posts without profile data in the same call).
      if (platformData[name].profile.followers == null && priorWeek?.[name]?.kpis?.[0]?.value != null) {
        platformData[name].profile.followers = priorWeek[name].kpis[0].value;
      }
      if (t.posts.length === 0) {
        console.warn(`[${name}] scraper returned 0 posts (actor succeeded but yielded no usable items)`);
      }
    } catch (err) {
      console.error(`[${name}] FAILED: ${err.message}`);
      // DO NOT fall back to prior-week posts. That quietly propagates stale
      // (and potentially sample) data forever if a platform keeps failing.
      // Keep last-known follower count for continuity, but leave posts empty
      // so the dashboard surfaces the failure instead of hiding it.
      platformData[name] = {
        profile: {
          followers: priorWeek?.[name]?.kpis?.[0]?.value ?? null,
          postsInWeek: 0
        },
        posts: [],
        _error: err.message || String(err)
      };
    }
  }

  // Build dashboard JSON
  const dashboard = buildDashboard(week, platformData, priorWeek);

  // Write outputs
  const weekFile = path.join(WEEKS_DIR, `${week.end}.json`);
  await writeJson(weekFile, dashboard);
  await writeJson(path.join(DATA_DIR, "latest.json"), dashboard);

  // Rebuild week index (newest first)
  const all = await listWeekFiles();
  const index = all.slice(0, WEEKS_TO_KEEP).map(f => {
    const d = f.replace(".json", "");
    return { file: `data/weeks/${f}`, label: labelForEndDate(d) };
  });
  await writeJson(path.join(DATA_DIR, "index.json"), index);

  console.log("\nRefresh complete.");
}

function labelForEndDate(endIso) {
  const end = new Date(endIso + "T00:00:00Z");
  const start = new Date(end); start.setUTCDate(end.getUTCDate() - 6);
  return `${start.toLocaleString("en-US",{month:"short",day:"numeric",timeZone:"UTC"})} – ${end.toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"})}`;
}

// ---------- Dashboard assembly ----------
function buildDashboard(week, p, prior) {
  // ---- small helpers for week-over-week math ----
  const safePct = (cur, prev) => {
    if (prev == null || prev === 0) return null; // can't compute % growth from 0
    return Number((((cur - prev) / prev) * 100).toFixed(1));
  };
  const priorKpiValueByLabel = (name, label) => {
    const arr = prior?.[name]?.kpis;
    if (!Array.isArray(arr)) return null;
    const hit = arr.find(k => k?.label === label);
    return hit ? (hit.value ?? null) : null;
  };

  const kpiByPlatform = (name) => {
    const pd = p[name];
    const totalLikes     = pd.posts.reduce((s, x) => s + (x.likes || 0), 0);
    const totalComments  = pd.posts.reduce((s, x) => s + (x.comments || 0), 0);
    const totalShares    = pd.posts.reduce((s, x) => s + (x.shares || x.repins || 0), 0);
    const totalViews     = pd.posts.reduce((s, x) => s + (x.views || 0), 0);
    const totalReactions = pd.posts.reduce((s, x) => s + (x.reactions || 0), 0);
    const totalSaves     = pd.posts.reduce((s, x) => s + (x.saves || 0), 0);

    // Build the current-week KPI list per platform. For each card we also look
    // up the same card's value from last week (by label match) so we can show a
    // true WoW absolute delta OR percentage change.
    //   - "follower-style" cards (Followers, Subscribers, Monthly Viewers): absolute +/- delta
    //   - "count" cards (Posts/Videos/Pins This Week): absolute +/- delta
    //   - "engagement aggregate" cards (Likes/Views/Reactions/etc.): percentage delta
    const abs = (label, value) => {
      const prev = priorKpiValueByLabel(name, label);
      const cur = value ?? 0;
      return { label, value, delta: prev == null ? null : cur - prev };
    };
    const pct = (label, value) => {
      const prev = priorKpiValueByLabel(name, label);
      const cur = value ?? 0;
      return { label, value, delta: safePct(cur, prev), deltaSuffix: "%" };
    };

    const KPI_SPECS = {
      instagram: [
        abs("Followers",       pd.profile.followers),
        abs("Posts This Week", pd.profile.postsInWeek),
        pct("Total Likes",     totalLikes),
        pct("Total Comments",  totalComments)
      ],
      facebook: [
        abs("Followers",       pd.profile.followers),
        abs("Posts This Week", pd.profile.postsInWeek),
        pct("Total Reactions", totalReactions),
        pct("Total Shares",    totalShares)
      ],
      pinterest: [
        abs("Monthly Viewers", pd.profile.followers),
        abs("Pins This Week",  pd.profile.postsInWeek),
        pct("Total Saves",     totalSaves),
        pct("Total Comments",  totalComments)
      ],
      tiktok: [
        abs("Followers",       pd.profile.followers),
        abs("Videos Posted",   pd.profile.postsInWeek),
        pct("Total Views",     totalViews),
        pct("Total Likes",     totalLikes)
      ],
      youtube: [
        abs("Subscribers",     pd.profile.followers),
        abs("Videos Posted",   pd.profile.postsInWeek),
        pct("Total Views",     totalViews),
        pct("Total Likes",     totalLikes)
      ]
    };
    return KPI_SPECS[name];
  };

  // Build per-platform objects
  const out = {};
  for (const name of Object.keys(p)) {
    out[name] = {
      kpis: kpiByPlatform(name),
      trend: buildTrend(name, p[name], prior),
      topPosts: p[name].posts,
      insights: platformInsights(name, p[name], prior?.[name] ? reconstructFromDashboard(prior[name]) : null)
    };
  }

  // Overview
  const totalFollowers = Object.values(p).reduce((s, x) => s + (x.profile.followers || 0), 0);
  const totalPosts = Object.values(p).reduce((s, x) => s + x.profile.postsInWeek, 0);
  const totalEng = Object.values(p).reduce((s, x) =>
    s + x.posts.reduce((ss, y) => ss + (y.engagements || y.views || 0), 0), 0);

  // Sum the same three numbers from last week's dashboard so we can build real
  // WoW deltas. Prior dashboards store platforms as top-level keys alongside
  // meta/overview, so only look at keys that are actual platforms.
  const priorPlatforms = prior
    ? Object.fromEntries(Object.entries(prior).filter(([k]) => PLATFORMS[k]))
    : {};
  const priorTotalFollowers = Object.values(priorPlatforms)
    .reduce((s, x) => s + (x?.kpis?.find(k => /followers?|subscribers|viewers/i.test(k?.label || ""))?.value || 0), 0);
  const priorTotalPosts = Object.values(priorPlatforms)
    .reduce((s, x) => s + (x?.kpis?.find(k => /posts? this week|videos? posted|pins? this week/i.test(k?.label || ""))?.value || 0), 0);
  const priorTotalEng = Object.values(priorPlatforms)
    .reduce((s, x) => s + (x?.topPosts || []).reduce((ss, y) => ss + (y.engagements || y.views || 0), 0), 0);

  const followersDelta = priorTotalFollowers ? (totalFollowers - priorTotalFollowers) : null;
  const engagementsDeltaPct = safePct(totalEng, priorTotalEng);
  const postsDelta = priorTotalPosts != null ? (totalPosts - priorTotalPosts) : null;

  const topPlatform = Object.entries(p).map(([n, d]) => ({
    n, eng: d.posts.reduce((s,y)=>s+(y.engagements||y.views||0),0)
  })).sort((a,b)=>b.eng-a.eng)[0]?.n || "—";

  const platformSummary = Object.entries(p).map(([name, d]) => {
    const priorFollowers = prior?.[name]?.kpis?.[0]?.value;
    return {
      name: cap(name),
      followers: d.profile.followers,
      followersDelta: (priorFollowers == null || d.profile.followers == null)
        ? null
        : d.profile.followers - priorFollowers,
      topFormat: (d.posts[0]?.format) || "—",
      note: d.profile.followersNote
    };
  });

  const platformMix = {
    labels: Object.keys(p).map(cap),
    data:   Object.values(p).map(d => d.posts.reduce((s,y)=>s+(y.engagements||y.views||0),0)),
    colors: Object.keys(p).map(n => PLATFORM_COLORS[n])
  };

  // Top 10 posts across all platforms
  const allPosts = Object.entries(p).flatMap(([name, d]) =>
    d.posts.map(post => ({
      title: post.title,
      platform: cap(name),
      date: post.date,
      format: post.format || post.length || "post",
      views: post.views || post.likes || 0,
      engagements: post.engagements || post.likes || 0
    }))
  ).sort((a,b)=>b.engagements-a.engagements).slice(0, 10);

  return {
    meta: {
      week: `${week.start}/${week.end}`,
      weekLabel: week.label,
      generatedAt: new Date().toISOString(),
      source: "apify"
    },
    overview: {
      totals: {
        followers: totalFollowers,
        followersDelta,
        engagements: totalEng,
        engagementsDeltaPct,
        posts: totalPosts,
        postsDelta,
        topPlatform: cap(topPlatform)
      },
      platformSummary,
      platformMix,
      followersHistory: buildFollowersHistory(p, prior),
      topPosts: allPosts,
      insights: overviewInsights(p, prior ? Object.fromEntries(Object.entries(prior).filter(([k])=>PLATFORMS[k])) : null)
    },
    ...out
  };
}

function reconstructFromDashboard(platformBlock) {
  // Convert the prior week's dashboard block back to the {profile, posts} shape
  // used by the insights engine.
  return {
    profile: { followers: platformBlock.kpis?.[0]?.value ?? 0 },
    posts: platformBlock.topPosts || []
  };
}

function buildTrend(name, pd, prior) {
  // Plot last week + this week when we have a prior value. This gives the
  // per-platform follower chart a non-trivial line as soon as we have >=2
  // weeks of data. The chart naturally extends as more history accrues.
  const priorFollowers = prior?.[name]?.kpis?.[0]?.value;
  const curFollowers   = pd.profile.followers ?? priorFollowers ?? 0;
  const haveBoth = priorFollowers != null && pd.profile.followers != null;
  return {
    labels: haveBoth ? ["Last week", "This week"] : ["This week"],
    datasets: [
      { label: "Followers",
        data: haveBoth ? [priorFollowers, curFollowers] : [curFollowers],
        color: PLATFORM_COLORS[name] }
    ]
  };
}

function buildFollowersHistory(p, prior) {
  // Same idea as buildTrend, but one dataset per platform.
  const haveAnyPrior = Object.keys(p).some(name => prior?.[name]?.kpis?.[0]?.value != null);
  const labels = haveAnyPrior ? ["Last week", "This week"] : ["This week"];
  return {
    labels,
    datasets: Object.entries(p).map(([name, d]) => {
      const priorFollowers = prior?.[name]?.kpis?.[0]?.value;
      const curFollowers   = d.profile.followers ?? priorFollowers ?? 0;
      const data = haveAnyPrior
        ? [priorFollowers ?? curFollowers, curFollowers]
        : [curFollowers];
      return {
        label: cap(name),
        data,
        color: PLATFORM_COLORS[name]
      };
    })
  };
}

const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : "";

main().catch(err => {
  console.error("REFRESH FAILED:", err);
  process.exit(1);
});
