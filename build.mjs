// Turns the stored data of both modes into site/data.js. Every rule runs here, on
// the data as GitHub returned it, so a changed rule needs only a rebuild.
//
// Views, the same in both modes:
//   tools   commits carrying a tool's signature or a disclosure naming the tool
//   models  within one tool, the models it names; a commit naming no model is "~"
//   labs    big projects only: every AI commit of a project that discloses AI use on
//           purpose (Assisted-by trailers, "Model:" lines in pull requests) at least
//           DECLARING_MIN times, since there tools that never sign are visible too.
//           Not in all public: search can pick single commits, not whole projects,
//           and a commit that discloses is mostly one whose tool does not sign
//           (Codex), which overstates that tool's lab.
// A commit with several attribution lines is split between them by line count.
//
// Big projects are counted completely. All public is estimated: for one query and
// part of a week, `total` commits match and a sample was read, so every figure is
// total × the share of the sample that carries it.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { TOOLS } from "./lib/tools.mjs";
import { attribute, isAutomation, relevantLines, revertOf, authorText } from "./lib/attribution.mjs";
import { inPanel, repoFile } from "./lib/big.mjs";
import { readGz } from "./lib/store.mjs";
import { attributeCommits, inSample } from "./lib/graph.mjs";

const root = new URL(".", import.meta.url);
const DAY = 864e5;
const WINDOW = 4; // weeks behind the leaderboard and every point of the history chart
const DECLARING_MIN = 3;
const TOP_PROJECTS = 8;

