import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { classify, review, type AiClassifier } from "../src/classification.js";
import { ClassificationProposalSchema } from "../src/domain.js";
import { scan } from "../src/scanner.js";
import { createBundleFromFiles } from "../src/zip.js";
import { fixtureCbz, png, temporaryStore } from "./helpers.js";

test("scan requires stable observation and ignores active-download suffixes", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  await fixtureCbz(root, path.join(paths.source, "Complete 001.cbz"));
  await writeFile(path.join(paths.source, "still-writing.cbz.part"), "partial");
  const first = await scan(store, 60);
  assert.equal(first.pending, 1);
  assert.equal(first.ignored, 1);
  assert.equal(Object.keys((await store.load()).sources).length, 0);
  const second = await scan(store, 0);
  assert.equal(second.discovered, 1);
});

test("recursive scan records multiple physical occurrences of identical content", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  const original = await fixtureCbz(root, path.join(paths.source, "a", "Fixture 001.cbz"));
  await mkdir(path.join(paths.source, "b"), { recursive: true });
  const bytes = await import("node:fs/promises").then((fs) => fs.readFile(original));
  await writeFile(path.join(paths.source, "b", "Alternate Name.cbz"), bytes);
  const result = await scan(store, 0);
  assert.equal(result.discovered, 1);
  assert.equal(result.duplicates, 1);
  const catalog = await store.load();
  const source = Object.values(catalog.sources)[0]!;
  assert.equal(source.occurrences.length, 2);
});

test("loose directory inspection creates multiple logical units", async (t) => {
  const { paths, store } = await temporaryStore(t);
  await png(path.join(paths.source, "My Series", "Issue 001", "001.png"), "#111");
  await png(path.join(paths.source, "My Series", "Issue 002", "001.png"), "#222");
  await scan(store, 0);
  const source = Object.values((await store.load()).sources)[0]!;
  assert.equal(source.format, "directory");
  assert.deepEqual(source.inspection.units.map((unit) => unit.key), ["Issue 001", "Issue 002"]);
});

test("collection manifest splits a root-cover bundle into validated chapter units", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  const cover = await png(path.join(root, "collection", "cover.jpg"), "#333");
  const chapter1 = await png(path.join(root, "collection", "one.jpg"), "#111");
  const prologue = await png(path.join(root, "collection", "prologue.jpg"), "#222");
  await createBundleFromFiles([
    { source: cover, name: "cover.jpg" },
    { source: chapter1, name: "0001/pages/0001.jpg" },
    { source: prologue, name: "0001-b/pages/0001.jpg" }
  ], path.join(paths.source, "collected - Manifest Series.cbz"), [{
    name: "manifest.json",
    data: Buffer.from(JSON.stringify({ series: "Manifest Series", chapters: {
      "0001": { displayNumber: "1", pageCount: 1, localPageCount: 1, status: "complete" },
      "0001-b": { displayNumber: "1", pageCount: 1, localPageCount: 1, status: "complete" }
    } }))
  }]);
  await scan(store, 0);
  const source = Object.values((await store.load()).sources)[0]!;
  assert.deepEqual(source.inspection.units.map((unit) => unit.key), ["0001", "0001-b"]);
  assert.equal(source.inspection.units[0]!.metadata.unitType, "chapter");
  assert.equal(source.inspection.units[1]!.metadata.unitType, "special");
  assert.equal(source.inspection.units[1]!.metadata.sequence, 1001);
  const result = await classify(store);
  assert.equal(result.accepted, 2);
  assert.deepEqual(Object.keys((await store.load()).units).sort(), ["manifest-series/chapter-0001", "manifest-series/special-1001"]);
});

test("nested archives are recursively inspected with real page counts", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  const nested = await fixtureCbz(root, path.join(root, "nested", "Nested Series 001.cbz"), "Nested Series", 1);
  await createBundleFromFiles([{ source: nested, name: "Collection/Nested Series 001.cbz" }], path.join(paths.source, "Nested Collection.zip"));
  await scan(store, 0);
  const source = Object.values((await store.load()).sources)[0]!;
  assert.equal(source.inspection.units.length, 1);
  assert.equal(source.inspection.units[0]!.pageCount, 2);
  assert.equal(source.inspection.units[0]!.metadata.series, "Nested Series");
});

test("a loose directory with any partial descendant remains untouched", async (t) => {
  const { paths, store } = await temporaryStore(t);
  await png(path.join(paths.source, "Downloading Series 001", "001.png"), "#111");
  await writeFile(path.join(paths.source, "Downloading Series 001", "002.png.part"), "changing");
  const result = await scan(store, 0);
  assert.equal(result.discovered, 0);
  assert.equal(result.ignored, 1);
  assert.equal(Object.keys((await store.load()).sources).length, 0);
});

test("embedded metadata has classification precedence and auto-accepts", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  await fixtureCbz(root, path.join(paths.source, "bad filename.cbz"), "Embedded Series", 12);
  await scan(store, 0);
  const result = await classify(store);
  assert.equal(result.accepted, 1);
  const unit = Object.values((await store.load()).units)[0]!;
  assert.equal(unit.series, "Embedded Series");
  assert.equal(unit.issue, 12);
});

test("ambiguous unsequenced input remains pending in source", async (t) => {
  const { paths, store } = await temporaryStore(t);
  await png(path.join(paths.source, "Mystery.png"), "#abc");
  await scan(store, 0);
  const result = await classify(store);
  assert.equal(result.pending, 1);
  assert.equal(Object.keys((await store.load()).units).length, 0);
});

test("schema-validated AI proposals persist by unchanged source hash", async (t) => {
  const { paths, store } = await temporaryStore(t);
  await png(path.join(paths.source, "Mystery.png"), "#abc");
  await scan(store, 0);
  let calls = 0;
  const proposal = ClassificationProposalSchema.parse({
    series: "AI Series", seriesSlug: "ai-series", unitType: "chapter", chapter: 7, sequence: 7,
    title: "Found", year: 2026, confidence: 0.97, evidence: ["mock content match"], warnings: [], matchingCatalogCandidates: []
  });
  const ai: AiClassifier = { propose: async () => { calls += 1; return proposal; } };
  assert.equal((await classify(store, { ai })).accepted, 1);
  assert.equal(calls, 1);
  assert.equal((await classify(store, { ai })).accepted, 1);
  assert.equal(calls, 1);
});

test("alternate releases converge on one logical unit", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  await fixtureCbz(root, path.join(paths.source, "release-a.cbz"), "Alternate Series", 4);
  const otherPages = [await png(path.join(root, "other", "1.png"), "#123"), await png(path.join(root, "other", "2.png"), "#456")];
  const { cbz } = await import("./helpers.js");
  await cbz(path.join(paths.source, "release-b.cbz"), otherPages, "Alternate Series", 4);
  await scan(store, 0); await classify(store);
  const units = Object.values((await store.load()).units);
  assert.equal(units.length, 1);
  assert.equal(units[0]!.releases.length, 2);
  assert.equal(units[0]!.releases.filter((release) => release.selected).length, 1);
  const alternate = units[0]!.releases[1]!;
  await review(store, { selectRelease: { unitId: units[0]!.id, sourceId: alternate.sourceId, unitKey: alternate.unitKey } });
  const selected = Object.values((await store.load()).units)[0]!;
  assert.equal(selected.selectedRelease.sourceId, alternate.sourceId);
  assert.equal(selected.releases[1]!.selected, true);
});
