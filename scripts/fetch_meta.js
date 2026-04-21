// ---------------------------------------------------------------------------
// Native Meta Graph API client for Instagram + Facebook.
//
// Replaces the Apify path for these two platforms. Requires three env vars:
//   META_IG_TOKEN    — never-expiring Instagram Business Login access token
//   META_PAGE_TOKEN  — never-expiring Facebook Page access token
//   META_PAGE_ID     — numeric Facebook Page ID (e.g. 226239834165267)
//
// Each fetcher returns data already in the {profile, posts, ...extras} shape
// so run_weekly.js can drop them straight in without going through transform.js.
//
// Extras gathered beyond basic profile + posts:
//   - demographics     : age, gender, country, city breakdowns of followers
//   - bestTimeToPost   : derived from historical post engagement by day/hour
//   - followerChurn    : gross gained vs. lost (IG: API-sourced; FB: best effort)
//   - formatPerformance: avg engagement/reach per content format
//   - actionFunnel     : profile views, website clicks, email/phone/text taps
//   - stories          : IG story-by-story insights (last 24h only — cron limit)
//
// Many of the account-level insight endpoints have been heavily restricted by
// Meta in recent Graph API versions. We call each endpoint best-effort: if it
// returns a 400 (deprecated/unavailable), we log a warning and return null for
// that field. The frontend renders "Not available" in those sections rather
// than failing the whole refresh.
// ---------------------------------------------------------------------------

const IG_BASE = "https://graph.instagram.com/v21.0";
const FB_BASE = "https://graph.facebook.com/v21.0";

const IG_TOKEN   = process.env.META_IG_TOKEN;
const PAGE_TOKEN = process.env.META_PAGE_TOKEN;
const PAGE_ID    = process.env.META_PAGE_ID;

