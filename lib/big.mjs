// Big projects: every active public repository with 10,000+ stars that contains
// code, read completely: each commit on its default branch and each merged pull
// request, stored as GitHub returned them.
//
// Line counts triple the cost of every query (GitHub computes the diff), so they are
// fetched in a second pass only for the commits the current rules attribute to AI
// and for a fixed twentieth of all commits (lib/graph.mjs) as the baseline. Every run
// checks stored repositories too, so a changed rule gets its line counts filled in.
//
// GitHub charges at least one point of its hourly budget per query, however little
// it returns, so an update asks about many repositories per query under aliases:
// first which ones changed since the last run, then the new commits and pull
// requests of those. A repository read for the first time (or further back than
// before) is read on its own.
import { mkdirSync, writeFileSync } from "node:fs";
import { search, graphql, sleep } from "./github.mjs";
import { readGz, writeGz } from "./store.mjs";
import { attributeCommits, inSample } from "./graph.mjs";

export const MIN_STARS = 10_000;
const ACTIVE_DAYS = 90;
const WORKERS = 3;
const PANEL_MAX_AGE = 24 * 3600_000;
const LINES_BATCH = 25;
const CHECK_BATCH = 50;
const UPDATE_BATCH = 20;
const UPDATE_COMMITS = 50; // first page per repository in an update; more pages one by one
const UPDATE_PULLS = 20;
// An update reads back this far before the last run, so commits whose date is older
// than their push (a merged branch) are still caught.
const OVERLAP = 3 * 864e5;
const RECENT = 12 * 3600_000; // read this recently: only missing line counts

// No language means no code (lists, docs); a mirror duplicates another repository.
export const inPanel = (r) => r.stargazers_count >= MIN_STARS && !!r.language && !r.mirror_url && !r.fork && !r.archived;
export const repoFile = (dir, name) => new URL(`repos/${name.replace("/", "__")}.json.gz`, dir);

const COMMIT = "oid committedDate authoredDate message author{name email user{login}} committer{name email} parents(first:2){nodes{oid}}";
const PULL = "number title body createdAt mergedAt updatedAt headRefName baseRefName author{login} mergeCommit{oid}";
const HISTORY = `query($owner:String!,$name:String!,$since:GitTimestamp!,$after:String,$n:Int!){
  repository(owner:$owner,name:$name){ defaultBranchRef{ name target{ ... on Commit{
    history(first:$n,since:$since,after:$after){ pageInfo{hasNextPage endCursor} nodes{ ${COMMIT} } } } } } }
  rateLimit{ remaining resetAt } }`;
const PULLS = `query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:MERGED,first:100,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor} nodes{ ${PULL} } } }
  rateLimit{ remaining resetAt } }`;
const alias = (fullName, i) => {
  const [owner, name] = fullName.split("/");
  return `r${i}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)})`;
};

// Repository search returns at most 1,000 results, so the star range is halved
// until every slice fits. The items are kept whole.
export async function collectPanel(dir) {
  const cached = readGz(new URL("panel.json.gz", dir));
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < PANEL_MAX_AGE) return cached.items.filter(inPanel);
  const pushed = new Date(Date.now() - ACTIVE_DAYS * 864e5).toISOString().slice(0, 10);
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
async function gql(query, variables = {}) {
  if (pauseUntil > Date.now()) await sleep(pauseUntil - Date.now());
  const data = await graphql(query, variables, { attempts: 3 });
  if (data.rateLimit?.remaining < 100) {
    pauseUntil = Date.parse(data.rateLimit.resetAt) + 5000;
    console.log(`big: GraphQL budget spent, pausing until ${data.rateLimit.resetAt}`);
  }
  return data;
}

const toCommit = (c) => ({
  oid: c.oid, date: c.committedDate, authored: c.authoredDate, message: c.message,
  author: { name: c.author?.name, email: c.author?.email, login: c.author?.user?.login ?? null },
  committer: { name: c.committer?.name, email: c.committer?.email },
  parents: c.parents.nodes.map((p) => p.oid),
});

// Adds the pull requests merged since `since`; true once the list, newest update
// first, has gone past it.
function takePulls(nodes, since, prs) {
  for (const pr of nodes) {
    if (pr.updatedAt < since) return true;
    if (!pr.mergedAt || pr.mergedAt < since) continue;
    prs.push({
      number: pr.number, title: pr.title, body: pr.body, createdAt: pr.createdAt, mergedAt: pr.mergedAt,
      head: pr.headRefName, base: pr.baseRefName,
      author: pr.author?.login ?? null, mergeCommit: pr.mergeCommit?.oid ?? null,
    });
  }
  return false;
}

async function fetchHistory(owner, name, since, after = null) {
  const commits = [];
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
    commits.push(...history.nodes.map(toCommit));
    if (!history.pageInfo.hasNextPage) break;
    after = history.pageInfo.endCursor;
    n = Math.min(100, n * 2);
  }
  return commits;
}

