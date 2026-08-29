import assert from "node:assert/strict";
import { copyFile, lstat, readFile, rename } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { archive, type ArchiveIO } from "../src/archive.js";
import { classify } from "../src/classification.js";
import { hashDirectory, sha256File } from "../src/fs.js";
import { normalize, verifyNormalization } from "../src/normalization.js";
import { scan } from "../src/scanner.js";
import { createBundleFromFiles, listZip } from "../src/zip.js";
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

test("archive commits only after every logical unit verifies", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  await fixtureCbz(root, path.join(paths.source, "Fixture 001.cbz"));
  await scan(store, 0); await classify(store);
  assert.equal((await archive(store)).waiting, 1);
  assert.ok(await lstat(path.join(paths.source, "Fixture 001.cbz")));
  await normalize(store);
  const result = await archive(store);
  assert.equal(result.archived, 1);
  const catalog = await store.load();
  const occurrence = Object.values(catalog.occurrences)[0]!;
  assert.equal(occurrence.status, "archived");
  assert.equal(await sha256File(path.join(paths.archive, occurrence.archiveRelative!)), occurrence.sourceId);
  await assert.rejects(lstat(path.join(paths.source, "Fixture 001.cbz")));
});

test("loose directories become verified lossless bundles preserving relative names", async (t) => {
  const { paths, store } = await temporaryStore(t);
  const sourceDirectory = path.join(paths.source, "Loose Series 001");
  await png(path.join(sourceDirectory, "pages", "001.png"), "#111");
  await png(path.join(sourceDirectory, "pages", "002.png"), "#222");
  await import("node:fs/promises").then((fs) => fs.writeFile(path.join(sourceDirectory, "notes.txt"), "preserved"));
  const sourceHash = (await hashDirectory(sourceDirectory)).sha256;
  await scan(store, 0); await classify(store); await normalize(store);
  const result = await archive(store);
  assert.equal(result.archived, 1);
  const occurrence = Object.values((await store.load()).occurrences)[0]!;
  const bundle = path.join(paths.archive, occurrence.archiveRelative!);
  const names = (await listZip(bundle)).filter((entry) => !entry.directory).map((entry) => entry.name);
  assert.deepEqual(names, ["notes.txt", "pages/001.png", "pages/002.png"]);
  assert.equal(occurrence.sourceId, sourceHash);
  await assert.rejects(lstat(sourceDirectory));
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
