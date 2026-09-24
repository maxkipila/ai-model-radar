// Collects both modes and rebuilds the site data.
//
//   node collect.mjs                     # both modes since the default start
//   node collect.mjs --since 2026-06-22
//   node collect.mjs --only big          # or --only public
//
// Big projects: every commit on the default branch of every active 10,000+ star
// repository (lib/big.mjs). All public: per tool and complete week, the number of
// public commits carrying the tool's signature plus a sample of them. Weeks are
// cached in data/weeks/ and fetched again until they have been over for
// REFRESH_DAYS, so late-indexed commits are picked up. Everything is stored whole
// (lib/store.mjs); the rules run in build.mjs.
import { mkdirSync } from "node:fs";
import { search } from "./lib/github.mjs";
import { TOOLS } from "./lib/tools.mjs";
import { readGz, writeGz } from "./lib/store.mjs";
import { collectBig } from "./lib/big.mjs";
import { build, completeWeeks } from "./build.mjs";

const DAY = 86_400_000;
const REFRESH_DAYS = 7;
const dataDir = new URL("data/", import.meta.url);
const weeksDir = new URL("weeks/", dataDir);
mkdirSync(weeksDir, { recursive: true });

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

const date = (t) => new Date(t).toISOString().slice(0, 10);
const time = (t) => `${new Date(t).toISOString().slice(0, 19)}+00:00`;

// A search over too many commits times out and reports a partial count that changes
// from call to call, so such a range is split (week into days, a day into halves)
// until every part is complete. Each part keeps its own count and sample.
async function fetchRange(query, from, to, pages) {
  const range = from % DAY === 0 && to % DAY === 0
    ? (to - from === DAY ? date(from) : `${date(from)}..${date(to - DAY)}`)
    : `${time(from)}..${time(to - 1000)}`;
  const q = `${query} committer-date:${range}`;
  const first = await search("commits", q);
  if (first.incomplete_results && to - from > 3 * 3600_000) {
    const step = to - from > DAY ? DAY : (to - from) / 2;
    const parts = [];
    for (let t = from; t < to; t += step) parts.push(...(await fetchRange(query, t, t + step, 1)));
    return parts;
  }
  const samples = first.items.map(toSample);
  for (let page = 2; page <= pages && first.total_count > (page - 1) * 100; page++) {
    try {
      samples.push(...(await search("commits", q, { page })).items.map(toSample));
    } catch (e) {
      // A deeper page that keeps timing out only costs sample size.
      console.error(`  page ${page} skipped: ${e.message.slice(0, 120)}`);
      break;
    }
  }
  return [{ range, total: first.total_count, ...(first.incomplete_results && { incomplete: true }), samples }];
}

async function collectPublic() {
  const queries = TOOLS.flatMap((tool) => tool.queries.map((query) => ({ label: tool.id, query, pages: tool.pages })));
  for (const week of completeWeeks(since).reverse()) {
    const file = new URL(`${week}.json.gz`, weeksDir);
    const cache = readGz(file, {});
    const from = Date.parse(`${week}T00:00:00Z`);
    const settledAfter = from + (7 + REFRESH_DAYS) * DAY;
    for (const { label, query, pages } of queries) {
      const fetched = cache[query] ? Date.parse(cache[query].fetchedAt) : 0;
      if (fetched >= settledAfter || Date.now() - fetched < 12 * 3600_000) continue;
      const parts = await fetchRange(query, from, from + 7 * DAY, pages);
      cache[query] = { fetchedAt: new Date().toISOString(), parts };
      writeGz(file, cache);
      const total = parts.reduce((s, p) => s + p.total, 0);
      console.log(`public ${week}  ${label.padEnd(12)} ${String(total).padStart(9)}  ${query}${parts.length > 1 ? `  (${parts.length} parts)` : ""}`);
    }
  }
}

await Promise.all([
  only !== "public" && collectBig(dataDir, since),
  only !== "big" && collectPublic(),
]);
build();
