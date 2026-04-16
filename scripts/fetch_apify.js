// ---------------------------------------------------------------------------
// Thin wrapper around apify-client.
// Given a platform config entry, runs the Actor synchronously and returns
// the dataset items (an array of raw platform objects).
// ---------------------------------------------------------------------------

import { ApifyClient } from "apify-client";

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

export async function fetchPlatform(name, cfg) {
  console.log(`[${name}] calling actor ${cfg.actorId}…`);
  const run = await client.actor(cfg.actorId).call(cfg.input, {
    // Max wait: 10 minutes per actor. Most finish in 1–3.
    waitSecs: 600
  });
  if (run.status !== "SUCCEEDED") {
    throw new Error(`[${name}] actor run ${run.id} ended with status ${run.status}`);
  }
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log(`[${name}] got ${items.length} items`);
  return items;
}