// ---------- Low-level HTTP helpers ----------
async function apiGet(baseUrl, pathAndQuery, token, label) {
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const url = `${baseUrl}${pathAndQuery}${sep}access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[${label}] ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
  }
  return res.json();
}
const igGet = (p, label) => apiGet(IG_BASE, p, IG_TOKEN, label);
const fbGet = (p, label) => apiGet(FB_BASE, p, PAGE_TOKEN, label);

// Best-effort wrapper: swallow errors (with warning) and return null.
// Used for endpoints that may be deprecated/unavailable depending on API version.
async function tryGet(fn, label) {
  try { return await fn(); }
  catch (err) {
    console.warn(`[${label}] skipped: ${err.message.split("\n")[0]}`);
    return null;
  }
}

// ---------- Shared helpers ----------
const inWindow = (isoDate, startIso, endIso) => {
  const t = new Date(isoDate).getTime();
  return t >= new Date(startIso).getTime() &&
         t <= new Date(endIso + "T23:59:59Z").getTime();
};
const shortDate = iso => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const firstLine = s => (s || "").split("\n")[0].slice(0, 80);
const toUnix = iso => Math.floor(new Date(iso).getTime() / 1000);

// Flatten an IG insights `data` array ([{name, values:[{value}]}, ...]) into {name: value}.
function flattenInsights(insightsResp) {
  const flat = {};
  for (const m of insightsResp?.data || []) {
    flat[m.name] = m.values?.[0]?.value ?? 0;
  }
  return flat;
}

// Normalize a "breakdowns" style insight response — used for follower_demographics.
// Returns {age: [{label, value}], gender: [...], country: [...], city: [...]}
function normalizeBreakdowns(insightsResp) {
  const result = { age: [], gender: [], country: [], city: [] };
  if (!insightsResp?.data) return result;

  for (const metric of insightsResp.data) {
    const breakdowns = metric.total_value?.breakdowns || [];
    for (const b of breakdowns) {
      const dims = b.dimension_keys || [];
      const results = b.results || [];
      for (const r of results) {
        const labels = r.dimension_values || [];
        const value = r.value ?? 0;
        // dimension_keys tell us what each value means (e.g. ["age", "gender"])
        if (dims.length === 1 && labels.length === 1) {
          const key = dims[0]; // "age", "gender", "country", "city"
          if (result[key]) result[key].push({ label: labels[0], value });
        } else if (dims.includes("age") && dims.includes("gender")) {
          // combined age+gender breakdown — normalize into age only for display
          const ageIdx = dims.indexOf("age");
          const genderIdx = dims.indexOf("gender");
          const ageLabel = labels[ageIdx];
          const genderLabel = labels[genderIdx];
          result.age.push({ label: ageLabel, gender: genderLabel, value });
        }
      }
    }
  }
  // Collapse duplicate age rows (when split by gender) into totals
  const ageTotals = {};
  for (const r of result.age) {
    ageTotals[r.label] = (ageTotals[r.label] || 0) + r.value;
  }
  result.ageTotals = Object.entries(ageTotals)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // Trim country / city to top 10
  result.country = result.country.sort((a, b) => b.value - a.value).slice(0, 10);
  result.city    = result.city.sort((a, b) => b.value - a.value).slice(0, 10);
  return result;
}

// ---------- Best-time-to-post (derived from historical engagement) ----------
//
// Meta's `online_followers` endpoint was deprecated in v21. Instead, we compute
// the best time from the engagement of posts over the last 50 (the same media
// set we already fetched). We bucket by weekday and local hour (UTC for now —
// we'll convert to CT on the frontend), compute avg engagement per bucket, and
// return the top bucket plus a 24x7 heatmap for the frontend.
//
// Minimum threshold: need at least 10 posts to have any signal. Below that, we
// return null and the frontend shows "Not enough post history yet".
const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function computeBestTimes(posts) {
  if (!posts || posts.length < 10) return null;

  // bucket[day][hour] = {count, totalEng}
  const bucket = Array.from({length: 7}, () =>
    Array.from({length: 24}, () => ({count: 0, totalEng: 0}))
  );

  for (const p of posts) {
    const ts = p.timestamp || p.created_time;
    if (!ts) continue;
    const d = new Date(ts);
    const day = d.getUTCDay();
    const hour = d.getUTCHours();
    const eng = (p.like_count ?? 0) + (p.comments_count ?? 0) +
                (p.reactions?.summary?.total_count ?? 0) +
                (p.comments?.summary?.total_count ?? 0) +
                (p.shares?.count ?? 0);
    bucket[day][hour].count += 1;
    bucket[day][hour].totalEng += eng;
  }

  // Flatten to {day, hour, avgEng} and find the best
  const flat = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const b = bucket[d][h];
      if (b.count > 0) {
        flat.push({
          day: DAY_NAMES[d],
          dayIndex: d,
          hour: h,
          avgEng: b.totalEng / b.count,
          postCount: b.count
        });
      }
    }
  }

  if (flat.length === 0) return null;
  const top = flat.sort((a, b) => b.avgEng - a.avgEng)[0];

  // Build 7x24 heatmap grid for the frontend (null for empty cells)
  const heatmap = bucket.map(row => row.map(b => b.count ? Math.round(b.totalEng / b.count) : null));

  return {
    topDay: top.day,
    topHour: top.hour,              // UTC hour; frontend converts to CT
    topAvgEng: Math.round(top.avgEng),
    heatmap,
    heatmapDays: DAY_NAMES,
    sampleSize: posts.length,
    note: "Best time computed from historical post engagement (UTC hours; frontend converts to CT)."
  };
}

// ---------- Format performance breakdown ----------
//
// Groups the week's posts by format (Reel / Carousel / Image for IG; Video /
// Photo / Link / Status for FB) and computes avg engagement + avg reach.
// Powers the "what format should I make more of" insight.
function computeFormatPerformance(posts) {
  if (!posts || posts.length === 0) return [];
  const by = {};
  for (const p of posts) {
    const f = p.format || "Post";
    if (!by[f]) by[f] = { format: f, count: 0, totalEng: 0, totalReach: 0, totalViews: 0 };
    by[f].count += 1;
    by[f].totalEng   += p.engagements || 0;
    by[f].totalReach += p.reach       || 0;
    by[f].totalViews += p.views       || 0;
  }
  return Object.values(by).map(g => ({
    format: g.format,
    count: g.count,
    avgEngagement: Math.round(g.totalEng   / g.count),
    avgReach:      Math.round(g.totalReach / g.count),
    avgViews:      Math.round(g.totalViews / g.count)
  })).sort((a, b) => b.avgEngagement - a.avgEngagement);
}

// ---------- Instagram ----------
export async function fetchInstagram(week) {
  if (!IG_TOKEN) throw new Error("META_IG_TOKEN not set");

  // 1) account
  const me = await igGet(
    "/me?fields=id,username,name,followers_count,media_count",
    "ig/me"
  );

  // 2) recent media (50 most recent; week filter applied after, but full set
  //    feeds the best-time-to-post analysis which needs more history)
  const mediaResp = await igGet(
    "/me/media?fields=id,caption,media_type,timestamp,permalink,like_count,comments_count&limit=50",
    "ig/media"
  );
  const allMedia = mediaResp.data || [];
  const inWeek = allMedia.filter(p => inWindow(p.timestamp, week.start, week.end));

  // 3) per-post insights — best-effort. plays→views fix for Reels.
  const enrichedInWeek = await Promise.all(inWeek.map(async p => {
    const isVideo = p.media_type === "VIDEO" || p.media_type === "REELS";
    // Reels use `views` (plays was deprecated). Other media use `views` + `reach`.
    // total_interactions is available on reels post v21 and gives us shares too.
    const metric = isVideo
      ? "views,reach,saved,shares,total_interactions"
      : "views,reach,saved,shares";
    try {
      const ins = await igGet(`/${p.id}/insights?metric=${metric}`, `ig/insights/${p.id}`);
      return { ...p, _insights: flattenInsights(ins) };
    } catch (err) {
      console.warn(`[ig] insights miss for ${p.id}: ${err.message.split("\n")[0]}`);
      return { ...p, _insights: {} };
    }
  }));

  const posts = enrichedInWeek.map(p => {
    const saves   = p._insights.saved ?? 0;
    const reach   = p._insights.reach ?? 0;
    const views   = p._insights.views ?? 0;
    const apiShares = p._insights.shares ?? 0;
    const likes   = p.like_count ?? 0;
    const cmts    = p.comments_count ?? 0;
    return {
      title: firstLine(p.caption) || "(no caption)",
      date: shortDate(p.timestamp),
      format: p.media_type === "VIDEO" || p.media_type === "REELS" ? "Reel"
            : p.media_type === "CAROUSEL_ALBUM" ? "Carousel"
            : "Image",
      likes,
      comments: cmts,
      shares: apiShares,
      saves,
      views,
      reach,
      engagements: likes + cmts + saves + apiShares
    };
  }).sort((a, b) => b.engagements - a.engagements);

  // 4) Account-level insights for the reporting window (best-effort)
  const since = toUnix(week.start);
  const until = toUnix(week.end + "T23:59:59Z");

  // Demographics (lifetime). The follower_demographics metric replaced the old
  // audience_gender_age, audience_country, etc. metrics in v18+.
  const demographicsByDim = await Promise.all([
    tryGet(() => igGet(
      `/me/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=age`,
      "ig/demographics/age"), "ig/demographics/age"),
    tryGet(() => igGet(
      `/me/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=gender`,
      "ig/demographics/gender"), "ig/demographics/gender"),
    tryGet(() => igGet(
      `/me/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=country`,
      "ig/demographics/country"), "ig/demographics/country"),
    tryGet(() => igGet(
      `/me/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=city`,
      "ig/demographics/city"), "ig/demographics/city")
  ]);
  const demographics = {
    age:     normalizeBreakdowns(demographicsByDim[0]).age,
    gender:  normalizeBreakdowns(demographicsByDim[1]).gender,
    country: normalizeBreakdowns(demographicsByDim[2]).country,
    city:    normalizeBreakdowns(demographicsByDim[3]).city
  };
  const hasAnyDemographics = demographics.age.length + demographics.gender.length +
                              demographics.country.length + demographics.city.length > 0;

  // Follower churn — follows_and_unfollows (day period, sum the week)
  const follows = await tryGet(() => igGet(
    `/me/insights?metric=follows_and_unfollows&period=day&metric_type=total_value&since=${since}&until=${until}`,
    "ig/follows"), "ig/follows");
  const followFlat = flattenInsights(follows);
  const followerChurn = (follows == null) ? null : {
    gained: followFlat.follows ?? null,
    lost:   followFlat.unfollows ?? null,
    net:    (followFlat.follows ?? 0) - (followFlat.unfollows ?? 0)
  };

  // Action funnel — profile views, website clicks, link taps
  const [profileViewsR, websiteClicksR, linkTapsR] = await Promise.all([
    tryGet(() => igGet(
      `/me/insights?metric=profile_views&period=day&metric_type=total_value&since=${since}&until=${until}`,
      "ig/profile-views"), "ig/profile-views"),
    tryGet(() => igGet(
      `/me/insights?metric=website_clicks&period=day&metric_type=total_value&since=${since}&until=${until}`,
      "ig/website-clicks"), "ig/website-clicks"),
    tryGet(() => igGet(
      `/me/insights?metric=profile_links_taps&period=day&metric_type=total_value&since=${since}&until=${until}`,
      "ig/profile-links"), "ig/profile-links")
  ]);
  const actionFunnel = {
    profileViews:  flattenInsights(profileViewsR).profile_views  ?? null,
    websiteClicks: flattenInsights(websiteClicksR).website_clicks ?? null,
    linkTaps:      flattenInsights(linkTapsR).profile_links_taps  ?? null
  };

  // 5) IG Stories (last 24h only — Meta hides insights after story expires)
  const storiesResp = await tryGet(() => igGet(
    "/me/stories?fields=id,media_type,timestamp,permalink",
    "ig/stories"), "ig/stories");
  const storiesRaw = storiesResp?.data || [];
  const stories = await Promise.all(storiesRaw.map(async s => {
    const ins = await tryGet(() => igGet(
      `/${s.id}/insights?metric=views,reach,replies,taps_forward,taps_back,exits`,
      `ig/story/${s.id}`), `ig/story/${s.id}`);
    const flat = flattenInsights(ins);
    return {
      id: s.id,
      date: shortDate(s.timestamp),
      mediaType: s.media_type,
      views:        flat.views        ?? null,
      reach:        flat.reach        ?? null,
      replies:      flat.replies      ?? null,
      tapsForward:  flat.taps_forward ?? null,
      tapsBack:     flat.taps_back    ?? null,
      exits:        flat.exits        ?? null
    };
  }));

  // 6) Computed from existing data (no additional API calls needed)
  const formatPerformance = computeFormatPerformance(posts);
  const bestTimeToPost    = computeBestTimes(allMedia);

  return {
    profile: {
      followers: me.followers_count ?? null,
      postsInWeek: posts.length,
      username: me.username
    },
    posts: posts.slice(0, 8),
    demographics: hasAnyDemographics ? demographics : null,
    followerChurn,
    actionFunnel,
    formatPerformance,
    bestTimeToPost,
    stories: {
      count: stories.length,
      note: stories.length === 0
        ? "No active stories at time of refresh. Only stories posted in the last 24h are visible to the API."
        : "Stories listed here were active at the time of the weekly refresh; older stories of the week aren't visible to the API.",
      items: stories
    }
  };
}

// ---------- Facebook ----------
export async function fetchFacebook(week) {
  if (!PAGE_TOKEN) throw new Error("META_PAGE_TOKEN not set");
  if (!PAGE_ID) throw new Error("META_PAGE_ID not set");

  // 1) page profile
  const page = await fbGet(
    `/${PAGE_ID}?fields=id,name,followers_count,fan_count`,
    "fb/page"
  );

  // 2) posts from this-week window (unix seconds) — pull more fields than before:
  //    - attachments lets us classify format (photo, video, link, status)
  //    - reactions broken down by type (like/love/haha/wow/sad/angry)
  const since = toUnix(week.start);
  const until = toUnix(week.end + "T23:59:59Z");
  // For best-time-to-post, grab 6 weeks of history (not just this week).
  const historySince = toUnix(week.start + "T00:00:00Z") - 6 * 7 * 24 * 60 * 60;

  const [postsResp, historyResp] = await Promise.all([
    fbGet(
      `/${PAGE_ID}/posts?fields=id,message,story,created_time,permalink_url,attachments{media_type,type},` +
      `reactions.type(LIKE).summary(true).limit(0).as(r_like),` +
      `reactions.type(LOVE).summary(true).limit(0).as(r_love),` +
      `reactions.type(HAHA).summary(true).limit(0).as(r_haha),` +
      `reactions.type(WOW).summary(true).limit(0).as(r_wow),` +
      `reactions.type(SAD).summary(true).limit(0).as(r_sad),` +
      `reactions.type(ANGRY).summary(true).limit(0).as(r_angry),` +
      `reactions.summary(true),comments.summary(true),shares&since=${since}&until=${until}&limit=100`,
      "fb/posts"
    ),
    fbGet(
      `/${PAGE_ID}/posts?fields=id,created_time,reactions.summary(true),comments.summary(true),shares` +
      `&since=${historySince}&until=${until}&limit=100`,
      "fb/history"
    ).catch(() => ({ data: [] }))
  ]);

  const rawPosts = postsResp.data || [];
  const historyPosts = historyResp.data || [];

  const posts = rawPosts.map(p => {
    const reactions = p.reactions?.summary?.total_count ?? 0;
    const comments  = p.comments?.summary?.total_count ?? 0;
    const shares    = p.shares?.count ?? 0;

    // Classify format from attachments
    const att = p.attachments?.data?.[0];
    const rawType = att?.media_type || att?.type || "status";
    const format = rawType.includes("video") ? "Video"
                 : rawType.includes("photo") || rawType === "album" ? "Photo"
                 : rawType === "share" || rawType === "link" ? "Link"
                 : "Status";

    return {
      title: firstLine(p.message || p.story) || "(no text)",
      date: shortDate(p.created_time),
      format,
      reactions,
      comments,
      shares,
      reactionBreakdown: {
        like:  p.r_like?.summary?.total_count  ?? 0,
        love:  p.r_love?.summary?.total_count  ?? 0,
        haha:  p.r_haha?.summary?.total_count  ?? 0,
        wow:   p.r_wow?.summary?.total_count   ?? 0,
        sad:   p.r_sad?.summary?.total_count   ?? 0,
        angry: p.r_angry?.summary?.total_count ?? 0
      },
      engagements: reactions + comments + shares
    };
  }).sort((a, b) => b.engagements - a.engagements);

  // 3) Page-level insights (best-effort — most demographic metrics deprecated post v18)
  // page_follows gives new followers but not unfollows.
  const pageFollows = await tryGet(() => fbGet(
    `/${PAGE_ID}/insights?metric=page_follows&period=day&since=${since}&until=${until}`,
    "fb/page-follows"), "fb/page-follows");
  const pageFollowsValue = pageFollows?.data?.[0]?.values?.reduce((s, v) => s + (v.value || 0), 0) ?? null;

  const pageViews = await tryGet(() => fbGet(
    `/${PAGE_ID}/insights?metric=page_views_total&period=day&since=${since}&until=${until}`,
    "fb/page-views"), "fb/page-views");
  const pageViewsValue = pageViews?.data?.[0]?.values?.reduce((s, v) => s + (v.value || 0), 0) ?? null;

  const pageCtaClicks = await tryGet(() => fbGet(
    `/${PAGE_ID}/insights?metric=page_total_actions&period=day&since=${since}&until=${until}`,
    "fb/page-cta"), "fb/page-cta");
  const pageCtaValue = pageCtaClicks?.data?.[0]?.values?.reduce((s, v) => s + (v.value || 0), 0) ?? null;

  // 4) Computed from existing data
  const formatPerformance = computeFormatPerformance(posts);
  const bestTimeToPost    = computeBestTimes(historyPosts);

  // 5) Aggregate reaction breakdown for the week
  const weekReactions = posts.reduce((acc, p) => {
    for (const k of Object.keys(p.reactionBreakdown || {})) {
      acc[k] = (acc[k] || 0) + p.reactionBreakdown[k];
    }
    return acc;
  }, {});

  return {
    profile: {
      followers: page.followers_count ?? page.fan_count ?? null,
      postsInWeek: posts.length
    },
    posts: posts.slice(0, 8),
    demographics: null,  // Meta deprecated Page demographic metrics in v18+
    demographicsNote: "Facebook Page demographic data was retired by Meta in 2024 (Graph API v18+). Instagram demographics above are a reasonable proxy for your overall Meta audience.",
    followerChurn: pageFollowsValue == null ? null : {
      gained: pageFollowsValue,
      lost: null,
      lostNote: "Facebook doesn't expose unfollow counts via the Graph API. We report gains only.",
      net: pageFollowsValue
    },
    actionFunnel: {
      pageViews:  pageViewsValue,
      ctaClicks:  pageCtaValue,
      note: "Facebook Page view / CTA click data may be unavailable if your Page hasn't enabled Professional Dashboard analytics."
    },
    formatPerformance,
    bestTimeToPost,
    reactionBreakdown: weekReactions
  };
}

// Map keyed by platform name for easy dispatch from run_weekly.js
export const META_FETCHERS = {
  instagram: fetchInstagram,
  facebook:  fetchFacebook
};
