// Turns the stored data of both modes into site/data.js. Every rule runs here, on
// the data as GitHub returned it, so a changed rule needs only a rebuild.
//
// Time runs in complete UTC days up to yesterday. The history chart shows every day
// as the sum of the TRAIL days ending with it; the ranking and the key figures cover
// one of the FRAMES.
//
// Views, the same in both modes:
//   tools   commits carrying a tool's signature or a disclosure naming the tool
//   models  the models a tool names, per tool and for all tools together ("*");
//           a commit naming no model is "~"
//   labs    big projects only: every AI commit of a project that discloses AI use on
//           purpose (Assisted-by trailers, "Model:" lines in pull requests) at least
//           DECLARING_MIN times, since there tools that never sign are visible too.
//           Not in all public: search can pick single commits, not whole projects,
//           and a commit that discloses is mostly one whose tool does not sign
//           (Codex), which overstates that tool's lab.
// A commit with several attribution lines is split between them by line count.
//
// Big projects are counted completely. All public is estimated: for one query and
// part of a day, `total` commits match and a sample was read, so every figure is
// total × the share of the sample that carries it.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { TOOLS } from "./lib/tools.mjs";
import { revertOf, authorText, attribute, isAutomation, relevantLines } from "./lib/attribution.mjs";
import { inPanel, repoFile } from "./lib/big.mjs";
import { readGz } from "./lib/store.mjs";
import { attributeCommits, inSample } from "./lib/graph.mjs";

const root = new URL(".", import.meta.url);
const DAY = 864e5;
const TRAIL = 7;
const FRAMES = [["1w", 7], ["1m", 30], ["3m", 91], ["all", Infinity]];
const DECLARING_MIN = 3;
const TOP_PROJECTS = 8;

