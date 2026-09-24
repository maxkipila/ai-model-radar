// Commit graph of one repository's default branch, as stored by lib/big.mjs, and the
// AI attribution of its commits.
import { attribute, authorText, isAutomation, relevantLines } from "./attribution.mjs";

// The first-parent line of the default branch, from its newest tip.
export function mainlineOf(commits, byOid) {
  const parents = new Set(commits.flatMap((c) => c.parents));
  const head = commits.filter((c) => !parents.has(c.oid)).reduce((a, c) => (!a || c.date > a.date ? c : a), null);
  const line = new Set();
  for (let c = head; c && !line.has(c.oid); c = byOid.get(c.parents[0])) line.add(c.oid);
  return line;
}

// A pull request's commits on the default branch: its squash or rebase commit, or
// for a merge commit everything the second parent brought in, down to the
// first-parent line.
export function prCommits(pr, byOid, mainline) {
  const merge = byOid.get(pr.mergeCommit);
  if (!merge) return [];
  if (merge.parents.length < 2) return [merge.oid];
  const out = [];
  const seen = new Set();
  const stack = [merge.parents[1]];
  while (stack.length && out.length < 1000) {
    const oid = stack.pop();
    if (seen.has(oid) || mainline.has(oid)) continue;
    seen.add(oid);
    const c = byOid.get(oid);
    if (!c) continue;
    out.push(oid);
    stack.push(...c.parents);
  }
  return out;
}

// A fixed twentieth of all commits, picked by hash so the pick never changes: the
// unbiased baseline for commit size.
export const inSample = (oid) => parseInt(oid.slice(0, 2), 16) < 13;

// Every commit that is not a merge, with the attribution read from its message and
// from the description of the pull request that brought it.
export function attributeCommits(data) {
  const byOid = new Map(data.commits.map((c) => [c.oid, c]));
  const mainline = mainlineOf(data.commits, byOid);
  const prLines = new Map();
  for (const pr of data.prs) {
    const lines = relevantLines(pr.body);
    if (!lines.length) continue;
    for (const oid of prCommits(pr, byOid, mainline)) prLines.set(oid, [...(prLines.get(oid) ?? []), ...lines]);
  }
  const out = [];
  for (const c of data.commits) {
    if (c.parents.length > 1) continue; // a merge commit carries no change of its own
    const author = authorText(c.author);
    const automation = isAutomation(author);
    const lines = [...relevantLines(c.message, { skipFirst: true }), ...(prLines.get(c.oid) ?? [])];
    out.push({ c, automation, entries: automation ? [] : attribute(lines, author) });
  }
  return out;
}
