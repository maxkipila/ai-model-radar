// GitHub API client. Search allows 30 requests a minute and punishes bursts with a
// secondary limit, so search calls run one at a time with a gap that widens after
// each limit hit and narrows again while requests go through. GraphQL is limited by
// points per hour and is paced by its callers.
import { execSync } from "node:child_process";

const MIN_GAP_MS = 2500;
const MAX_GAP_MS = 8000;
let gap = 3000;

let token;
function auth() {
  token ??= process.env.GITHUB_TOKEN;
  if (!token) {
    try {
      token = execSync("gh auth token", { encoding: "utf8" }).trim();
    } catch {
      throw new Error("No GitHub token: set GITHUB_TOKEN or log in with `gh auth login`.");
    }
  }
  return token;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A GraphQL limit hit pauses every caller, not only the one that hit it, so parallel
// workers do not keep the limit alive.
let graphqlPauseUntil = 0;

async function request(url, init = {}, { attempts = 8, search = false } = {}) {
  const gql = !search && init.method === "POST";
  for (let attempt = 1; ; attempt++) {
    if (gql && graphqlPauseUntil > Date.now()) await sleep(graphqlPauseUntil - Date.now());
    let res;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${auth()}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "ai-model-radar",
          ...init.headers,
        },
      });
    } catch (e) {
      // The connection dropped: retried like a timeout.
      if (attempt >= attempts) throw e;
      process.stderr.write(`  connection failed (${e.cause?.code ?? e.message}), retrying\n`);
      await sleep(10_000 * attempt);
      continue;
    }
    if (res.ok) {
      let body;
      try {
        body = await res.json();
      } catch (e) {
        // A response cut off mid-way: retried like a timeout.
        if (attempt < attempts) {
          process.stderr.write("  truncated response from GitHub, retrying\n");
          await sleep(5000 * attempt);
          continue;
        }
        const error = new Error(`GitHub truncated response for ${url.slice(0, 120)}`);
        error.status = 502;
        throw error;
      }
      if (search) gap = Math.max(MIN_GAP_MS, gap - 50);
      return body;
    }
    const limited = res.status === 403 || res.status === 429;
    if (attempt < attempts && (limited || res.status >= 500)) {
      let wait = 10_000 * attempt; // 5xx: the query timed out
      if (limited) {
        if (search) gap = Math.min(MAX_GAP_MS, gap + 1000);
        const retryAfter = Number(res.headers.get("retry-after"));
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        wait = 60_000;
        if (retryAfter) wait = retryAfter * 1000 + 1000;
        else if (res.headers.get("x-ratelimit-remaining") === "0" && reset) wait = Math.max(reset * 1000 - Date.now(), 0) + 2000;
        attempt--; // a rate limit always clears; only failures count against attempts
        if (gql) {
          if (graphqlPauseUntil > Date.now()) continue; // another caller already paused everyone
          graphqlPauseUntil = Date.now() + wait;
        }
      }
      process.stderr.write(`  ${res.status} from GitHub, waiting ${Math.round(wait / 1000)} s\n`);
      await sleep(wait);
      continue;
    }
    const error = new Error(`GitHub ${res.status} for ${url.slice(0, 120)}: ${(await res.text()).slice(0, 200)}`);
    error.status = res.status;
    throw error;
  }
}

let searchSlot = Promise.resolve();

// kind: "commits" | "repositories"
export function search(kind, q, { perPage = 100, page = 1 } = {}) {
  const run = searchSlot.then(async () => {
    const params = new URLSearchParams({ q, per_page: String(perPage), page: String(page) });
    try {
      return await request(`https://api.github.com/search/${kind}?${params}`, {}, { search: true });
    } finally {
      await sleep(gap);
    }
  });
  searchSlot = run.catch(() => {});
  return run;
}

// A missing repository comes back as null data; any other error (typically a
// timeout reported with status 200) throws, so a partial answer is never taken as
// complete.
export async function graphql(query, variables, { attempts = 8 } = {}) {
  const data = await request("https://api.github.com/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  }, { attempts });
  const errors = (data.errors ?? []).filter((e) => e.type !== "NOT_FOUND");
  if (errors.length || !data.data) {
    const error = new Error(`GraphQL: ${JSON.stringify(data.errors).slice(0, 300)}`);
    error.status = 502;
    throw error;
  }
  return data.data;
}
