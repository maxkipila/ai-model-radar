// Collects both modes and rebuilds the site data.
//
//   node collect.mjs                     # both modes since the default start
//   node collect.mjs --since 2026-06-22
//   node collect.mjs --only big          # or --only public
//
// Big projects: every commit on the default branch of every active 10,000+ star
// repository (lib/big.mjs). All public: per tool and complete day, the number of
// public commits carrying the tool's signature plus a sample of them. Days are
// cached in data/days/, newest first, and fetched again until they have been over
// for REFRESH_DAYS, so late-indexed commits are picked up. Everything is stored
// whole (lib/store.mjs); the rules run in build.mjs.
import { mkdirSync } from "node:fs";
import { search } from "./lib/github.mjs";
import { TOOLS } from "./lib/tools.mjs";
import { readGz, writeGz } from "./lib/store.mjs";
import { collectBig } from "./lib/big.mjs";
import { build, completeDays } from "./build.mjs";

const DAY = 86_400_000;
const REFRESH_DAYS = 7;
const dataDir = new URL("data/", import.meta.url);
const daysDir = new URL("days/", dataDir);
mkdirSync(daysDir, { recursive: true });

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const since = arg("--since") ?? "2026-06-22";
const only = arg("--only");

const toSample = (item) => ({
  oid: item.sha,
  repo: item.repository.full_name,
  date: item.commit.committer?.date,
  author: { name: item.commit.author?.name, email: item.commit.author?.email, login: item.author?.login ?? null },
  message: item.commit.message,
});

const time = (t) => `${new Date(t).toISOString().slice(0, 19)}+00:00`;

// A search over too many commits times out and reports a partial count that changes
// from call to call, so such a range is halved until every part is complete. Each
// part keeps its own count and sample.
async function fetchRange(query, from, to) {
  const range = to - from === DAY ? new Date(from).toISOString().slice(0, 10) : `${time(from)}..${time(to - 1000)}`;
  const first = await search("commits", `${query} committer-date:${range}`);
  if (first.incomplete_results && to - from > 3 * 3600_000) {
    const mid = from + (to - from) / 2;
    return [...(await fetchRange(query, from, mid)), ...(await fetchRange(query, mid, to))];
  }
  return [{ range, total: first.total_count, ...(first.incomplete_results && { incomplete: true }), samples: first.items.map(toSample) }];
}

async function collectPublic() {
  const queries = TOOLS.flatMap((tool) => tool.queries.map((query) => ({ label: tool.id, query })));
  for (const day of completeDays(since).reverse()) {
    const file = new URL(`${day}.json.gz`, daysDir);
    const cache = readGz(file, {});
    const from = Date.parse(`${day}T00:00:00Z`);
    const settledAfter = from + (1 + REFRESH_DAYS) * DAY;
    for (const { label, query } of queries) {
      const fetched = cache[query] ? Date.parse(cache[query].fetchedAt) : 0;
      if (fetched >= settledAfter || Date.now() - fetched < 12 * 3600_000) continue;
      const parts = await fetchRange(query, from, from + DAY);
      cache[query] = { fetchedAt: new Date().toISOString(), parts };
      writeGz(file, cache);
      const total = parts.reduce((s, p) => s + p.total, 0);
      console.log(`public ${day}  ${label.padEnd(12)} ${String(total).padStart(9)}  ${query}${parts.length > 1 ? `  (${parts.length} parts)` : ""}`);
    }
  }
}

await Promise.all([
  only !== "public" && collectBig(dataDir, since),
  only !== "big" && collectPublic(),
]);
build();
