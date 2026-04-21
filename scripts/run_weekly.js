// ---------------------------------------------------------------------------
// Insights engine — applies deterministic rules to this week's numbers and
// generates the "What's Working / Where to Pivot / Post More Of" blocks.
//
// Rules are intentionally simple. They can be tuned easily, and an LLM pass
// can be added later if you want more nuance.
// ---------------------------------------------------------------------------

const pct = (curr, prev) => prev === 0 ? 0 : ((curr - prev) / prev) * 100;

// ---------- Per-platform insights ----------
// Format UTC hour as "H AM/PM CT" (US Central, which is UTC-5 during DST /
// UTC-6 standard). We split the difference at UTC-5 since TAH is in Illinois
// and DST covers most of the year.
function utcHourToCentral(utcHour) {
  const centralHour = (utcHour - 5 + 24) % 24;
  const ampm = centralHour < 12 ? "AM" : "PM";
  const display = centralHour % 12 === 0 ? 12 : centralHour % 12;
  return `${display} ${ampm} CT`;
}

export function platformInsights(name, thisWeek, lastWeek) {
  const followerDelta = (thisWeek.profile.followers || 0) - (lastWeek?.profile?.followers || 0);
  const topPost = thisWeek.posts[0];
  const totalEng = thisWeek.posts.reduce((s, p) => s + (p.engagements || p.views || p.likes || 0), 0);
  const prevTotalEng = (lastWeek?.posts || []).reduce((s, p) => s + (p.engagements || p.views || p.likes || 0), 0);
  const engChange = pct(totalEng, prevTotalEng);

  const working = { headline: "", bullets: [] };
  const pivot   = { headline: "", bullets: [] };
  const postMore= { headline: "Next 2 weeks", bullets: [] };

  // WORKING rules
  if (followerDelta > 0) {
    // If we have gross churn data, surface gained-vs-lost rather than just net.
    if (thisWeek.followerChurn?.gained != null && thisWeek.followerChurn?.lost != null) {
      working.bullets.push(
        `<strong>${thisWeek.followerChurn.gained.toLocaleString()} new followers</strong> gained ` +
        `(against ${thisWeek.followerChurn.lost.toLocaleString()} lost → net +${followerDelta.toLocaleString()}).`
      );
    } else {
      working.bullets.push(`<strong>${followerDelta.toLocaleString()} net new followers</strong> this week.`);
    }
  }
  if (topPost) {
    working.bullets.push(`Top post: "<strong>${topPost.title}</strong>" (${topPost.format || topPost.length || "post"}) drove the most engagement.`);
  }
  if (engChange > 10) {
    working.bullets.push(`Engagement volume up <strong>${engChange.toFixed(0)}%</strong> vs last week — momentum building.`);
  }
  working.headline = followerDelta > 0 ? "Audience is growing" : "Steady engagement this week";

  // PIVOT rules
  if (engChange < -10) {
    pivot.headline = "Engagement dipped week-over-week";
    pivot.bullets.push(`Total engagement down <strong>${Math.abs(engChange).toFixed(0)}%</strong>. Investigate posting cadence and formats.`);
  }
  // Surface churn-driven pivots even when net followers are up
  if (thisWeek.followerChurn?.lost > 0 && thisWeek.followerChurn?.gained != null) {
    const churnRatio = thisWeek.followerChurn.lost / Math.max(1, thisWeek.followerChurn.gained);
    if (churnRatio > 0.5) {
      pivot.bullets.push(
        `Churn ratio is <strong>${(churnRatio*100).toFixed(0)}%</strong> — you're losing ${thisWeek.followerChurn.lost} for every ${thisWeek.followerChurn.gained} gained. ` +
        `Review recent posts for off-brand content.`
      );
    }
  }
  if (thisWeek.posts.length < (lastWeek?.posts?.length || 0) - 2) {
    pivot.bullets.push(`Posting cadence dropped to <strong>${thisWeek.posts.length}</strong> posts (from ${lastWeek.posts.length}). Restore volume with evergreen re-posts.`);
  }
  if (thisWeek.posts.length && topPost.engagements / (totalEng || 1) > 0.5) {
    pivot.bullets.push(`One post drove ${((topPost.engagements / totalEng) * 100).toFixed(0)}% of this week's engagement — concentration risk. Spread the bets.`);
  }
  if (!pivot.headline) pivot.headline = "Small tweaks to try";
  if (pivot.bullets.length === 0) pivot.bullets.push("Nothing urgent — stay the course.");

  // POST MORE rules — prefer API-sourced formatPerformance (with reach/views)
  // over ad-hoc format grouping when available.
  if (thisWeek.formatPerformance && thisWeek.formatPerformance.length > 0) {
    const top = thisWeek.formatPerformance[0];
    const runnerUp = thisWeek.formatPerformance[1];
    if (runnerUp && top.avgEngagement > runnerUp.avgEngagement * 1.2) {
      const lift = Math.round(((top.avgEngagement / runnerUp.avgEngagement) - 1) * 100);
      postMore.bullets.push(
        `More <strong>${top.format}</strong> content — averaged ${top.avgEngagement.toLocaleString()} engagements per post, ` +
        `<strong>${lift}% above</strong> the next format.`
      );
    } else {
      postMore.bullets.push(`More <strong>${top.format}</strong> content — your highest avg engagement format (${top.avgEngagement.toLocaleString()} per post).`);
    }
  } else {
    const formatEng = {};
    thisWeek.posts.forEach(p => {
      const f = p.format || p.length || "post";
      formatEng[f] = (formatEng[f] || 0) + (p.engagements || p.views || 0);
    });
    const topFormats = Object.entries(formatEng).sort((a,b) => b[1]-a[1]).slice(0, 2);
    topFormats.forEach(([f]) => {
      postMore.bullets.push(`More <strong>${f}</strong> content — highest engagement this week.`);
    });
  }

  // Add best-time-to-post recommendation when we have enough signal
  if (thisWeek.bestTimeToPost) {
    const bt = thisWeek.bestTimeToPost;
    postMore.bullets.push(
      `Schedule your next post for <strong>${bt.topDay} around ${utcHourToCentral(bt.topHour)}</strong> ` +
      `— historically your highest-engagement window (avg ${bt.topAvgEng.toLocaleString()} engagements).`
    );
  }

  if (postMore.bullets.length < 2) postMore.bullets.push("Mix in a fresh format to test audience response.");

  return { working, pivot, postMore };
}

