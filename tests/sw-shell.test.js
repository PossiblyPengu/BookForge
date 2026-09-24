/**
 * The service worker precaches APP_SHELL with a single cache.addAll(). One
 * missing path rejects the whole install, so the worker never activates and
 * the app silently loses offline support. These tests keep the list honest.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const docs = fileURLToPath(new URL("../docs/", import.meta.url));
const sw = readFileSync(docs + "sw.js", "utf8");

const appShell = (() => {
  const body = sw.match(/const APP_SHELL = \[([\s\S]*?)\];/)?.[1];
  if (!body) throw new Error("APP_SHELL not found in sw.js");
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
})();

const cacheVersion = (name) =>
  sw.match(new RegExp(`const ${name} = 'pageturner-[a-z]+-v(\\d+)'`))?.[1];

describe("service worker app shell", () => {
  it("lists paths that all exist on disk", () => {
    const missing = appShell
      .filter((p) => p !== "./") // the navigation request, not a file
      .filter((p) => !existsSync(docs + p.replace(/^\.\//, "")));
    expect(missing).toEqual([]);
  });

  it("has no duplicate entries", () => {
    const dupes = appShell.filter((p, i) => appShell.indexOf(p) !== i);
    expect(dupes).toEqual([]);
  });

  it("precaches every app module, so a cold start works offline", () => {
    const listed = new Set(appShell);
    const missing = readdirSync(docs + "js")
      .filter((f) => f.endsWith(".js"))
      .map((f) => `./js/${f}`)
      .filter((p) => !listed.has(p));
    expect(missing).toEqual([]);
  });

  it("keeps the shell and runtime caches on the same generation", () => {
    // they're bumped together by `npm run version`; drifting apart leaves a
    // stale runtime cache alive after a deploy
    expect(cacheVersion("CACHE_NAME")).toBe(cacheVersion("RUNTIME_CACHE"));
  });

  it("matches the build number the app reports", () => {
    const build = readFileSync(docs + "js/version.js", "utf8").match(/BUILD = (\d+)/)?.[1];
    expect(cacheVersion("CACHE_NAME")).toBe(build);
  });
});
