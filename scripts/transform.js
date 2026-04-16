// ---------------------------------------------------------------------------
// Turn raw Apify output into the normalized shape the dashboard expects.
//
// Every Actor returns slightly different field names (e.g. likesCount vs
// likes vs diggCount). We normalize per-platform here so the rest of the
// pipeline doesn't have to care.
//
// Each transformer takes the raw Apify items and returns:
//   { profile: { followers, ... }, posts: [ {title, date, format, metrics...} ] }
// ---------------------------------------------------------------------------

const inWindow = (isoDate, startIso, endIso) => {
  const t = new Date(isoDate).getTime();
  return t >= new Date(startIso).getTime() && t <= new Date(endIso + "T23:59:59Z").getTime();
};

const shortDate = iso => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

// ---------- Instagram ----------
export function transformInstagram(items, window) {
  // Expected fields (apify/instagram-scraper): ownerUsername, followersCount,
  // posts: [{ caption, timestamp, type, likesCount, commentsCount, ... }]
  const profile = items.find(i => i.ownerUsername || i.username) || items[0] || {};
  const rawPosts = items.filter(i => i.timestamp || i.takenAtTimestamp);
  const postsInWeek = rawPosts
    .filter(p => inWindow(p.timestamp, window.start, window.end))
    .map(p => ({
      title: (p.caption || "").split("\n")[0].slice(0, 80) || "(no caption)",
      date: shortDate(p.timestamp),
      format: p.type === "Video" ? "Reel" : p.type === "Sidecar" ? "Carousel" : "Image",
      likes: p.likesCount ?? 0,
      comments: p.commentsCount ?? 0,
      shares: 0, // IG doesn't expose public shares
      engagements: (p.likesCount ?? 0) + (p.commentsCount ?? 0)
    }))
    .sort((a, b) => b.engagements - a.engagements);

  return {
    profile: { followers: profile.followersCount ?? null, postsInWeek: postsInWeek.length },
    posts: postsInWeek.slice(0, 8)
  };
}

// ---------- Facebook ----------
export function transformFacebook(items, window) {
  // apify/facebook-pages-scraper returns pages as top-level items that often
  // have posts nested inside (items[0].posts = [...]). Other facebook actors
  // (e.g. facebook-posts-scraper) return each post as its own top-level item.
  // Handle BOTH shapes so we never end up empty-handed.
  const profile = items.find(i => i.pageName || i.likes != null || i.followersCount != null || i.followers != null) || items[0] || {};

  // 1) Flatten nested posts from any page-level items
  const nested = items.flatMap(i => Array.isArray(i.posts) ? i.posts : []);
  // 2) Pick up any top-level items that look like posts themselves
  const topLevelPosts = items.filter(i =>
    i.postId || i.postUrl || i.url?.includes("/posts/") || i.postType || i.text != null
  );
  const allRaw = [...nested, ...topLevelPosts];

  // Pick any reasonable timestamp field
  const postTime = p => p.time || p.timestamp || p.publishedAt || p.date || p.createdTime || p.created_time || null;
  const norm = p => {
    const r = p.reactions;
    const reactions = typeof r === "number" ? r : (r?.total ?? p.reactionsCount ?? p.likesCount ?? p.likes ?? 0);
    const comments = p.commentsCount ?? p.comments ?? 0;
    const shares   = p.sharesCount ?? p.shares ?? 0;
    return {
      title: ((p.text || p.message || p.caption || "").split("\n")[0] || "").slice(0, 80) || "(no text)",
      date: shortDate(postTime(p) || new Date().toISOString()),
      _rawDate: postTime(p),
      format: p.postType || p.type || (p.videoUrl ? "Video" : p.image ? "Image" : "Post"),
      reactions,
      comments: typeof comments === "number" ? comments : (comments?.total ?? 0),
      shares:   typeof shares === "number"   ? shares   : (shares?.total   ?? 0),
      engagements: 0 // filled below
    };
  };

  const normalized = allRaw.map(norm).map(p => {
    p.engagements = (p.reactions || 0) + (p.comments || 0) + (p.shares || 0);
    return p;
  });

  // Filter to this week when we have dates; otherwise just use everything we got
  const withDates = normalized.filter(p => p._rawDate);
  const inWeek = withDates.filter(p => inWindow(p._rawDate, window.start, window.end));
  const pool = inWeek.length ? inWeek : (withDates.length ? withDates : normalized);
  const sorted = pool.sort((a, b) => b.engagements - a.engagements);

  return {
    profile: {
      followers: profile.followers ?? profile.followersCount ?? profile.likes ?? profile.likesCount ?? null,
      postsInWeek: inWeek.length
    },
    posts: sorted.slice(0, 8).map(({ _rawDate, ...rest }) => rest)
  };
}

