// Publishes site/ to GitHub Pages: commits the current site data and pushes the
// site/ folder alone to the public repository behind the "pages" remote, so the
// code and the downloaded data stay private.
//
//   node publish.mjs
import { execSync } from "node:child_process";

const run = (cmd) => execSync(cmd, { stdio: "inherit", cwd: new URL(".", import.meta.url) });
const changed = execSync("git status --porcelain site", { encoding: "utf8", cwd: new URL(".", import.meta.url) }).trim();
if (changed) {
  run("git add site");
  run('git commit -q -m "Report data" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"');
}
run("git subtree push --prefix site pages main");
