// ---------------------------------------------------------------------------
// TAH Dashboard — platform config
//
// Each platform entry tells the refresh script:
//   - which Apify Actor to call
//   - which URL to scrape
//   - how many recent posts to pull
//
// The `actorId` values below are placeholders. During build week 1 we'll pick
// the specific Actors from Apify's marketplace (based on current reliability
// and cost) and replace them here. No other file needs to change.
// ---------------------------------------------------------------------------

export const PLATFORMS = {
  instagram: {
    actorId:  "apify/instagram-scraper",              // ← confirm during build
    input: {
      directUrls: ["https://www.instagram.com/theautismhelper/"],
      resultsType: "posts",
      resultsLimit: 30
    }
  },
  facebook: {
    // facebook-pages-scraper only returns page metadata (followers, about, etc.)
    // and does NOT return posts. Use facebook-posts-scraper instead — it's
    // purpose-built to return individual posts with reactions / comments / shares.
    actorId:  "apify/facebook-posts-scraper",
    input: {
      startUrls: [{ url: "https://www.facebook.com/theautismhelper/" }],
      resultsLimit: 30,
      onlyPostsNewerThan: null
    }
  },
  pinterest: {
    actorId:  "epctex/pinterest-scraper",             // ← confirm during build
    input: {
      startUrls: ["https://www.pinterest.com/theautismhelper/"],
      resultsLimit: 40
    }
  },
  tiktok: {
    actorId:  "clockworks/tiktok-scraper",            // ← confirm during build
    input: {
      profiles: ["theautismhelper"],
      resultsPerPage: 30
    }
  },
  // NOTE: YouTube is NOT here — it's fetched via scripts/fetch_youtube.js
  // using the YouTube Data API v3 + Analytics API v2 directly. This map
  // lists only the platforms we still route through Apify.
  youtube: {
    // Still declared so run_weekly.js's PLATFORMS loop iterates over it,
    // but the fetcher dispatch checks YT_FETCHERS first and uses the
    // native API path instead of Apify.
    actorId: null,
    input: null,
    _nativeFetcher: "fetch_youtube.js"
  }
};

// How many prior weeks we keep on the site so the picker has history.
export const WEEKS_TO_KEEP = 52;