async function fetchPulls(owner, name, since, after = null) {
  const prs = [];
  for (;;) {
    const page = (await gql(PULLS, { owner, name, after })).repository?.pullRequests;
    if (!page || takePulls(page.nodes, since, prs) || !page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return prs;
}

const needLines = (data) => attributeCommits(data)
  .filter(({ c, automation, entries }) => !automation && c.additions == null && (entries.length || inSample(c.oid)))
  .map(({ c }) => c);

// Line counts for commits of any repositories, LINES_BATCH per query; a batch that
// times out is halved.
async function fetchLines(items) {
  async function batch(part) {
    const repos = [...new Set(part.map((x) => x.repo))];
    const body = repos.map((repo, r) => `${alias(repo, r)}{ ${part.map((x, j) => (x.repo === repo
      ? `c${j}: object(oid:"${x.commit.oid}"){ ... on Commit{ additions deletions } }` : "")).join(" ")} }`).join("\n");
    let data;
    try {
      data = await gql(`query{ ${body} rateLimit{ remaining resetAt } }`);
    } catch (e) {
      if (e.status >= 500 && part.length > 1) {
        await batch(part.slice(0, part.length >> 1));
        await batch(part.slice(part.length >> 1));
        return;
      }
      throw e;
    }
    part.forEach((x, j) => {
      const r = data[`r${repos.indexOf(x.repo)}`]?.[`c${j}`];
      if (r) [x.commit.additions, x.commit.deletions] = [r.additions, r.deletions];
    });
  }
  for (let i = 0; i < items.length; i += LINES_BATCH) await batch(items.slice(i, i + LINES_BATCH));
}
const linesOf = (data) => needLines(data).map((commit) => ({ repo: data.repo, commit }));

function merge(old, commits, prs, fetchedAt, head) {
  const byOid = new Map(old.commits.map((c) => [c.oid, c]));
  for (const c of commits) byOid.set(c.oid, c);
  const byNumber = new Map(old.prs.map((p) => [p.number, p]));
  for (const p of prs) byNumber.set(p.number, p);
  return { ...old, fetchedAt, head, commits: [...byOid.values()], prs: [...byNumber.values()] };
}

// One repository on its own: the first read, a read further back than before, or
// an update whose batch failed.
async function collectRepo(dir, fullName, since) {
  const [owner, name] = fullName.split("/");
  const file = repoFile(dir, fullName);
  const old = readGz(file);
  const incremental = old && old.since <= since;
  const from = incremental ? new Date(Date.parse(old.fetchedAt) - OVERLAP).toISOString() : since;
  const fetchedAt = new Date().toISOString();
  const commits = await fetchHistory(owner, name, from);
  const prs = await fetchPulls(owner, name, from);
  const data = merge(incremental ? old : { repo: fullName, since, commits: [], prs: [] }, commits, prs, fetchedAt, old?.head);
  const missing = linesOf(data);
  await fetchLines(missing);
  writeGz(file, data);
  return { commits: commits.length, prs: prs.length, lines: missing.length };
}

// Runs fn over the items in chunks, WORKERS chunks at a time.
async function chunked(items, size, fn) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  let next = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (next < chunks.length) await fn(chunks[next++]);
  }));
}

