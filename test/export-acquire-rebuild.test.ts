import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { classify } from "../src/classification.js";
import { exportLibrary, validateActiveExport } from "../src/export.js";
import { normalize } from "../src/normalization.js";
import { scan } from "../src/scanner.js";
import { fixtureCbz, temporaryStore } from "./helpers.js";

async function readyFixture(t: Parameters<typeof temporaryStore>[0]) {
  const context = await temporaryStore(t);
  await fixtureCbz(context.root, path.join(context.paths.source, "Fixture 001.cbz"));
  await scan(context.store, 0); await classify(context.store); await normalize(context.store);
  return context;
}

test("transactional export is complete and portable under file URLs", async (t) => {
  const { paths, store } = await readyFixture(t);
  const built = await exportLibrary(store);
  assert.equal(built.units, 1);
  assert.equal(built.pages, 2);
  const validation = await validateActiveExport(store);
  assert.equal(validation.units, 1);
  assert.ok((await lstat(paths.activeExport)).isSymbolicLink());
  const html = await readFile(path.join(paths.activeExport, "index.html"), "utf8");
  assert.ok(!html.includes("/Users/"));
  assert.ok(!html.includes("fetch("));
});

test("export membership validation is order-independent for fractional identities", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  await fixtureCbz(root, path.join(paths.source, "Fractional 099.5.cbz"), "Fractional", 99.5);
  await fixtureCbz(root, path.join(paths.source, "Fractional 100.cbz"), "Fractional", 100);
  await scan(store, 0); await classify(store); await normalize(store);
  const built = await exportLibrary(store);
  assert.equal(built.units, 2);
  assert.equal((await validateActiveExport(store)).pages, 4);
});
