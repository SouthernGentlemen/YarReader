import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { classify } from "../src/classification.js";
import { normalize, verifyNormalization } from "../src/normalization.js";
import { scan } from "../src/scanner.js";
import { createBundleFromFiles } from "../src/zip.js";
import { fixtureCbz, png, temporaryStore } from "./helpers.js";

test("accepted CBZ pages normalize and verify", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  await fixtureCbz(root, path.join(paths.source, "Fixture 001.cbz"));
  await scan(store, 0); await classify(store);
  const result = await normalize(store);
  assert.equal(result.normalized, 1);
  const release = Object.values((await store.load()).units)[0]!.releases[0]!;
  assert.equal(release.normalization!.pageCount, 2);
  assert.equal(await verifyNormalization(store, release.normalization!), true);
});

test("same-source variants of one logical unit use collision-free normalization paths", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  const nested = await fixtureCbz(root, path.join(root, "inner", "Variant 001.cbz"), "Variant Collection", 1);
  await createBundleFromFiles([
    { source: nested, name: "Variant Collection 001 preview.cbz" },
    { source: nested, name: "Variant Collection 001 digital.cbz" },
    { source: nested, name: "Variant Collection 001 covers.cbz" }
  ], path.join(paths.source, "Variant Collection.zip"));
  await scan(store, 0); await classify(store);
  const result = await normalize(store);
  assert.equal(result.failed.length, 0);
  assert.equal(result.normalized, 3);
  const releases = Object.values((await store.load()).units)[0]!.releases;
  assert.equal(releases.length, 3);
  assert.equal(new Set(releases.map((release) => release.normalization!.workRelative)).size, 3);
  for (const release of releases) assert.equal(await verifyNormalization(store, release.normalization!), true);
});

test("misnamed duplicate ComicInfo XML is not treated as a corrupt image page", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  const first = await png(path.join(root, "pages", "0002.png"), "#111");
  const second = await png(path.join(root, "pages", "0003.png"), "#222");
  await createBundleFromFiles([
    { source: first, name: "Fixture/0002.png" },
    { source: second, name: "Fixture/0003.png" }
  ], path.join(paths.source, "Fixture 001.cbz"), [{
    name: "Fixture/0001.jpg",
    data: Buffer.from("<?xml version='1.0'?><ComicInfo><Series>Fixture</Series></ComicInfo>")
  }]);
  await scan(store, 0); await classify(store);
  const result = await normalize(store);
  assert.equal(result.failed.length, 0);
  const catalog = await store.load();
  const release = Object.values(catalog.units)[0]!.releases[0]!;
  assert.equal(release.normalization!.pageCount, 2);
  assert.equal(Object.values(catalog.sources)[0]!.inspection.units[0]!.pageCount, 2);
});

test("normalization detects missing or changed pages", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  await fixtureCbz(root, path.join(paths.source, "Fixture 001.cbz"));
  await scan(store, 0); await classify(store); await normalize(store);
  const release = Object.values((await store.load()).units)[0]!.releases[0]!;
  const page = path.join(paths.work, release.normalization!.workRelative, release.normalization!.pages[0]!.file);
  const bytes = await readFile(page); bytes[0] = bytes[0]! ^ 0xff;
  await import("node:fs/promises").then((fs) => fs.writeFile(page, bytes));
  assert.equal(await verifyNormalization(store, release.normalization!), false);
});
