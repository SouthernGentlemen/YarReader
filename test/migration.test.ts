import assert from "node:assert/strict";
import { lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { migrateLegacy } from "../src/migration.js";
import { inspectSource } from "../src/adapters.js";
import { archive } from "../src/archive.js";
import { classify } from "../src/classification.js";
import { normalize } from "../src/normalization.js";
import { scan } from "../src/scanner.js";
import { fixtureCbz, png, temporaryStore, writeJson } from "./helpers.js";

test("legacy migration copies originals, creates labeled recovery bundles, and deletes nothing", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  const originals = path.join(root, "legacy-originals");
  const original = await fixtureCbz(root, path.join(originals, "Original Series 001.cbz"), "Original Series", 1);
  const missingPath = path.join(originals, "already-missing.cbz");
  const looseOriginal = path.join(originals, "Loose Original");
  await png(path.join(looseOriginal, "001.png"), "#444");
  await import("node:fs/promises").then((fs) => fs.writeFile(path.join(looseOriginal, "metadata.txt"), "preserved"));
  const normalizedRoot = path.join(root, "legacy-normalized");
  await png(path.join(normalizedRoot, "Recovery Series", "0002", "0001.webp"), "#111");
  await png(path.join(normalizedRoot, "Recovery Series", "0002", "0002.webp"), "#222");
  await png(path.join(normalizedRoot, "Recovery Series", "0002", "thumb.webp"), "#333");
  const legacyCatalog = path.join(root, "legacy-catalog.json");
  await writeJson(legacyCatalog, {
    units: {
      "Original Series/0001": { identity: { id: "Original Series/0001", seriesSlug: "original-series" }, source: { path: original }, pinned: { series: "Original Series", issue: 1 }, state: { pageCount: 2 } },
      "Recovery Series/0002": { identity: { id: "Recovery Series/0002", seriesSlug: "recovery-series" }, source: { path: missingPath }, pinned: { series: "Recovery Series", issue: 2 }, state: { pageCount: 2 } }
    }
  });
  const result = await migrateLegacy(store, { legacyCatalogPath: legacyCatalog, normalizedRoot, originalRoots: [originals], execute: true });
  assert.equal(result.copiedOriginals, 1);
  assert.equal(result.originalBundles, 1);
  assert.equal(result.recoveryBundles, 1);
  assert.equal(result.missingUnits, 0);
  assert.ok(await lstat(original), "legacy original remains");
  assert.ok(await lstat(path.join(normalizedRoot, "Recovery Series", "0002", "0001.webp")), "legacy page remains");
  const sourceNames = await readdir(paths.source);
  assert.ok(sourceNames.includes("Original Series 001.cbz"));
  assert.ok(sourceNames.includes("legacy-originals - Loose Original.cbz"));
  assert.ok(sourceNames.some((name) => name.startsWith("Legacy Recovery - Recovery Series - 0002")));
  const recoveryName = sourceNames.find((name) => name.startsWith("Legacy Recovery - Recovery Series - 0002"))!;
  const recoveryInspection = await inspectSource(path.join(paths.source, recoveryName));
  assert.equal(recoveryInspection.metadata.unitType, "issue");
  assert.equal(recoveryInspection.metadata.sequence, 2);
  assert.ok(await lstat(result.legacyCatalogBackup));
  assert.ok(await lstat(result.record!));
  assert.equal(Object.keys((await store.load()).sources).length, 0, "migration stages inbox artifacts but starts no inherited catalog records");

  await scan(store, 0);
  await classify(store);
  await normalize(store);
  await archive(store);
  await assert.rejects(lstat(path.join(paths.source, "Original Series 001.cbz")));
  const rerun = await migrateLegacy(store, { legacyCatalogPath: legacyCatalog, normalizedRoot, originalRoots: [originals], execute: true });
  assert.equal(rerun.copiedOriginals, 0, "an archived original is not copied back into the inbox");
  assert.ok(rerun.existingOriginals >= 1);
  await assert.rejects(lstat(path.join(paths.source, "Original Series 001.cbz")));
});

test("migration dry-run reports missing units without writing source", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  const legacyCatalog = path.join(root, "legacy-catalog.json");
  await writeJson(legacyCatalog, { units: { "Lost/0001": { source: { path: path.join(root, "missing.cbz") }, state: { pageCount: 20 } } } });
  const result = await migrateLegacy(store, { legacyCatalogPath: legacyCatalog, normalizedRoot: path.join(root, "none"), originalRoots: [] });
  assert.equal(result.dryRun, true);
  assert.equal(result.missingUnits, 1);
  assert.deepEqual(await readdir(paths.source), []);
});