// UTC days from `from` to yesterday: the complete days.
export function completeDays(from, now = Date.now()) {
  const days = [];
  for (let t = Date.parse(`${from.slice(0, 10)}T00:00:00Z`); t + DAY <= now; t += DAY) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

const readJson = (url, fallback) => (existsSync(url) ? JSON.parse(readFileSync(url, "utf8")) : fallback);
const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

// Per view: tools, models by tool (and "*" for all tools), labs; key → daily values.
function series(n) {
  const zeros = () => new Array(n).fill(0);
  const out = { tools: {}, models: {}, labs: {} };
  const add = (bucket, key, d, v) => ((bucket[key] ??= zeros())[d] += v);
  return {
    out,
    tool: (id, d, v) => add(out.tools, id, d, v),
    model: (tool, model, d, v) => add((out.models[tool] ??= {}), model ?? "~", d, v),
    lab: (lab, d, v) => add(out.labs, lab, d, v),
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
  const split = (named, tool) => {
    const lines = named.reduce((s, e) => s + e.n, 0);
    for (const e of named) models.push([tool, e.model, e.n / lines]);
  };
  for (const tool of tools) {
    const named = entries.filter((e) => e.tool === tool && e.model);
    if (named.length) split(named, tool);
    else models.push([tool, null, 1]);
  }
  if (tools.length) {
    const named = entries.filter((e) => e.tool && e.model);
    if (named.length) split(named, "*");
    else models.push(["*", null, 1]);
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
    return { c: round(this.c, 1), ml: median, rv: this.c ? round(this.reverted / this.c, 4) : 0, top };
  }
}

// Nested output for keys "view|a|b": { tools: {a}, models: {a: {b}}, labs: {a}, all, ai, ... }.
function nest(entries) {
  const out = { tools: {}, models: {}, labs: {} };
  for (const [key, value] of entries) {
    const [view, a, b] = key.split("|");
    if (view === "tools") out.tools[a] = value;
    else if (view === "models") (out.models[a] ??= {})[b] = value;
    else if (view === "labs") out.labs[a] = value;
    else out[view] = value;
  }
  return out;
}

function buildBig(days, dayOf) {
  const dir = new URL("data/big/", root);
  const panel = readGz(new URL("panel.json.gz", dir), { items: [] }).items.filter(inPanel);
  // Commits before the latest run's start exist only for the projects read by an
  // earlier, longer run, so they would undercount those days.
  const since = readJson(new URL("meta.json", dir), {}).since ?? "";
  const start = Math.max(0, dayOf(since.slice(0, 10)));
  const n = days.length;
  const s = series(n);
  const total = new Array(n).fill(0);
  const ai = new Array(n).fill(0);
  const frames = FRAMES.map(([id, len]) => [id, Math.max(start, n - len)]);
  const stats = new Map(); // "frame|view|a|b" → Stats
  const stat = (key) => stats.get(key) ?? stats.set(key, new Stats()).get(key);
  const seen = new Map(); // "view|a|b" → per day, the projects seen
  const mark = (key, d, r) => {
    let byDay = seen.get(key);
    if (!byDay) seen.set(key, (byDay = days.map(() => new Set())));
    byDay[d].add(r);
  };
  const modelLabs = {};
  let read = 0;
  let declaringProjects = 0;

  for (const [r, { full_name: repo }] of panel.entries()) {
    const data = readGz(repoFile(dir, repo));
    if (!data) continue;
    read++;
    const reverts = data.commits.map((c) => revertOf(c.message)).filter(Boolean);
    const exact = new Set(reverts.filter((x) => x.length === 40));
    const short = reverts.filter((x) => x.length < 40);
    const isReverted = (oid) => exact.has(oid) || short.some((x) => oid.startsWith(x));
    const commits = attributeCommits(data).filter(({ automation }) => !automation);
    const declaring = commits.filter(({ entries }) => entries.some((e) => e.declared && e.lab)).length >= DECLARING_MIN;
    if (declaring) declaringProjects++;
    for (const { c, entries } of commits) {
      const d = dayOf(c.date.slice(0, 10));
      if (d < start) continue;
      // Line counts exist for every commit with a trace of AI and for a fixed sample of
      // the rest (lib/big.mjs); the baselines take their size from the sample only.
      const size = c.additions == null ? null : c.additions + c.deletions;
      const reverted = isReverted(c.oid);
      const record = (key, weight = 1, baseline = false) => {
        mark(key, d, r);
        for (const [id, from] of frames) {
          if (d >= from) stat(`${id}|${key}`).add(repo, c.oid.slice(0, 12), baseline && !inSample(c.oid) ? null : size, reverted, weight);
        }
      };
      total[d]++;
      record("all", 1, true);
      if (declaring) mark("declaring", d, r);
      if (!entries.length) {
        record("none", 1, true);
        continue;
      }
      ai[d]++;
      record("ai");
      for (const e of entries) if (e.model) modelLabs[e.model] = e.lab;
      const v = views(entries, { labs: declaring });
      for (const tool of v.tools) {
        s.tool(tool, d, 1);
        record(`tools|${tool}`);
      }
      for (const [tool, model, weight] of v.models) {
        s.model(tool, model, d, weight);
        record(`models|${tool}|${model ?? "~"}`, weight);
      }
      for (const [lab, weight] of v.labs) {
        s.lab(lab, d, weight);
        record(`labs|${lab}`, weight);
      }
    }
  }

  // Distinct projects: for the chart over the TRAIL days ending with each day, for
  // the ranking over each frame.
  const union = (byDay, from, to) => {
    const set = new Set();
    for (let d = Math.max(from, 0); d <= to; d++) for (const r of byDay[d]) set.add(r);
    return set.size;
  };
  const used = nest([...seen].map(([key, byDay]) => [key, byDay.map((_, d) => (d < start ? 0 : union(byDay, Math.max(start, d - TRAIL + 1), d)))]));
  const byFrame = {};
  for (const [id, from] of frames) {
    const statsOf = [...stats].filter(([key]) => key.startsWith(`${id}|`)).map(([key, st]) => [key.slice(id.length + 1), st.finish()]);
    byFrame[id] = {
      stats: nest(statsOf),
      used: nest([...seen].map(([key, byDay]) => [key, union(byDay, from, n - 1)])),
    };
  }
  s.round(2);
  console.log(`big: ${read}/${panel.length} projects read, ${declaringProjects} disclose AI use`);
  return { data: { start, projects: read, panel: panel.length, total, ai, series: s.out, used, frames: byFrame }, modelLabs };
}

function buildPublic(days, dayOf) {
  const dir = new URL("data/days/", root);
  const s = series(days.length);
  const modelLabs = {};
  let start = days.length;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json.gz"))) {
      const d = dayOf(f.slice(0, 10));
      if (d < 0) continue;
      const cache = readGz(new URL(f, dir), {});
      for (const tool of TOOLS) {
        for (const query of tool.queries) {
          for (const part of cache[query]?.parts ?? []) {
            if (!part.total || !part.samples.length) continue;
            start = Math.min(start, d);
            const scale = part.total / part.samples.length;
            for (const sample of part.samples) {
              const author = authorText(sample.author);
              if (isAutomation(author)) continue;
              const own = attribute(relevantLines(sample.message, { skipFirst: true }), author).filter((e) => e.tool === tool.id);
              if (!own.length) continue;
              for (const e of own) if (e.model) modelLabs[e.model] = e.lab;
              s.tool(tool.id, d, scale);
              for (const [t, model, weight] of views(own, { labs: false }).models) s.model(t, model, d, scale * weight);
            }
          }
        }
      }
    }
  }
  s.round(0);
  return { data: { start, series: s.out }, modelLabs };
}

export function build() {
  const starts = [readJson(new URL("data/big/meta.json", root), {}).since];
  const dayFiles = new URL("data/days/", root);
  if (existsSync(dayFiles)) starts.push(...readdirSync(dayFiles).map((f) => f.slice(0, 10)));
  const days = completeDays(starts.filter(Boolean).sort()[0] ?? new Date().toISOString());
  const first = Date.parse(`${days[0]}T00:00:00Z`);
  const dayOf = (day) => {
    const d = Math.round((Date.parse(`${day}T00:00:00Z`) - first) / DAY);
    return d >= 0 && d < days.length ? d : -1;
  };
  const big = buildBig(days, dayOf);
  const pub = buildPublic(days, dayOf);
  const data = {
    generated: new Date().toISOString(),
    days,
    trail: TRAIL,
    frames: FRAMES.map(([id, len]) => [id, Number.isFinite(len) ? len : null]),
    tools: TOOLS.map(({ id, name, lab }) => ({ id, name, lab: lab ?? null })),
    modelLabs: { ...pub.modelLabs, ...big.modelLabs },
    big: big.data,
    public: pub.data,
  };
  mkdirSync(new URL("site/", root), { recursive: true });
  writeFileSync(new URL("site/data.js", root), `window.RADAR = ${JSON.stringify(data)};\n`);
  console.log(`site/data.js: ${days.length} days (${days[0]} – ${days.at(-1)}), ${Object.keys(data.modelLabs).length} named models`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) build();
