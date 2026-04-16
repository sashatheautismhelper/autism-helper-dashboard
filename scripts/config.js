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
    actorId:  "apify/facebook-pages-scraper",         // ← confirm during build
    input: {
      startUrls: [{ url: "https://www.facebook.com/theautismhelper/" }],
      resultsLimit: 30
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
  youtube: {
    actorId:  "streamers/youtube-scraper",            // ← confirm during build
    input: {
      startUrls: [{ url: "https://www.youtube.com/@theautismhelper" }],
      maxResults: 30
    }
  }
};

// How many prior weeks we keep on the site so the picker has history.
export const WEEKS_TO_KEEP = 52;