// ---------- Pinterest ----------
export function transformPinterest(items, window) {
  // Field names vary a lot across Pinterest actors (epctex, apify/*, etc.).
  // Accept anything that looks like a pin.
  const profile = items.find(i =>
    i.followerCount != null || i.monthlyViewers != null || i.followers != null || i.followers_count != null
  ) || items[0] || {};

  const pinDate = p => p.pinnedAt || p.createdAt || p.created_at || p.publishedAt || p.date || null;
  const isPinish = i =>
    i.pinId || i.pin_id || i.id?.toString().startsWith("pin") ||
    i.pinnedAt || i.createdAt || i.created_at ||
    (i.title && i.url && /pinterest/i.test(i.url || ""));

  const rawPins = items.filter(isPinish);

  const normalize = p => {
    const saves    = p.saves ?? p.saveCount ?? p.save_count ?? 0;
    const comments = p.comments ?? p.commentCount ?? p.comment_count ?? 0;
    const repins   = p.repins ?? p.repinCount ?? p.repin_count ?? p.reactionCount ?? 0;
    return {
      title: (p.title || p.description || p.grid_title || "").slice(0, 80) || "(untitled pin)",
      date: shortDate(pinDate(p) || new Date().toISOString()),
      _rawDate: pinDate(p),
      format: p.mediaType === "video" || p.videos ? "Video Pin" : p.isIdeaPin || p.is_story_pin ? "Idea Pin" : "Standard",
      saves:    typeof saves === "number"    ? saves    : 0,
      comments: typeof comments === "number" ? comments : 0,
      repins:   typeof repins === "number"   ? repins   : 0,
      engagements: 0
    };
  };

  const normalized = rawPins.map(normalize).map(p => {
    p.engagements = (p.saves || 0) + (p.comments || 0) + (p.repins || 0);
    return p;
  });

  // Filter to this-week pins when we have dates; fall back to all dated pins
  // if nothing lands in-window; final fallback to everything (engagement-sorted).
  const withDates = normalized.filter(p => p._rawDate);
  const inWeek = withDates.filter(p => inWindow(p._rawDate, window.start, window.end));
  const pool = inWeek.length ? inWeek : (withDates.length ? withDates : normalized);
  const sorted = pool.sort((a, b) => b.engagements - a.engagements);

  return {
    profile: {
      followers: profile.monthlyViewers ?? profile.followerCount ?? profile.followers ?? profile.followers_count ?? null,
      postsInWeek: inWeek.length,
      followersNote: profile.monthlyViewers ? "monthly viewers" : undefined
    },
    posts: sorted.slice(0, 8).map(({ _rawDate, ...rest }) => rest)
  };
}

// ---------- TikTok ----------
export function transformTikTok(items, window) {
  // Expected fields (clockworks/tiktok-scraper): authorMeta.fans,
  // posts: [{ text, createTimeISO, videoMeta, playCount, diggCount, commentCount, shareCount }]
  const profile = items.find(i => i.authorMeta?.fans != null) || items[0] || {};
  const rawVids = items.filter(i => i.createTimeISO || i.createTime);
  const vidsInWeek = rawVids
    .filter(v => inWindow(v.createTimeISO || v.createTime * 1000, window.start, window.end))
    .map(v => ({
      title: (v.text || "").slice(0, 80) || "(no caption)",
      date: shortDate(v.createTimeISO || new Date(v.createTime * 1000).toISOString()),
      length: formatDuration(v.videoMeta?.duration),
      views: v.playCount ?? 0,
      likes: v.diggCount ?? 0,
      comments: v.commentCount ?? 0,
      shares: v.shareCount ?? 0
    }))
    .sort((a, b) => b.views - a.views);

  return {
    profile: { followers: profile.authorMeta?.fans ?? null, postsInWeek: vidsInWeek.length },
    posts: vidsInWeek.slice(0, 8)
  };
}

// ---------- YouTube ----------
export function transformYouTube(items, window) {
  // Expected fields (streamers/youtube-scraper): channel data + video list
  // { title, publishedAt, duration, viewCount, likes, commentsCount }
  // For YouTube we DON'T limit to videos published in the reporting week —
  // the channel posts infrequently and weekly reports should showcase the
  // current top-performing videos regardless of when they were uploaded.
  const profile = items.find(i => i.subscriberCount != null || i.numberOfSubscribers != null) || items[0] || {};
  const rawVids = items.filter(i => i.publishedAt || i.date);

  const allVids = rawVids.map(v => ({
    title: (v.title || "").slice(0, 80) || "(untitled)",
    date: shortDate(v.publishedAt || v.date),
    length: v.duration || "—",
    views: v.viewCount ?? 0,
    likes: v.likes ?? 0,
    comments: v.commentsCount ?? 0,
    engagements: (v.likes ?? 0) + (v.commentsCount ?? 0),
    _postedInWeek: inWindow(v.publishedAt || v.date, window.start, window.end)
  }));

  // Top 8 by total engagements (falls back to views if all engagements are 0)
  const sorted = allVids.sort((a, b) =>
    (b.engagements - a.engagements) || (b.views - a.views)
  );
  const top8 = sorted.slice(0, 8).map(({ _postedInWeek, ...rest }) => rest);

  return {
    profile: {
      followers: profile.subscriberCount ?? profile.numberOfSubscribers ?? null,
      postsInWeek: allVids.filter(v => v._postedInWeek).length
    },
    posts: top8
  };
}

function formatDuration(seconds) {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export const TRANSFORMERS = {
  instagram: transformInstagram,
  facebook:  transformFacebook,
  pinterest: transformPinterest,
  tiktok:    transformTikTok,
  youtube:   transformYouTube
};