export function completeWeeks(from, now = Date.now()) {
  const weeks = [];
  const start = new Date(`${from.slice(0, 10)}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  for (let t = start.getTime(); t + 7 * DAY <= now; t += 7 * DAY) weeks.push(new Date(t).toISOString().slice(0, 10));
  return weeks;
}

const readJson = (url, fallback) => (existsSync(url) ? JSON.parse(readFileSync(url, "utf8")) : fallback);
const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

function series(weeks) {
  const zeros = () => new Array(weeks.length).fill(0);
  const out = { tools: {}, models: {}, labs: {} };
  const add = (bucket, key, w, v) => ((bucket[key] ??= zeros())[w] += v);
  return {
    out,
    tool: (id, w, v) => add(out.tools, id, w, v),
    model: (tool, model, w, v) => add((out.models[tool] ??= {}), model ?? "~", w, v),
    lab: (lab, w, v) => add(out.labs, lab, w, v),
    round(digits) {
      const r = (b) => Object.keys(b).forEach((k) => (b[k] = b[k].map((v) => round(v, digits))));
      r(out.tools);
      r(out.labs);
      Object.values(out.models).forEach(r);
    },
  };
}

// Splits one commit's attribution into view entries with weights.
function views(entries, { labs = true } = {}) {
  const tools = [...new Set(entries.filter((e) => e.tool).map((e) => e.tool))];
  const models = [];
  for (const tool of tools) {
    const named = entries.filter((e) => e.tool === tool && e.model);
    const lines = named.reduce((s, e) => s + e.n, 0);
    if (!lines) models.push([tool, null, 1]);
    for (const e of named) models.push([tool, e.model, e.n / lines]);
  }
  const known = labs ? entries.filter((e) => e.lab) : [];
  const lines = known.reduce((s, e) => s + e.n, 0);
  const labShares = new Map();
  for (const e of known) labShares.set(e.lab, (labShares.get(e.lab) ?? 0) + e.n / lines);
  return { tools, models, labs: [...labShares] };
}

class Stats {
  c = 0;
  reverted = 0;
  lines = [];
  repos = new Map();
  add(repo, sha, lines, reverted, w) {
    this.c += w;
    if (reverted) this.reverted += w;
    if (lines != null) this.lines.push(lines);
    const r = this.repos.get(repo) ?? { n: 0, shas: [] };
    r.n += w;
    if (r.shas.length < 3) r.shas.push(sha);
    this.repos.set(repo, r);
  }
  finish() {
    const sorted = this.lines.sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : 0;
    const top = [...this.repos].sort((a, b) => b[1].n - a[1].n).slice(0, TOP_PROJECTS)
      .map(([repo, r]) => [repo, round(r.n, 1), r.shas]);
    return { c: round(this.c, 1), p: this.repos.size, ml: median, rv: this.c ? round(this.reverted / this.c, 4) : 0, top };
  }
}

function buildBig(weeks, weekOf, modelLabs) {
  const dir = new URL("data/big/", root);
  const panel = readGz(new URL("panel.json.gz", dir), { items: [] }).items.filter(inPanel);
  const s = series(weeks);
  const zeros = () => new Array(weeks.length).fill(0);
  const total = zeros();
  const ai = zeros();
  const stats = new Map();
  const stat = (key) => stats.get(key) ?? stats.set(key, new Stats()).get(key);
  const windowStart = weeks.length - WINDOW;
  let active = 0;
  let declaringProjects = 0;
  let read = 0;

  for (const { full_name: repo } of panel) {
    const data = readGz(repoFile(dir, repo));
    if (!data) continue;
    read++;
    const reverts = data.commits.map((c) => revertOf(c.message)).filter(Boolean);
    const exact = new Set(reverts.filter((r) => r.length === 40));
    const short = reverts.filter((r) => r.length < 40);
    const isReverted = (oid) => exact.has(oid) || short.some((r) => oid.startsWith(r));
    const commits = attributeCommits(data).filter(({ automation }) => !automation);
    const declaring = commits.filter(({ entries }) => entries.some((e) => e.declared && e.lab)).length >= DECLARING_MIN;
    if (declaring) declaringProjects++;
    let seen = false;
    for (const { c, entries } of commits) {
      const w = weekOf(c.date.slice(0, 10));
      if (w < 0) continue;
      const inWindow = w >= windowStart;
      // Line counts exist for every commit with a trace of AI and for a fixed sample of
      // the rest (lib/big.mjs); the baselines take their size from the sample only.
      const size = c.additions == null ? null : c.additions + c.deletions;
      const record = (key, weight = 1, baseline = false) =>
        inWindow && stat(key).add(repo, c.oid.slice(0, 12), baseline && !inSample(c.oid) ? null : size, isReverted(c.oid), weight);
      total[w]++;
      record("all", 1, true);
      if (inWindow) seen = true;
      if (!entries.length) {
        record("none", 1, true);
        continue;
      }
      ai[w]++;
      record("ai");
      for (const e of entries) if (e.model) modelLabs[e.model] = e.lab;
      const v = views(entries, { labs: declaring });
      for (const tool of v.tools) {
        s.tool(tool, w, 1);
        record(`tools|${tool}`);
      }
      for (const [tool, model, weight] of v.models) {
        s.model(tool, model, w, weight);
        record(`models|${tool}|${model ?? "~"}`, weight);
      }
      for (const [lab, weight] of v.labs) {
        s.lab(lab, w, weight);
        record(`labs|${lab}`, weight);
      }
    }
    if (seen) active++;
  }

  s.round(2);
  const window = { tools: {}, models: {}, labs: {} };
  for (const [key, st] of stats) {
    const [view, a, b] = key.split("|");
    const value = st.finish();
    if (view === "tools") window.tools[a] = value;
    else if (view === "models") (window.models[a] ??= {})[b] = value;
    else if (view === "labs") window.labs[a] = value;
    else window[view] = value;
  }
  console.log(`big: ${read}/${panel.length} projects read, ${active} active in the last ${WINDOW} weeks, ${declaringProjects} disclose models`);
  return { projects: read, panel: panel.length, active, declaringProjects, total, ai, series: s.out, window };
}

function buildPublic(weeks, weekOf, modelLabs) {
  const dir = new URL("data/weeks/", root);
  const s = series(weeks);
  if (!existsSync(dir)) return { series: s.out };
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json.gz"))) {
    const w = weekOf(f.slice(0, 10));
    if (w < 0) continue;
    const cache = readGz(new URL(f, dir), {});
    const each = (query, fn) => {
      for (const part of cache[query]?.parts ?? []) {
        if (!part.total || !part.samples.length) continue;
        const scale = part.total / part.samples.length;
        for (const sample of part.samples) {
          const author = authorText(sample.author);
          if (isAutomation(author)) continue;
          const entries = attribute(relevantLines(sample.message, { skipFirst: true }), author);
          for (const e of entries) if (e.model) modelLabs[e.model] = e.lab;
          fn(entries, scale);
        }
      }
    };
    for (const tool of TOOLS) {
      for (const query of tool.queries) {
        each(query, (entries, scale) => {
          const own = entries.filter((e) => e.tool === tool.id);
          if (!own.length) return;
          s.tool(tool.id, w, scale);
          for (const [, model, weight] of views(own, { labs: false }).models) s.model(tool.id, model, w, scale * weight);
        });
      }
    }
  }
  s.round(0);
  return { series: s.out };
}

export function build() {
  const starts = [readJson(new URL("data/big/meta.json", root), {}).since];
  const weekFiles = new URL("data/weeks/", root);
  if (existsSync(weekFiles)) starts.push(...readdirSync(weekFiles).map((f) => f.slice(0, 10)));
  const weeks = completeWeeks(starts.filter(Boolean).sort()[0] ?? new Date().toISOString());
  const first = Date.parse(`${weeks[0]}T00:00:00Z`);
  const weekOf = (day) => {
    const w = Math.floor((Date.parse(`${day}T00:00:00Z`) - first) / (7 * DAY));
    return w >= 0 && w < weeks.length ? w : -1;
  };
  const modelLabs = {};
  const data = {
    generated: new Date().toISOString(),
    weeks,
    window: WINDOW,
    tools: TOOLS.map(({ id, name, lab }) => ({ id, name, lab: lab ?? null })),
    big: buildBig(weeks, weekOf, modelLabs),
    public: buildPublic(weeks, weekOf, modelLabs),
    modelLabs,
  };
  mkdirSync(new URL("site/", root), { recursive: true });
  writeFileSync(new URL("site/data.js", root), `window.RADAR = ${JSON.stringify(data)};\n`);
  console.log(`site/data.js: ${weeks.length} weeks, ${Object.keys(modelLabs).length} named models`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) build();
