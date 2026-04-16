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
  // Expected fields (apify/facebook-pages-scraper): pageName, likes (followers),
  // posts: [{ text, time, postType, reactions, comments, shares }]
  const profile = items.find(i => i.pageName || i.likes != null) || items[0] || {};
  const rawPosts = items.filter(i => i.postId || i.time);
  const postsInWeek = rawPosts
    .filter(p => inWindow(p.time, window.start, window.end))
    .map(p => ({
      title: (p.text || "").split("\n")[0].slice(0, 80) || "(no text)",
      date: shortDate(p.time),
      format: p.postType || "Post",
      reactions: p.reactions?.total ?? p.reactionsCount ?? 0,
      comments: p.commentsCount ?? 0,
      shares: p.sharesCount ?? 0,
      engagements: (p.reactions?.total ?? 0) + (p.commentsCount ?? 0) + (p.sharesCount ?? 0)
    }))
    .sort((a, b) => b.engagements - a.engagements);

  return {
    profile: { followers: profile.followers ?? profile.likes ?? null, postsInWeek: postsInWeek.length },
    posts: postsInWeek.slice(0, 8)
  };
}

// ---------- Pinterest ----------
export function transformPinterest(items, window) {
  // Expected fields vary by actor — common shape: pin objects with
  // { title, pinnedAt, mediaType, saves, comments, repins }
  const profile = items.find(i => i.followerCount != null || i.monthlyViewers != null) || items[0] || {};
  const rawPins = items.filter(i => i.pinnedAt || i.createdAt);
  const pinsInWeek = rawPins
    .filter(p => inWindow(p.pinnedAt || p.createdAt, window.start, window.end))
    .map(p => ({
      title: (p.title || p.description || "").slice(0, 80) || "(untitled pin)",
      date: shortDate(p.pinnedAt || p.createdAt),
      format: p.mediaType === "video" ? "Video Pin" : p.isIdeaPin ? "Idea Pin" : "Standard",
      saves: p.saves ?? 0,
      comments: p.comments ?? 0,
      repins: p.repins ?? 0,
      engagements: (p.saves ?? 0) + (p.comments ?? 0) + (p.repins ?? 0)
    }))
    .sort((a, b) => b.engagements - a.engagements);

  return {
    profile: {
      followers: profile.monthlyViewers ?? profile.followerCount ?? null,
      postsInWeek: pinsInWeek.length,
      followersNote: profile.monthlyViewers ? "monthly viewers" : undefined
    },
    posts: pinsInWeek.slice(0, 8)
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
  const profile = items.find(i => i.subscriberCount != null || i.numberOfSubscribers != null) || items[0] || {};
  const rawVids = items.filter(i => i.publishedAt || i.date);
  const vidsInWeek = rawVids
    .filter(v => inWindow(v.publishedAt || v.date, window.start, window.end))
    .map(v => ({
      title: (v.title || "").slice(0, 80) || "(untitled)",
      date: shortDate(v.publishedAt || v.date),
      length: v.duration || "—",
      views: v.viewCount ?? 0,
      likes: v.likes ?? 0,
      comments: v.commentsCount ?? 0,
      engagements: (v.likes ?? 0) + (v.commentsCount ?? 0)
    }))
    .sort((a, b) => b.views - a.views);

  return {
    profile: {
      followers: profile.subscriberCount ?? profile.numberOfSubscribers ?? null,
      postsInWeek: vidsInWeek.length
    },
    posts: vidsInWeek.slice(0, 8)
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
