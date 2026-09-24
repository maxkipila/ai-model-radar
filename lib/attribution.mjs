// Reads AI attribution out of a commit message and its pull request description.
//
// Two kinds of evidence:
//   signature  written automatically by a tool, whether or not the tool names the
//              model (Claude Code always does, Cursor and Copilot never do)
//   declared   written on purpose by the author or a project rule: "Assisted-by:"
//              trailers and "Model: GPT-6. Harness: Codex." lines
// Where declarations are the practice, tools that do not sign become visible too,
// which is what makes a comparison across labs fair there.
import { TOOLS } from "./tools.mjs";
import { detectModel, detectLab } from "./models.mjs";

const TRAILER = /^(co-authored-by|assisted-by|generated-by|ai-assisted-by)\s*:\s*(.+)$/i;
// "Model: GPT-6", "Harness: Codex", "Built with GPT-6 in Codex". A bare "Model
// selection ..." describes a feature, so the label needs its colon.
const DISCLOSURE = /^(?:(?:ai\s+)?(?:model(?:s| used)?|model and harness|llm|harness|agent)\s*[:\-–]\s*|(?:built(?: and verified)?|generated|made|created|written|developed|prepared|assisted)\s+(?:with|by|using)\s+)(.+)$/i;
// A reviewing model is not an author: "Model: Claude Opus 5.5, reviewed by GPT-6".
const REVIEW = /\b(review(?:ed|er|s|ing)?|consensus|critique|checked by)\b.*$/i;
// Longer "Model:" lines describe a change ("Model: gpt-5 now streams ..."), not a disclosure.
const MAX_DISCLOSURE = 90;
const REVERT = /this reverts commit ([0-9a-f]{7,40})/i;

// Markdown around a line ("> ", "- **Model:** GPT-6") is not part of it.
const clean = (line) => line.replace(/[*`]/g, "").replace(/^[\s>#\-•]+/, "").trim();
const toolById = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
const signed = (text) => TOOLS.find((t) => t.sig?.test(text));
// The tool mentioned first: "gpt-6-astra (Codex) and claude-fable-5-1 (Claude Code)".
function named(text) {
  let best = null;
  let at = Infinity;
  for (const t of TOOLS) {
    const i = text.search(t.named);
    if (i >= 0 && i < at) [best, at] = [t, i];
  }
  return best;
}

// Lines that can carry attribution in a commit message or PR description. A commit subject ("model: support gpt-5") is never a
// disclosure, so commit messages skip their first line.
export function relevantLines(text, { skipFirst = false } = {}) {
  const out = [];
  for (const raw of (text ?? "").split("\n").slice(skipFirst ? 1 : 0)) {
    const line = clean(raw);
    if (!line || line.length > 300) continue;
    const d = line.match(DISCLOSURE);
    if (TRAILER.test(line) || signed(line) || (d && d[1].length <= MAX_DISCLOSURE)) out.push(line);
  }
  return out;
}

export const revertOf = (message) => message.match(REVERT)?.[1].toLowerCase();

// One searchable string for a stored author: name, email and GitHub login.
export const authorText = (a) => `${a?.name ?? ""} <${a?.email ?? ""}> ${a?.login ?? ""}`;

// An author outside the AI tools that is a bot (dependabot, release bots): the
// commit is automation, not development, and leaves the statistics entirely.
export const isAutomation = (author) => !!author && /\[bot\]/i.test(author) && !signed(author);

// -> [{ tool, model, lab, declared, n }], n = number of lines behind the entry
export function attribute(lines, author) {
  const found = [];
  const add = (tool, text, declared) => {
    const m = detectModel(text);
    if (!tool && !m && !(declared && detectLab(text))) return;
    found.push({ tool: tool ?? null, model: m?.model ?? null, lab: m?.lab ?? null, text, declared });
  };
  for (const line of lines) {
    const t = line.match(TRAILER);
    if (t && t[1].toLowerCase() === "co-authored-by") {
      const tool = signed(t[2]);
      if (tool) add(tool.id, t[2].split("<")[0], false);
      continue;
    }
    if (!t) {
      const tool = signed(line);
      if (tool) {
        // "🤖 Generated with [Claude Code](https://…) (Claude Opus 5.5)"
        add(tool.id, line.replace(/https?:\/\/\S+/g, ""), false);
        continue;
      }
    }
    const value = (t ? t[2] : line.match(DISCLOSURE)?.[1] ?? "").replace(REVIEW, "");
    if (value) add(named(line.replace(REVIEW, ""))?.id, value, true);
  }
  if (author) {
    const tool = signed(author);
    if (tool) add(tool.id, "", false);
  }

  // "Model: GPT-6." and "Harness: Codex." on separate lines are one disclosure.
  const declaredTools = new Set(found.filter((f) => f.declared && f.tool).map((f) => f.tool));
  if (declaredTools.size === 1) {
    const [tool] = declaredTools;
    for (const f of found) if (f.declared && !f.tool) f.tool = tool;
  }
  for (const f of found) f.lab ??= (f.tool && toolById[f.tool].lab) || (f.declared ? detectLab(f.text) : null);

  const merged = new Map();
  for (const f of found) {
    const key = `${f.tool}|${f.model}|${f.declared}`;
    const hit = merged.get(key);
    if (hit) hit.n++;
    else merged.set(key, { tool: f.tool, model: f.model, lab: f.lab, declared: f.declared, n: 1 });
  }
  // An entry without a model is redundant once the same tool names one.
  const withModel = new Set([...merged.values()].filter((e) => e.model).map((e) => `${e.tool}|${e.declared}`));
  return [...merged.values()].filter((e) => e.model || !withModel.has(`${e.tool}|${e.declared}`));
}
