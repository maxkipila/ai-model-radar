// Big projects: every active public repository with 10,000+ stars that contains
// code, read completely: each commit on its default branch and each merged pull
// request, stored as GitHub returned them.
//
// Line counts triple the cost of every query (GitHub computes the diff), so they are
// fetched in a second pass only for the commits the current rules attribute to AI
// and for a fixed twentieth of all commits (lib/graph.mjs) as the baseline. Every run
// checks stored repositories too, so a changed rule gets its line counts filled in.
import { mkdirSync, writeFileSync } from "node:fs";
import { search, graphql, sleep } from "./github.mjs";
import { readGz, writeGz } from "./store.mjs";
import { attributeCommits, inSample } from "./graph.mjs";

export const MIN_STARS = 10_000;
const ACTIVE_DAYS = 90;
const WORKERS = 3;
const PANEL_MAX_AGE = 24 * 3600_000;
const LINES_BATCH = 25;
const DAY = 864e5;

// No language means no code (lists, docs); a mirror duplicates another repository.
export const inPanel = (r) => r.stargazers_count >= MIN_STARS && !!r.language && !r.mirror_url && !r.fork && !r.archived;
export const repoFile = (dir, name) => new URL(`repos/${name.replace("/", "__")}.json.gz`, dir);

const HISTORY = `query($owner:String!,$name:String!,$since:GitTimestamp!,$after:String,$n:Int!){
  repository(owner:$owner,name:$name){ defaultBranchRef{ name target{ ... on Commit{
    history(first:$n,since:$since,after:$after){ pageInfo{hasNextPage endCursor}
      nodes{ oid committedDate authoredDate message
        author{name email user{login}} committer{name email} parents(first:2){nodes{oid}} } } } } } }
  rateLimit{ remaining resetAt } }`;
const PULLS = `query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:MERGED,first:100,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{ number title body createdAt mergedAt updatedAt headRefName baseRefName
        author{login} mergeCommit{oid} } } }
  rateLimit{ remaining resetAt } }`;

// Repository search returns at most 1,000 results, so the star range is halved
// until every slice fits. The items are kept whole.
export async function collectPanel(dir) {
  const cached = readGz(new URL("panel.json.gz", dir));
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < PANEL_MAX_AGE) return cached.items.filter(inPanel);
  const pushed = new Date(Date.now() - ACTIVE_DAYS * DAY).toISOString().slice(0, 10);
  const items = new Map();
  async function slice(lo, hi) {
    const q = `stars:${lo}..${hi} archived:false fork:false pushed:>=${pushed}`;
    const first = await search("repositories", q);
    if (first.total_count > 1000 && hi > lo) {
      const mid = Math.floor((lo + hi) / 2);
      await slice(lo, mid);
      await slice(mid + 1, hi);
      return;
    }
    for (const r of first.items) items.set(r.full_name, r);
    for (let page = 2; (page - 1) * 100 < Math.min(first.total_count, 1000); page++) {
      for (const r of (await search("repositories", q, { page })).items) items.set(r.full_name, r);
    }
  }
  await slice(MIN_STARS, 1_000_000);
  const panel = [...items.values()].sort((a, b) => b.stargazers_count - a.stargazers_count);
  writeGz(new URL("panel.json.gz", dir), { fetchedAt: new Date().toISOString(), items: panel });
  console.log(`big: ${panel.filter(inPanel).length} projects with ${MIN_STARS}+ stars`);
  return panel.filter(inPanel);
}

let pauseUntil = 0;
async function gql(query, variables) {
  if (pauseUntil > Date.now()) await sleep(pauseUntil - Date.now());
  const data = await graphql(query, variables, { attempts: 3 });
  if (data.rateLimit?.remaining < 100) {
    pauseUntil = Date.parse(data.rateLimit.resetAt) + 5000;
    console.log(`big: GraphQL budget spent, pausing until ${data.rateLimit.resetAt}`);
  }
  return data;
}

async function fetchHistory(owner, name, since) {
  const commits = [];
  let after = null;
  let n = 100;
  for (;;) {
    let data;
    try {
      data = await gql(HISTORY, { owner, name, since, after, n });
    } catch (e) {
      // Pages with huge diffs time out; smaller pages get through.
      if (e.status >= 500 && n > 10) {
        n = Math.max(10, n >> 1);
        continue;
      }
      throw e;
    }
    const history = data.repository?.defaultBranchRef?.target?.history;
    if (!history) break;
    for (const c of history.nodes) {
      commits.push({
        oid: c.oid, date: c.committedDate, authored: c.authoredDate, message: c.message,
        author: { name: c.author?.name, email: c.author?.email, login: c.author?.user?.login ?? null },
        committer: { name: c.committer?.name, email: c.committer?.email },
        parents: c.parents.nodes.map((p) => p.oid),
      });
    }
    if (!history.pageInfo.hasNextPage) break;
    after = history.pageInfo.endCursor;
    n = Math.min(100, n * 2);
  }
  return commits;
}

