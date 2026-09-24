// Turns the name in an attribution line ("Claude Opus 5 (1M context)",
// "aider (anthropic/claude-sonnet-4-20250514)", "GPT Codex (gpt-6-astra)") into a
// canonical model name and its maker. Returns null when no model is named.
const title = (s) => s.replace(/[-_\s]+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
// "Opus 5.0" is Opus 5.
const ver = (major, minor) => (minor && minor !== "0" ? `${major}.${minor}` : major);

const RULES = [
  // claude-opus-4-5, Claude Sonnet 4.5, claude-sonnet-4-20250514 (date suffix dropped)
  [/claude[-\s]+(opus|sonnet|haiku|fable|mythos)[-\s]+(\d+)(?:[.-](\d{1,2})(?!\d))?/i, (m) => [`Claude ${title(m[1])} ${ver(m[2], m[3])}`, "Anthropic"]],
  // claude-3-5-sonnet, Claude 3.7 Sonnet
  [/claude[-\s]+(\d)(?:[.-](\d)(?!\d))?[-\s]+(opus|sonnet|haiku)/i, (m) => [`Claude ${title(m[3])} ${ver(m[1], m[2])}`, "Anthropic"]],
  [/\bgpt[-\s]?(\d+(?:\.\d+)?)(o)?(?:[-\s]?(codex[-\s]?(?:mini|max)?|mini|nano|pro|sol|luna|astra|turbo))?/i,
    (m) => [`GPT-${m[1].replace(/\.0$/, "")}${m[2] ?? ""}${m[3] ? " " + title(m[3]) : ""}`, "OpenAI"]],
  [/\b(o[134])(?:[-\s](mini|pro))?\b/i, (m) => [`${m[1].toLowerCase()}${m[2] ? "-" + m[2].toLowerCase() : ""}`, "OpenAI"]],
  [/gemini[-\s]?(\d+(?:\.\d+)?)(?:[-\s]?(pro|flash[-\s]?lite|flash|ultra))?/i, (m) => [`Gemini ${m[1]}${m[2] ? " " + title(m[2]) : ""}`, "Google"]],
  [/gemma[-\s]?(\d+(?:\.\d+)?)/i, (m) => [`Gemma ${m[1]}`, "Google"]],
  [/grok[-\s]?code[-\s]?fast(?:[-\s]?(\d+))?/i, (m) => [`Grok Code Fast${m[1] ? " " + m[1] : ""}`, "xAI"]],
  [/grok[-\s]?(\d+(?:\.\d+)?)(?:[-\s]?(fast|mini|heavy))?/i, (m) => [`Grok ${m[1]}${m[2] ? " " + title(m[2]) : ""}`, "xAI"]],
  [/deepseek[-\s]?(v\d+(?:\.\d+)?|r\d+|chat|coder|reasoner)(?:[-\s]?(flash|pro))?/i,
    (m) => [`DeepSeek ${m[1].toUpperCase().replace(/^(CHAT|CODER|REASONER)$/, (w) => title(w.toLowerCase()))}${m[2] ? " " + title(m[2]) : ""}`, "DeepSeek"]],
  [/glm[-\s]?(\d+(?:\.\d+)?)(?:[-\s]?(air|flash))?/i, (m) => [`GLM-${m[1]}${m[2] ? " " + title(m[2]) : ""}`, "Z.ai"]],
  [/qwen[-\s]?(\d+(?:\.\d+)?)(?:[-\s]?(coder|max|plus))?/i, (m) => [`Qwen ${m[1]}${m[2] ? " " + title(m[2]) : ""}`, "Alibaba"]],
  [/kimi[-\s]?(k\d+(?:\.\d+)?)/i, (m) => [`Kimi ${m[1].toUpperCase()}`, "Moonshot"]],
  [/minimax[-\s]?(m\d+(?:\.\d+)?)/i, (m) => [`MiniMax ${m[1].toUpperCase()}`, "MiniMax"]],
  [/mimo[-\s]?v?(\d+(?:\.\d+)?)(?:[-\s]?(pro|flash))?/i, (m) => [`MiMo V${m[1]}${m[2] ? " " + title(m[2]) : ""}`, "Xiaomi"]],
  [/muse[-\s]?spark(?:[-\s](\d+(?:\.\d+)?))?/i, (m) => [`Muse Spark${m[1] ? " " + m[1] : ""}`, "Meta"]],
  [/llama[-\s]?(\d+(?:\.\d+)?)/i, (m) => [`Llama ${m[1]}`, "Meta"]],
  [/(devstral|codestral|magistral)/i, (m) => [title(m[1]), "Mistral"]],
];

// The model named first wins: "gpt-6-astra (Codex) and claude-fable-5-1".
export function detectModel(name) {
  let best = null;
  for (const [re, make] of RULES) {
    const m = name.match(re);
    if (m && (!best || m.index < best.m.index)) best = { m, make };
  }
  if (!best) return null;
  const [model, lab] = best.make(best.m);
  return { model, lab };
}

// The maker named without a recognisable model ("Assisted-by: Claude").
const LABS = [
  [/\b(claude|anthropic)\b/i, "Anthropic"],
  [/\b(gpt|openai|chatgpt|codex)\b/i, "OpenAI"],
  [/\b(gemini|gemma)\b/i, "Google"],
  [/\b(grok|xai)\b/i, "xAI"],
  [/\bdeepseek\b/i, "DeepSeek"],
  [/\b(qwen|alibaba)\b/i, "Alibaba"],
  [/\b(glm|zhipu|z\.ai)\b/i, "Z.ai"],
  [/\b(kimi|moonshot)\b/i, "Moonshot"],
  [/\b(mistral|devstral|codestral)\b/i, "Mistral"],
  [/\bminimax\b/i, "MiniMax"],
];

export function detectLab(text) {
  return LABS.find(([re]) => re.test(text))?.[1] ?? null;
}
