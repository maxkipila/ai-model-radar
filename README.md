# AI models on GitHub

Which AI coding tools and models write the code that lands in serious open-source
projects, measured from what the commits and pull requests themselves say.

## Use

```
node collect.mjs                       # both modes since 2026-06-22, then rebuild
node collect.mjs --since 2025-01-06    # longer history
node collect.mjs --only big            # or --only public
node build.mjs                         # rebuild site/data.js from the cache only
```

Open `site/index.html` in a browser. Needs Node 20+ and a GitHub token, taken from
`GITHUB_TOKEN` or from `gh auth token`. The cache lives in `data/` (not in git);
later runs fetch only what is new.

## Two modes

- **Big projects**: every active public repository with 10,000+ stars that contains
  code (no forks, archives, mirrors). Every commit that landed on the default branch
  is read, together with the AI lines of its merged pull request. Complete counts,
  no sampling. Commits by bots other than AI agents (dependabot, release bots) are
  left out entirely.
- **All public**: GitHub commit search over all public repositories. Per tool and
  week it gives the number of commits carrying the tool's signature, and a sample of
  them is read; figures are count × share of the sample. A search over millions of
  commits returns a partial, fluctuating count, so such weeks are split into days
  (and days into halves) until every count is complete.

## What counts

- **Signature**: written automatically by a tool (`Co-authored-by: Claude Opus 5
  <noreply@anthropic.com>`, `Co-authored-by: Cursor <cursoragent@cursor.com>`,
  `Generated with [Claude Code]`).
- **Disclosure**: written on purpose (`Assisted-by: Codex (GPT-5)` trailers,
  `Model: GPT-6. Harness: Codex.` lines in pull requests). A "Model" line counts only
  with its colon and when short, so feature descriptions are not taken as disclosures;
  a reviewing model is not counted as an author.

Views, the same in both modes:

- **Tools**: commits carrying a tool's signature or naming it in a disclosure.
- **Models**: within one tool only, the models it names. Tools sign differently
  (Claude Code always names the model, Cursor, Copilot and Devin never, Codex only
  when the author discloses it), so models of different tools are never ranked
  together.
- **Labs** (big projects only): Anthropic vs OpenAI vs Google, from every AI commit
  of a project that discloses AI use on purpose at least 3 times, since there tools
  that never sign are visible too. Counting disclosures alone would be unfair the
  other way: in T3 Code, Codex users write "Model: GPT-6" while Claude Code mostly
  leaves only its signature. For the same reason there is no Labs view for all
  public: search can pick single commits, not whole projects, and the commits that
  disclose are mostly those whose tool does not sign.

A commit with several attribution lines is split between them by line count.
Every figure covers the last four complete weeks. Big projects also show the
projects using a tool or model, the median lines changed per commit, and the share of
commits later reverted, with the same figures for all AI commits and for commits
without AI as the baseline.

## Limits

- Public repositories only; private company code is invisible.
- The panel is the projects that are big and active today.
- Squash merges without the trailers and pull requests without a description leave
  no trace, whatever tool wrote them.

## Publish

`node publish.mjs` pushes the `site/` folder alone to the public repository
`maxkipila/ai-model-radar`, served by GitHub Pages at
https://maxkipila.github.io/ai-model-radar/. The code and `data/` stay local.
