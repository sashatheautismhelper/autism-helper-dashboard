// ---------------------------------------------------------------------------
// Native YouTube client — Data API v3 + Analytics API v2.
//
// Replaces the Apify path for YouTube. Requires four env vars:
//   YT_API_KEY          — Google Cloud API key restricted to YouTube Data API v3
//   YT_CLIENT_ID        — OAuth 2.0 client ID (web app)
//   YT_CLIENT_SECRET    — OAuth 2.0 client secret
//   YT_REFRESH_TOKEN    — Long-lived refresh token for the channel owner
//
// Tier 1 (Data API v3, public):
//   - Channel stats (subscribers, video count, view count)
//   - Per-video snippet + statistics + contentDetails
//   - Short vs. Long-form classification (via duration)
//
// Tier 2 (Analytics API v2, OAuth, channel owner only):
//   - Watch time + average view duration per video
//   - Audience demographics (age × gender, country)
//   - Traffic sources (search / suggested / browse / external)
//   - Subscribers gained / lost per video
//   - Retention (audience retention by relative elapsed time) — summarized
//
// Tier 2 endpoints are best-effort: if a call fails (scope missing, API disabled,
// etc.) we log a warning and omit the field. The frontend renders "Not available"
// in those sections rather than failing the whole refresh.
//
// Quota math: ~3 Data API units + ~5 Analytics API queries per refresh. Daily
// free quota is 10,000 Data units + 200 Analytics queries/day/project, so we
// have plenty of headroom.
// ---------------------------------------------------------------------------

const YT_DATA_BASE      = "https://www.googleapis.com/youtube/v3";
const YT_ANALYTICS_BASE = "https://youtubeanalytics.googleapis.com/v2";
const YT_TOKEN_URL      = "https://oauth2.googleapis.com/token";
const YT_HANDLE         = "@theautismhelper";

// ---------- OAuth: refresh → access token ----------
//
// Exchanges the long-lived refresh token for a short-lived (1h) access token.
// Called once per refresh run and memoized for the process lifetime.
let _accessToken = null;
async function getAccessToken() {
  if (_accessToken) return _accessToken;
  if (!process.env.YT_CLIENT_ID || !process.env.YT_CLIENT_SECRET || !process.env.YT_REFRESH_TOKEN) {
    throw new Error("YT_CLIENT_ID, YT_CLIENT_SECRET, and YT_REFRESH_TOKEN must all be set");
  }
  const body = new URLSearchParams({
    client_id:     process.env.YT_CLIENT_ID,
    client_secret: process.env.YT_CLIENT_SECRET,
    refresh_token: process.env.YT_REFRESH_TOKEN,
    grant_type:    "refresh_token"
  });
  const res = await fetch(YT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OAuth refresh failed: ${res.status} — ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  _accessToken = data.access_token;
  return _accessToken;
}

// ---------- Low-level HTTP helpers ----------
async function dataGet(pathAndQuery, label) {
  if (!process.env.YT_API_KEY) throw new Error("YT_API_KEY env var is not set");
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const url = `${YT_DATA_BASE}${pathAndQuery}${sep}key=${encodeURIComponent(process.env.YT_API_KEY)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[${label}] ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function analyticsGet(pathAndQuery, label) {
  const token = await getAccessToken();
  const url = `${YT_ANALYTICS_BASE}${pathAndQuery}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[${label}] ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Best-effort wrapper — swallow errors and return null so one broken Analytics
// call doesn't nuke the whole refresh.
async function tryGet(fn, label) {
  try { return await fn(); }
  catch (err) {
    console.warn(`[${label}] skipped: ${err.message.split("\n")[0]}`);
    return null;
  }
}

// ---------- Helpers ----------
const inWindow = (iso, startIso, endIso) => {
  const t = new Date(iso).getTime();
  return t >= new Date(startIso).getTime() &&
         t <= new Date(endIso + "T23:59:59Z").getTime();
};

function parseDurationSec(iso) {
  if (!iso) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  const [, h, mm, s] = m;
  return (parseInt(h || 0, 10) * 3600) +
         (parseInt(mm || 0, 10) * 60) +
         parseInt(s || 0, 10);
}
function classifyFormat(durationSec) {
  if (durationSec == null) return "Video";
  return durationSec <= 60 ? "Short" : "Video";
}
function formatDurationHuman(durationSec) {
  if (durationSec == null) return "—";
  const h = Math.floor(durationSec / 3600);
  const m = Math.floor((durationSec % 3600) / 60);
  const s = durationSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  return `${m}:${String(s).padStart(2,"0")}`;
}

const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function computeBestTimes(videos) {
  if (!videos || videos.length < 10) return null;
  const bucket = Array.from({length: 7}, () =>
    Array.from({length: 24}, () => ({count: 0, totalEng: 0}))
  );
  for (const v of videos) {
    const ts = v.snippet?.publishedAt;
    if (!ts) continue;
    const d = new Date(ts);
    const day  = d.getUTCDay();
    const hour = d.getUTCHours();
    const st   = v.statistics || {};
    const eng  = parseInt(st.likeCount || 0, 10) + parseInt(st.commentCount || 0, 10);
    bucket[day][hour].count += 1;
    bucket[day][hour].totalEng += eng;
  }
  const flat = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const b = bucket[d][h];
      if (b.count > 0) {
        flat.push({ day: DAY_NAMES[d], dayIndex: d, hour: h,
                    avgEng: b.totalEng / b.count, postCount: b.count });
      }
    }
  }
  if (flat.length === 0) return null;
  const top = flat.sort((a, b) => b.avgEng - a.avgEng)[0];
  const heatmap = bucket.map(row => row.map(b => b.count ? Math.round(b.totalEng / b.count) : null));
  return {
    topDay: top.day,
    topHour: top.hour,
    topAvgEng: Math.round(top.avgEng),
    heatmap,
    heatmapDays: DAY_NAMES,
    sampleSize: videos.length,
    note: "Best time computed from historical video engagement (UTC hours; frontend converts to CT)."
  };
}

