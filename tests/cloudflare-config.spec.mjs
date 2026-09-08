import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("line-bot-external has a reproducible Cloudflare Worker build", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const wranglerPath = resolve(root, "wrangler.jsonc");

  assert.equal(pkg.type, "module");
  assert.equal(pkg.engines.node, ">=22");
  assert.equal(pkg.scripts["build:vinext"], "vinext build");
  assert.ok(existsSync(wranglerPath));

  const wrangler = JSON.parse(readFileSync(wranglerPath, "utf8"));
  assert.equal(wrangler.name, "line-bot-external");
  assert.equal(wrangler.compatibility_date, "2026-09-08");
  assert.ok(wrangler.compatibility_flags.includes("nodejs_compat"));
  assert.equal(wrangler.main, "vinext/server/fetch-handler");
});