export async function collectBig(dataDir, sinceDate) {
  const dir = new URL("big/", dataDir);
  mkdirSync(new URL("repos/", dir), { recursive: true });
  const since = `${sinceDate}T00:00:00Z`;
  // The build counts from the start of the latest run; stored repositories reaching
  // further back keep their older commits for a later, longer run.
  writeFileSync(new URL("meta.json", dir), JSON.stringify({ since }));
  const panel = await collectPanel(dir);
  const whole = []; // read on its own
  const changed = [];
  let unchanged = 0;
  let failed = 0;
  const log = (fullName, r) => console.log(`big  ${fullName}  ${r.commits} commits, ${r.prs} merged PRs, ${r.lines} line counts`);
  const single = async (fullName) => {
    try {
      log(fullName, await collectRepo(dir, fullName, since));
    } catch (e) {
      failed++;
      console.error(`big  ${fullName}  skipped: ${e.message.slice(0, 160)}`);
    }
  };

  // 1. Which stored repositories have a new commit on the default branch or an
  // updated merged pull request since they were read.
  await chunked(panel.map((r) => r.full_name), CHECK_BATCH, async (names) => {
    const checkedAt = new Date().toISOString();
    const stored = [];
    for (const fullName of names) {
      const old = readGz(repoFile(dir, fullName));
      if (!old || old.since > since) whole.push(fullName);
      else stored.push(fullName);
    }
    if (!stored.length) return;
    let data;
    try {
      data = await gql(`query{ ${stored.map((n, i) => `${alias(n, i)}{ defaultBranchRef{ target{ oid } }
        pullRequests(states:MERGED,first:1,orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ updatedAt } } }`).join("\n")}
        rateLimit{ remaining resetAt } }`);
    } catch (e) {
      console.error(`big  check failed for ${stored.length} projects, reading them one by one: ${e.message.slice(0, 160)}`);
      changed.push(...stored);
      return;
    }
    const lines = [];
    const quiet = [];
    stored.forEach((fullName, i) => {
      const r = data[`r${i}`];
      if (!r) return; // gone or renamed: keep what is stored
      const old = readGz(repoFile(dir, fullName));
      const head = r.defaultBranchRef?.target?.oid ?? null;
      const knownHead = head === old.head || (!old.head && old.commits.some((c) => c.oid === head));
      const pullsQuiet = !(r.pullRequests.nodes[0]?.updatedAt > old.fetchedAt);
      if (Date.now() - Date.parse(old.fetchedAt) < RECENT || (knownHead && pullsQuiet)) {
        if (knownHead && pullsQuiet) Object.assign(old, { fetchedAt: checkedAt, head });
        quiet.push(old);
        lines.push(...linesOf(old));
      } else changed.push(fullName);
    });
    unchanged += quiet.length;
    try {
      await fetchLines(lines);
    } catch (e) {
      console.error(`big  line counts failed for ${lines.length} commits: ${e.message.slice(0, 160)}`);
    }
    for (const old of quiet) writeGz(repoFile(dir, old.repo), old);
  });
  console.log(`big: ${changed.length} changed, ${unchanged} unchanged, ${whole.length} to read whole`);

  // 2. New commits and pull requests of the changed ones, UPDATE_BATCH per query;
  // longer lists continue page by page.
  let updated = 0;
  await chunked(changed, UPDATE_BATCH, async (names) => {
    const fetchedAt = new Date().toISOString();
    const olds = names.map((fullName) => readGz(repoFile(dir, fullName)));
    const froms = olds.map((old) => new Date(Date.parse(old.fetchedAt) - OVERLAP).toISOString());
    let data;
    try {
      data = await gql(`query{ ${names.map((n, i) => `${alias(n, i)}{
        defaultBranchRef{ target{ ... on Commit{ oid
          history(first:${UPDATE_COMMITS},since:${JSON.stringify(froms[i])}){ pageInfo{hasNextPage endCursor} nodes{ ${COMMIT} } } } } }
        pullRequests(states:MERGED,first:${UPDATE_PULLS},orderBy:{field:UPDATED_AT,direction:DESC}){ pageInfo{hasNextPage endCursor} nodes{ ${PULL} } } }`).join("\n")}
        rateLimit{ remaining resetAt } }`);
    } catch (e) {
      console.error(`big  update failed for ${names.length} projects, reading them one by one: ${e.message.slice(0, 160)}`);
      for (const fullName of names) await single(fullName);
      return;
    }
    const results = [];
    for (const [i, fullName] of names.entries()) {
      const r = data[`r${i}`];
      if (!r) continue;
      const [owner, name] = fullName.split("/");
      try {
        const target = r.defaultBranchRef?.target;
        const commits = (target?.history.nodes ?? []).map(toCommit);
        if (target?.history.pageInfo.hasNextPage) commits.push(...await fetchHistory(owner, name, froms[i], target.history.pageInfo.endCursor));
        const prs = [];
        if (!takePulls(r.pullRequests.nodes, froms[i], prs) && r.pullRequests.pageInfo.hasNextPage) {
          prs.push(...await fetchPulls(owner, name, froms[i], r.pullRequests.pageInfo.endCursor));
        }
        results.push({ data: merge(olds[i], commits, prs, fetchedAt, target?.oid ?? null), commits: commits.length, prs: prs.length });
      } catch (e) {
        failed++;
        console.error(`big  ${fullName}  skipped: ${e.message.slice(0, 160)}`);
      }
    }
    const lines = results.flatMap((x) => linesOf(x.data));
    try {
      await fetchLines(lines);
    } catch (e) {
      console.error(`big  line counts failed for ${lines.length} commits: ${e.message.slice(0, 160)}`);
    }
    for (const x of results) {
      writeGz(repoFile(dir, x.data.repo), x.data);
      updated++;
    }
    console.log(`big  updated ${updated}/${changed.length}  (last batch: ${results.reduce((s, x) => s + x.commits, 0)} commits, ${results.reduce((s, x) => s + x.prs, 0)} merged PRs, ${lines.length} line counts)`);
  });

  // 3. Repositories read whole.
  let next = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (next < whole.length) await single(whole[next++]);
  }));
  console.log(`big: ${unchanged} unchanged, ${updated} updated, ${whole.length} read whole, ${failed} failed`);
}