function computeFormatPerformance(posts) {
  if (!posts || posts.length === 0) return [];
  const by = {};
  for (const p of posts) {
    const f = p.format || "Video";
    if (!by[f]) by[f] = { format: f, count: 0, totalEng: 0, totalViews: 0, totalWatchMin: 0, withWatchMin: 0 };
    by[f].count     += 1;
    by[f].totalEng  += (p.engagements || 0);
    by[f].totalViews+= (p.views || 0);
    if (p.watchTimeMinutes != null) {
      by[f].totalWatchMin += p.watchTimeMinutes;
      by[f].withWatchMin  += 1;
    }
  }
  return Object.values(by).map(x => ({
    format: x.format,
    count: x.count,
    // Use the same field name as fetch_meta so the frontend card renders uniformly.
    avgEngagement:   Math.round(x.totalEng / x.count),
    // Use avgReach as an alias for avgViews — that's what the card displays as the
    // secondary metric, so filling it with views keeps the UI consistent.
    avgReach:        Math.round(x.totalViews / x.count),
    avgViews:        Math.round(x.totalViews / x.count),
    avgWatchMinutes: x.withWatchMin
      ? Math.round((x.totalWatchMin / x.withWatchMin) * 10) / 10
      : null
  })).sort((a, b) => b.avgEngagement - a.avgEngagement);
}

// ---------- Data API v3 calls ----------
async function fetchVideoStats(videoIds) {
  if (!videoIds.length) return [];
  const chunks = [];
  for (let i = 0; i < videoIds.length; i += 50) chunks.push(videoIds.slice(i, i + 50));
  const all = [];
  for (const chunk of chunks) {
    const qs = `id=${chunk.join(",")}&part=snippet,statistics,contentDetails`;
    const resp = await dataGet(`/videos?${qs}`, "videos.list");
    all.push(...(resp.items || []));
  }
  return all;
}

