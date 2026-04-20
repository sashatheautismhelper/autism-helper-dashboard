// ---------------------------------------------------------------------------
// Native Meta Graph API client for Instagram + Facebook.
//
// Replaces the Apify path for these two platforms. Requires three env vars:
//   META_IG_TOKEN    — never-expiring Instagram Business Login access token
//   META_PAGE_TOKEN  — never-expiring Facebook Page access token
//   META_PAGE_ID     — numeric Facebook Page ID (e.g. 226239834165267)
//
// Each fetcher returns data already in the {profile, posts} normalized shape
// so run_weekly.js can drop them straight in without going through transform.js.
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

// ---------- Shared helpers ----------
const inWindow = (isoDate, startIso, endIso) => {
  const t = new Date(isoDate).getTime();
  return t >= new Date(startIso).getTime() &&
         t <= new Date(endIso + "T23:59:59Z").getTime();
};
const shortDate = iso => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const firstLine = s => (s || "").split("\n")[0].slice(0, 80);

// ---------- Instagram ----------
//
// Endpoints used (all via graph.instagram.com, the Instagram Business Login host):
//   GET /me?fields=id,username,name,followers_count,media_count
//   GET /me/media?fields=id,caption,media_type,timestamp,permalink,like_count,comments_count&limit=50
//   GET /{media-id}/insights?metric=reach,saved,plays|impressions   (best-effort)
export async function fetchInstagram(week) {
  if (!IG_TOKEN) throw new Error("META_IG_TOKEN not set");

  // 1) account
  const me = await igGet(
    "/me?fields=id,username,name,followers_count,media_count",
    "ig/me"
  );

  // 2) recent media (50 most recent; week filter applied after)
  const mediaResp = await igGet(
    "/me/media?fields=id,caption,media_type,timestamp,permalink,like_count,comments_count&limit=50",
    "ig/media"
  );
  const allMedia = mediaResp.data || [];

  // Count posts published in the reporting week
  const inWeek = allMedia.filter(p => inWindow(p.timestamp, week.start, week.end));

  // 3) per-post insights (best-effort — don't fail the whole fetch if insights call errors)
  const enriched = await Promise.all(inWeek.map(async p => {
    const isVideo = p.media_type === "VIDEO" || p.media_type === "REELS";
    // Different metric names for videos vs images
    const metric = isVideo ? "plays,reach,saved" : "impressions,reach,saved";
    try {
      const ins = await igGet(`/${p.id}/insights?metric=${metric}`, `ig/insights/${p.id}`);
      const flat = {};
      for (const m of ins.data || []) flat[m.name] = m.values?.[0]?.value ?? 0;
      return { ...p, _insights: flat };
    } catch (err) {
      console.warn(`[ig] insights miss for ${p.id}: ${err.message.split("\n")[0]}`);
      return { ...p, _insights: {} };
    }
  }));

  const posts = enriched.map(p => {
    const saves   = p._insights.saved ?? 0;
    const reach   = p._insights.reach ?? 0;
    const views   = p._insights.plays ?? p._insights.impressions ?? 0;
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
      shares: 0, // IG API doesn't expose public shares
      saves,
      views,
      reach,
      engagements: likes + cmts + saves
    };
  }).sort((a, b) => b.engagements - a.engagements);

  return {
    profile: {
      followers: me.followers_count ?? null,
      postsInWeek: posts.length,
      username: me.username
    },
    posts: posts.slice(0, 8)
  };
}

// ---------- Facebook ----------
//
// Endpoints used (all via graph.facebook.com with the Page Access Token):
//   GET /{page-id}?fields=followers_count,fan_count,name
//   GET /{page-id}/posts?fields=...&since=&until=&limit=100
export async function fetchFacebook(week) {
  if (!PAGE_TOKEN) throw new Error("META_PAGE_TOKEN not set");
  if (!PAGE_ID) throw new Error("META_PAGE_ID not set");

  // 1) page profile
  const page = await fbGet(
    `/${PAGE_ID}?fields=id,name,followers_count,fan_count`,
    "fb/page"
  );

  // 2) posts from this-week window (unix seconds)
  const since = Math.floor(new Date(week.start).getTime() / 1000);
  const until = Math.floor(new Date(week.end + "T23:59:59Z").getTime() / 1000);
  const postsResp = await fbGet(
    `/${PAGE_ID}/posts?fields=id,message,story,created_time,permalink_url,` +
    `reactions.summary(true),comments.summary(true),shares&since=${since}&until=${until}&limit=100`,
    "fb/posts"
  );
  const rawPosts = postsResp.data || [];

  const posts = rawPosts.map(p => {
    const reactions = p.reactions?.summary?.total_count ?? 0;
    const comments  = p.comments?.summary?.total_count ?? 0;
    const shares    = p.shares?.count ?? 0;
    return {
      title: firstLine(p.message || p.story) || "(no text)",
      date: shortDate(p.created_time),
      format: "Post",
      reactions,
      comments,
      shares,
      engagements: reactions + comments + shares
    };
  }).sort((a, b) => b.engagements - a.engagements);

  return {
    profile: {
      followers: page.followers_count ?? page.fan_count ?? null,
      postsInWeek: posts.length
    },
    posts: posts.slice(0, 8)
  };
}

// Map keyed by platform name for easy dispatch from run_weekly.js
export const META_FETCHERS = {
  instagram: fetchInstagram,
  facebook:  fetchFacebook
};