async function fetchPulls(owner, name, since) {
  const prs = [];
  let after = null;
  for (;;) {
    const data = await gql(PULLS, { owner, name, after });
    const page = data.repository?.pullRequests;
    if (!page) break;
    let done = false;
    for (const pr of page.nodes) {
      if (pr.updatedAt < since) {
        done = true;
        break;
      }
      if (!pr.mergedAt || pr.mergedAt < since) continue;
      prs.push({
        number: pr.number, title: pr.title, body: pr.body, createdAt: pr.createdAt, mergedAt: pr.mergedAt,
        head: pr.headRefName, base: pr.baseRefName,
        author: pr.author?.login ?? null, mergeCommit: pr.mergeCommit?.oid ?? null,
      });
    }
    if (done || !page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return prs;
}

const needLines = (data) => attributeCommits(data)
  .filter(({ c, automation, entries }) => !automation && c.additions == null && (entries.length || inSample(c.oid)))
  .map(({ c }) => c);

async function fetchLines(owner, name, commits) {
  for (let i = 0; i < commits.length; i += LINES_BATCH) {
    const batch = commits.slice(i, i + LINES_BATCH);
    const fields = batch.map((c, j) => `c${j}: object(oid: "${c.oid}") { ... on Commit { additions deletions } }`).join("\n");
    const data = await gql(`query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ ${fields} } rateLimit{ remaining resetAt } }`, { owner, name });
    batch.forEach((c, j) => {
      const r = data.repository?.[`c${j}`];
      if (r) [c.additions, c.deletions] = [r.additions, r.deletions];
    });
  }
}

async function collectRepo(dir, repo, since) {
  const [owner, name] = repo.full_name.split("/");
  const file = repoFile(dir, repo.full_name);
  const old = readGz(file);
  if (old && old.since <= since && Date.now() - Date.parse(old.fetchedAt) < 12 * 3600_000) {
    const missing = needLines(old);
    if (!missing.length) return null;
    await fetchLines(owner, name, missing);
    writeGz(file, old);
    return { commits: 0, prs: 0, lines: missing.length };
  }
  // Refetch a few days back so commits pushed late are caught.
  const incremental = old && old.since <= since;
  const from = incremental ? new Date(Date.parse(old.fetchedAt) - 3 * DAY).toISOString() : since;
  const fetchedAt = new Date().toISOString();
  const commits = await fetchHistory(owner, name, from);
  const prs = await fetchPulls(owner, name, from);
  const byOid = new Map((incremental ? old.commits : []).map((c) => [c.oid, c]));
  for (const c of commits) byOid.set(c.oid, c);
  const byNumber = new Map((incremental ? old.prs : []).map((p) => [p.number, p]));
  for (const p of prs) byNumber.set(p.number, p);
  const data = {
    repo: repo.full_name, since: incremental ? old.since : since, fetchedAt,
    commits: [...byOid.values()], prs: [...byNumber.values()],
  };
  const missing = needLines(data);
  await fetchLines(owner, name, missing);
  writeGz(file, data);
  return { commits: commits.length, prs: prs.length, lines: missing.length };
}

export async function collectBig(dataDir, sinceDate) {
  const dir = new URL("big/", dataDir);
  mkdirSync(new URL("repos/", dir), { recursive: true });
  const since = `${sinceDate}T00:00:00Z`;
  // The build counts from the start of the latest run; stored repositories reaching
  // further back keep their older commits for a later, longer run.
  writeFileSync(new URL("meta.json", dir), JSON.stringify({ since }));
  const panel = await collectPanel(dir);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < panel.length) {
      const repo = panel[next++];
      try {
        const r = await collectRepo(dir, repo, since);
        done++;
        if (r) console.log(`big ${done}/${panel.length}  ${repo.full_name}  ${r.commits} commits, ${r.prs} merged PRs, ${r.lines} line counts`);
      } catch (e) {
        done++;
        console.error(`big ${done}/${panel.length}  ${repo.full_name}  skipped: ${e.message.slice(0, 160)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
}