// ---------- Analytics API v2 calls ----------
//
// Channel-level day-by-day metrics across the window.
async function fetchChannelTimeseries(week) {
  const qs = new URLSearchParams({
    ids: "channel==MINE",
    startDate: week.start,
    endDate: week.end,
    metrics: "views,estimatedMinutesWatched,subscribersGained,subscribersLost,likes,comments,shares",
    dimensions: "day"
  });
  return analyticsGet(`/reports?${qs}`, "analytics.channel.timeseries");
}

// Per-video metrics (filtered to videos in the window).
async function fetchVideoAnalytics(week, videoIds) {
  if (!videoIds.length) return null;
  const qs = new URLSearchParams({
    ids: "channel==MINE",
    startDate: week.start,
    endDate: week.end,
    metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,subscribersGained",
    dimensions: "video",
    filters: `video==${videoIds.join(",")}`,
    maxResults: "50"
  });
  return analyticsGet(`/reports?${qs}`, "analytics.videos");
}

// Age × gender demographics for the window.
async function fetchDemographics(week) {
  const qs = new URLSearchParams({
    ids: "channel==MINE",
    startDate: week.start,
    endDate: week.end,
    metrics: "viewerPercentage",
    dimensions: "ageGroup,gender"
  });
  return analyticsGet(`/reports?${qs}`, "analytics.demographics");
}

// Top countries by views for the window.
async function fetchGeography(week) {
  const qs = new URLSearchParams({
    ids: "channel==MINE",
    startDate: week.start,
    endDate: week.end,
    metrics: "views",
    dimensions: "country",
    sort: "-views",
    maxResults: "10"
  });
  return analyticsGet(`/reports?${qs}`, "analytics.geography");
}

// Traffic sources (search / suggested / browse / external / etc).
async function fetchTrafficSources(week) {
  const qs = new URLSearchParams({
    ids: "channel==MINE",
    startDate: week.start,
    endDate: week.end,
    metrics: "views,estimatedMinutesWatched",
    dimensions: "insightTrafficSourceType",
    sort: "-views"
  });
  return analyticsGet(`/reports?${qs}`, "analytics.trafficSources");
}

// Device type breakdown (mobile / tablet / desktop / tv).
async function fetchDeviceTypes(week) {
  const qs = new URLSearchParams({
    ids: "channel==MINE",
    startDate: week.start,
    endDate: week.end,
    metrics: "views,estimatedMinutesWatched",
    dimensions: "deviceType",
    sort: "-views"
  });
  return analyticsGet(`/reports?${qs}`, "analytics.deviceTypes");
}

// ---------- Normalizers for Analytics responses ----------
//
// Analytics responses come back as { columnHeaders: [{name}], rows: [[...]] }
// Convert to an array of plain objects keyed by column name.
function rowsToObjects(resp) {
  if (!resp?.rows || !resp?.columnHeaders) return [];
  const cols = resp.columnHeaders.map(c => c.name);
  return resp.rows.map(row => {
    const obj = {};
    cols.forEach((name, i) => { obj[name] = row[i]; });
    return obj;
  });
}

// Traffic-source type codes → human labels
// (https://developers.google.com/youtube/analytics/dimensions#Traffic_Source_Dimensions)
const TRAFFIC_SOURCE_LABELS = {
  ADVERTISING:              "Advertising",
  ANNOTATION:               "Annotations",
  CAMPAIGN_CARD:            "Campaign cards",
  END_SCREEN:               "End screens",
  EXT_URL:                  "External",
  NO_LINK_EMBEDDED:         "Embedded (no link)",
  NO_LINK_OTHER:            "Direct (no link)",
  NOTIFICATION:             "Notifications",
  PLAYLIST:                 "Playlists",
  PROMOTED:                 "Promoted",
  RELATED_VIDEO:            "Suggested videos",
  SHORTS:                   "Shorts feed",
  SUBSCRIBER:               "Subscriber feed",
  YT_CHANNEL:               "Channel pages",
  YT_OTHER_PAGE:            "Other YouTube pages",
  YT_PLAYLIST_PAGE:         "Playlist pages",
  YT_SEARCH:                "YouTube search",
  HASHTAGS:                 "Hashtags"
};