// ---------- Cross-platform overview insights ----------
export function overviewInsights(platforms, lastWeekPlatforms) {
  const working = { headline: "", bullets: [] };
  const pivot   = { headline: "", bullets: [] };
  const postMore= { headline: "Next 2 weeks — cross-platform priorities", bullets: [] };

  // Find fastest grower
  const growth = Object.entries(platforms).map(([k, v]) => ({
    name: k,
    delta: (v.profile.followers || 0) - (lastWeekPlatforms?.[k]?.profile?.followers || 0)
  })).sort((a,b) => b.delta - a.delta);
  const top = growth[0];
  if (top && top.delta > 0) {
    working.headline = `${capitalize(top.name)} is leading growth`;
    working.bullets.push(`<strong>${capitalize(top.name)}</strong> added ${top.delta.toLocaleString()} followers — our fastest grower this week.`);
  } else {
    working.headline = "Steady audience across platforms";
  }

  // Top overall format
  const allPosts = Object.values(platforms).flatMap(p => p.posts);
  const formatEng = {};
  allPosts.forEach(p => {
    const f = p.format || p.length || "post";
    formatEng[f] = (formatEng[f] || 0) + (p.engagements || p.views || 0);
  });
  const topFormat = Object.entries(formatEng).sort((a,b) => b[1]-a[1])[0];
  if (topFormat) {
    working.bullets.push(`<strong>${topFormat[0]}</strong> is the highest-engaging format this week across all platforms.`);
  }

  // Slowest grower
  const slow = growth[growth.length - 1];
  if (slow && slow.delta < 0) {
    pivot.headline = `${capitalize(slow.name)} lost followers this week`;
    pivot.bullets.push(`<strong>${capitalize(slow.name)}</strong> down ${Math.abs(slow.delta)} followers. Review recent post performance and cadence.`);
  } else if (slow && slow.delta < (top?.delta || 0) / 10) {
    pivot.headline = `${capitalize(slow.name)} is stagnant`;
    pivot.bullets.push(`<strong>${capitalize(slow.name)}</strong> gained only ${slow.delta} followers. Consider testing a new content angle.`);
  }
  if (!pivot.headline) { pivot.headline = "Nothing major to flag"; pivot.bullets.push("All platforms tracking to trend."); }

  // Post more
  postMore.bullets.push(`Double down on <strong>${capitalize(top?.name || "your fastest-growing platform")}</strong> — ride the wave.`);
  if (topFormat) postMore.bullets.push(`Produce more <strong>${topFormat[0]}</strong> content across platforms.`);
  postMore.bullets.push("Cross-promote top-performing content between platforms (e.g., TikTok → Reel → Short).");

  return { working, pivot, postMore };
}

const capitalize = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : "";

