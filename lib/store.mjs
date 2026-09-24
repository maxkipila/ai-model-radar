// The cache in data/ keeps what GitHub returned in full (whole commit messages, pull
// request descriptions, authors, parents), gzipped. Every rule that reads it runs in
// build.mjs, so changing a rule never needs a new download.
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";

export const readGz = (url, fallback = null) => (existsSync(url) ? JSON.parse(gunzipSync(readFileSync(url))) : fallback);

// Written to a temporary file first, so an interrupted run never leaves a broken one.
export function writeGz(url, data) {
  const tmp = new URL(`${url.href}.tmp`);
  writeFileSync(tmp, gzipSync(JSON.stringify(data)));
  renameSync(tmp, url);
}