function humanTrafficSource(code) {
  return TRAFFIC_SOURCE_LABELS[code] || code;
}

// ISO country codes → human names (just the top countries we expect).
const COUNTRY_LABELS = {
  US: "United States", CA: "Canada", GB: "United Kingdom", AU: "Australia",
  NZ: "New Zealand", IE: "Ireland", IN: "India", ZA: "South Africa",
  DE: "Germany", FR: "France", NL: "Netherlands", MX: "Mexico",
  BR: "Brazil", PH: "Philippines", SG: "Singapore", AE: "United Arab Emirates"
};
function humanCountry(code) {
  return COUNTRY_LABELS[code] || code;
}

// Convert Analytics demographics rows (ageGroup,gender,viewerPercentage) into
// the same shape fetch_meta.js emits: {ageTotals, gender, age, country, city}.
// (city isn't available from YouTube Analytics, so we leave it empty.)
function normalizeYTDemographics(rows, geoRows) {
  const out = { ageTotals: [], gender: [], age: [], country: [], city: [] };
  if (!rows || rows.length === 0) return out;

  // Age × gender — fetch_meta stores age+gender combined rows plus ageTotals.
  for (const r of rows) {
    // ageGroup looks like "age18-24"; strip "age" prefix for display.
    const ageLabel = (r.ageGroup || "").replace(/^age/i, "");
    const genderLabel = (r.gender || "").toLowerCase();
    const value = r.viewerPercentage ?? 0;
    out.age.push({ label: ageLabel, gender: genderLabel, value });
  }
  // Collapse combined age rows into ageTotals
  const ageAgg = {};
  for (const r of out.age) ageAgg[r.label] = (ageAgg[r.label] || 0) + r.value;
  out.ageTotals = Object.entries(ageAgg)
    .map(([label, value]) => ({ label, value: Math.round(value * 10) / 10 }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // Gender totals
  const genderAgg = {};
  for (const r of out.age) genderAgg[r.gender] = (genderAgg[r.gender] || 0) + r.value;
  out.gender = Object.entries(genderAgg)
    .map(([label, value]) => ({ label, value: Math.round(value * 10) / 10 }))
    .sort((a, b) => b.value - a.value);

  // Country top 10 (from separate call)
  if (geoRows && geoRows.length) {
    const totalViews = geoRows.reduce((s, r) => s + (r.views || 0), 0) || 1;
    out.country = geoRows.slice(0, 10).map(r => ({
      label: humanCountry(r.country),
      value: Math.round((r.views / totalViews) * 1000) / 10 // as percent, 1dp
    }));
  }

  return out;
}

function normalizeTrafficSources(rows) {
  if (!rows || rows.length === 0) return null;
  const totalViews = rows.reduce((s, r) => s + (r.views || 0), 0) || 1;
  return rows.slice(0, 10).map(r => ({
    label: humanTrafficSource(r.insightTrafficSourceType),
    views: r.views || 0,
    minutesWatched: r.estimatedMinutesWatched || 0,
    sharePct: Math.round((r.views / totalViews) * 1000) / 10
  }));
}

function normalizeDeviceTypes(rows) {
  if (!rows || rows.length === 0) return null;
  const labelFor = code => ({
    MOBILE: "Mobile", TABLET: "Tablet", DESKTOP: "Desktop",
    TV: "TV", GAME_CONSOLE: "Game console", UNKNOWN_PLATFORM: "Unknown"
  }[code] || code);
  const totalViews = rows.reduce((s, r) => s + (r.views || 0), 0) || 1;
  return rows.map(r => ({
    label: labelFor(r.deviceType),
    views: r.views || 0,
    minutesWatched: r.estimatedMinutesWatched || 0,
    sharePct: Math.round((r.views / totalViews) * 1000) / 10
  }));
}

// ---------- Channel-level follower churn + totals from timeseries ----------
function summarizeTimeseries(tsRows) {
  if (!tsRows || tsRows.length === 0) return null;
  let gained = 0, lost = 0, totalMin = 0, totalViews = 0;
  for (const r of tsRows) {
    gained     += r.subscribersGained || 0;
    lost       += r.subscribersLost   || 0;
    totalMin   += r.estimatedMinutesWatched || 0;
    totalViews += r.views || 0;
  }
  return {
    subscribersGained: gained,
    subscribersLost: lost,
    subscribersNet: gained - lost,
    totalWatchMinutes: totalMin,
    totalViews,
    byDay: tsRows
  };
}

// ---------- Main ----------
export async function fetchYouTube(week) {
  // --- Tier 1: Data API (public) -------------------------------------------

  // 1. Channel stats + uploads playlist
  const chResp = await dataGet(
    `/channels?forHandle=${encodeURIComponent(YT_HANDLE)}&part=snippet,statistics,contentDetails`,
    "channels.list"
  );
  const channel = chResp.items?.[0];
  if (!channel) throw new Error(`channel not found for handle ${YT_HANDLE}`);
  const uploadsPlaylist = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylist) throw new Error("uploads playlist ID missing from channel response");
  const subscribers = parseInt(channel.statistics?.subscriberCount || 0, 10);

  // 2. Recent uploads (up to 50 most recent).
  const plResp = await dataGet(
    `/playlistItems?playlistId=${uploadsPlaylist}&part=contentDetails,snippet&maxResults=50`,
    "playlistItems.list"
  );
  const videoIds = (plResp.items || [])
    .map(it => it.contentDetails?.videoId)
    .filter(Boolean);

  // 3. Per-video stats
  const videos = await fetchVideoStats(videoIds);

  // --- Tier 2: Analytics API (OAuth) ---------------------------------------
  //
  // All Analytics calls are best-effort. If the user hasn't granted the scope
  // or hit a quota issue, we log a warning and emit null for that section.
  const [tsResp, vidAnaResp, demoResp, geoResp, trafResp, deviceResp] = await Promise.all([
    tryGet(() => fetchChannelTimeseries(week),                     "analytics.channel.timeseries"),
    tryGet(() => fetchVideoAnalytics(week, videoIds.slice(0, 200)), "analytics.videos"),
    tryGet(() => fetchDemographics(week),                          "analytics.demographics"),
    tryGet(() => fetchGeography(week),                             "analytics.geography"),
    tryGet(() => fetchTrafficSources(week),                        "analytics.trafficSources"),
    tryGet(() => fetchDeviceTypes(week),                           "analytics.deviceTypes")
  ]);

  const timeseries   = summarizeTimeseries(rowsToObjects(tsResp));
  const videoAnaRows = rowsToObjects(vidAnaResp);
  const demoRows     = rowsToObjects(demoResp);
  const geoRows      = rowsToObjects(geoResp);
  const trafRows     = rowsToObjects(trafResp);
  const deviceRows   = rowsToObjects(deviceResp);

  // Build a lookup: videoId → Analytics metrics
  const videoAnaById = {};
  for (const r of videoAnaRows) videoAnaById[r.video] = r;

  // --- Normalize videos + filter to window ---------------------------------
  const allNormalized = videos.map(v => {
    const stats = v.statistics || {};
    const snip  = v.snippet || {};
    const durationSec = parseDurationSec(v.contentDetails?.duration);
    const dataLikes    = parseInt(stats.likeCount || 0, 10);
    const dataComments = parseInt(stats.commentCount || 0, 10);
    const dataViews    = parseInt(stats.viewCount || 0, 10);

    // Prefer Analytics-reported values for the window; fall back to Data API
    // lifetime stats if Analytics didn't return data for this video.
    const ana = videoAnaById[v.id];
    const views    = ana?.views        ?? dataViews;
    const likes    = ana?.likes        ?? dataLikes;
    const comments = ana?.comments     ?? dataComments;
    const watchTimeMinutes       = ana?.estimatedMinutesWatched ?? null;
    const averageViewDurationSec = ana?.averageViewDuration ?? null;
    const averageViewPercentage  = ana?.averageViewPercentage ?? null;
    const subscribersGained      = ana?.subscribersGained ?? null;

    return {
      id: v.id,
      title: snip.title || "(untitled)",
      date: new Date(snip.publishedAt).toLocaleDateString("en-US", { month:"short", day:"numeric" }),
      timestamp: snip.publishedAt,
      format: classifyFormat(durationSec),
      length: formatDurationHuman(durationSec),
      durationSec,
      views,
      likes,
      comments,
      engagements: likes + comments,
      watchMinutes: watchTimeMinutes,
      watchTimeMinutes,
      averageViewDurationSec,
      averageViewPercentage,
      subscribersGained,
      url: `https://www.youtube.com/watch?v=${v.id}`,
      thumbnail: snip.thumbnails?.high?.url || snip.thumbnails?.default?.url || null
    };
  });

  const postsInWindow = allNormalized
    .filter(p => inWindow(p.timestamp, week.start, week.end))
    .sort((a, b) => b.engagements - a.engagements);

  // --- Assemble the return payload -----------------------------------------
  const demographics      = normalizeYTDemographics(demoRows, geoRows);
  const trafficSources    = normalizeTrafficSources(trafRows);
  const deviceTypes       = normalizeDeviceTypes(deviceRows);
  const formatPerformance = computeFormatPerformance(allNormalized);
  const bestTimeToPost    = computeBestTimes(videos);

  // followerChurn: same shape as fetch_meta (gained / lost / net).
  const followerChurn = timeseries
    ? {
        gained: timeseries.subscribersGained,
        lost:   timeseries.subscribersLost,
        net:    timeseries.subscribersNet,
        source: "YouTube Analytics API"
      }
    : null;

  // Build "watchTime" summary card the frontend can surface as its own KPI
  // or insight. Aggregate across the window.
  const windowTotals = timeseries
    ? {
        totalViews: timeseries.totalViews,
        totalWatchMinutes: timeseries.totalWatchMinutes,
        totalWatchHours: Math.round(timeseries.totalWatchMinutes / 60),
        // Average view duration across all videos in window (weighted by views)
        avgViewDurationSec: (() => {
          const withDur = allNormalized.filter(p => p.averageViewDurationSec != null && p.views > 0);
          const totalSec = withDur.reduce((s, p) => s + p.averageViewDurationSec * p.views, 0);
          const totalV   = withDur.reduce((s, p) => s + p.views, 0);
          return totalV ? Math.round(totalSec / totalV) : null;
        })()
      }
    : null;

  return {
    profile: {
      followers: subscribers,
      postsInWeek: postsInWindow.length
    },
    posts: postsInWindow,
    // Extended Tier 2 fields (all null if Analytics calls failed).
    demographics: demographics.ageTotals.length ? demographics : null,
    demographicsNote: demographics.ageTotals.length
      ? "Demographics from YouTube Analytics (viewer-weighted across the window)."
      : null,
    followerChurn,
    formatPerformance,
    bestTimeToPost,
    trafficSources,
    deviceTypes,
    watchTime: windowTotals
  };
}

export const YT_FETCHERS = {
  youtube: fetchYouTube
};

// Expose internals for tests
export const _internal = {
  getAccessToken,
  parseDurationSec,
  classifyFormat,
  formatDurationHuman,
  rowsToObjects,
  normalizeYTDemographics,
  normalizeTrafficSources,
  normalizeDeviceTypes,
  summarizeTimeseries,
  computeFormatPerformance,
  computeBestTimes,
  humanTrafficSource,
  humanCountry,
  // reset memoized access token (tests)
  _resetAccessToken: () => { _accessToken = null; }
};
