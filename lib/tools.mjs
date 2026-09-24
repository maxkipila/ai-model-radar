// AI coding tools.
//   sig      the tool's automatic signature: its co-author or author identity in a
//            commit, or the footer it writes ("Generated with [Claude Code]")
//   named    the tool named in an explicit disclosure ("Assisted-by: Codex (GPT-5)",
//            "Model: GPT-6. Harness: Codex.")
//   queries  commit-search phrases for the public mode (none: disclosure only)
//   lab      the model maker implied when no model is named
// Order matters: the first tool whose `named` matches a disclosure wins.
export const TOOLS = [
  { id: "claude-code", name: "Claude Code", lab: "Anthropic", queries: ['"noreply@anthropic.com"'],
    sig: /noreply@anthropic\.com|generated with \[?claude code/i, named: /\bclaude[\s-]?code\b/i },
  { id: "codex", name: "Codex", lab: "OpenAI", queries: ['"noreply@openai.com"', '"codex@openai.com"'],
    sig: /(noreply|codex)@openai\.com|chatgpt\.com\/codex\/tasks/i, named: /\bcodex\b/i },
  { id: "cursor", name: "Cursor", queries: ['"cursoragent@cursor.com"'],
    sig: /cursoragent@cursor\.com/i, named: /\bcursor\b/i },
  { id: "copilot", name: "GitHub Copilot", queries: ['"Copilot@users.noreply.github.com"'],
    sig: /\+Copilot@users\.noreply\.github\.com|copilot@github\.com/i, named: /\bcopilot\b/i },
  { id: "devin", name: "Devin", queries: ['"devin-ai-integration"'],
    sig: /devin-ai-integration|generated with \[devin\]/i, named: /\bdevin\b/i },
  { id: "jules", name: "Jules", lab: "Google", queries: ['"google-labs-jules"'],
    sig: /google-labs-jules/i, named: /\bjules\b/i },
  { id: "gemini", name: "Gemini CLI", lab: "Google", queries: ['"gemini@google.com"', '"gemini-code-assist"'],
    sig: /gemini[.@]google\.com|gemini-code-assist/i, named: /\bgemini[\s-]?cli\b|\bantigravity\b/i },
  { id: "amp", name: "Amp", queries: ['"amp@ampcode.com"'], sig: /@ampcode\.com/i, named: /\bamp\b/i },
  { id: "factory", name: "Factory", queries: ['"factory-droid"'], sig: /factory-droid/i, named: /\bfactory droid\b/i },
  { id: "opencode", name: "OpenCode", queries: ['"noreply@opencode.ai"'],
    sig: /@opencode\.ai|generated with \[opencode\]/i, named: /\bopen[\s-]?code\b/i },
  { id: "aider", name: "Aider", queries: ['"aider@aider.chat"'], sig: /@aider\.chat/i, named: /\baider\b/i },
  { id: "grok", name: "Grok Build", lab: "xAI", queries: ['"noreply@x.ai"'], sig: /(noreply|grok)@x\.ai/i, named: /\bgrok[\s-]?(cli|build)\b/i },
  { id: "kiro", name: "Kiro", queries: ['"kiro-agent"'], sig: /kiro-agent/i, named: /\bkiro\b/i },
  { id: "crush", name: "Crush", queries: [], sig: /crush@charm\.land/i, named: /\bcrush\b/i },
  { id: "hermes", name: "Hermes Agent", queries: [], named: /\bhermes[\s-]?agent\b/i },
  { id: "windsurf", name: "Windsurf", queries: [], named: /\bwindsurf\b/i },
  { id: "cline", name: "Cline", queries: [], named: /\bcline\b/i },
  { id: "roo", name: "Roo Code", queries: [], named: /\broo[\s-]?code\b/i },
  { id: "kilo", name: "Kilo Code", queries: [], named: /\bkilo[\s-]?code\b/i },
  { id: "goose", name: "Goose", queries: [], named: /\bgoose\b/i },
];
