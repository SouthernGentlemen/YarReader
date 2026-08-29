import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import test from "node:test";
import { acquireFile, acquireHttp, acquirePages } from "../src/acquisition.js";
import { createServer } from "node:http";
import { once } from "node:events";
import { archive } from "../src/archive.js";
import { classify } from "../src/classification.js";
import { fetchSeriesCovers } from "../src/covers.js";
import { exportLibrary, materializePortableExport, validateActiveExport } from "../src/export.js";
import { initializePaths } from "../src/paths.js";
import { normalize } from "../src/normalization.js";
import { scan } from "../src/scanner.js";
import { listZip } from "../src/zip.js";
import { fixtureCbz, png, temporaryStore, writeJson } from "./helpers.js";

async function readyFixture(t: Parameters<typeof temporaryStore>[0]) {
  const context = await temporaryStore(t);
  await fixtureCbz(context.root, path.join(context.paths.source, "Fixture 001.cbz"));
  await scan(context.store, 0); await classify(context.store); await normalize(context.store);
  return context;
}

test("transactional export works without JavaScript and progressively enhances under file URLs", async (t) => {
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
  assert.match(html, /<main\b[^>]*\bdata-library\b/);
  assert.ok(html.includes('<a href="library/fixture-series/issue-0001/index.html">'));
  assert.match(html, /class="yar-library-body"/);
  assert.match(html, /ComicLibrary\.start/);
  assert.match(html, /\.\/reader\.css/);
  assert.match(html, /\.\/library\.css/);

  for (const asset of ["reader.js", "library.js", "reader.css", "library.css", "assets/favicon.svg"]) {
    assert.ok(await lstat(path.join(paths.activeExport, asset)), `${asset} should ship with the portable viewer`);
  }

  const catalogScript = await readFile(path.join(paths.activeExport, "catalog.js"), "utf8");
  assert.match(catalogScript, /window\.COMIC_LIBRARY/);
  assert.match(catalogScript, /"cover":"library\/.+\/pages\/000001\.webp"/);
  assert.match(catalogScript, /"thumbnail":"library\/.+\/thumbnail\.webp"/);
  assert.match(catalogScript, /"pageRoot":"pages\/"/);
  assert.match(catalogScript, /"pageDigits":6/);
  assert.match(catalogScript, /"readingMode":"ltr"/);

  const catalog = await store.load();
  const unit = Object.values(catalog.units)[0]!;
  const leaf = await readFile(path.join(paths.activeExport, "library", ...unit.id.split("/"), "index.html"), "utf8");
  const rootPrefix = "../".repeat(unit.id.split("/").length + 1);
  assert.match(leaf, /class="yar-reader-body"/);
  assert.match(leaf, /ComicReader\.start/);
  assert.ok(leaf.includes(`href="${rootPrefix}reader.css"`));
  assert.ok(leaf.includes(`root: "${rootPrefix}"`));
  assert.equal(leaf.match(/<img\b/g)?.length, 2);
  assert.ok(leaf.includes('src="pages/000001.webp"'));
  assert.ok(leaf.includes('src="pages/000002.webp"'));
  const thumbnail = path.join(paths.activeExport, "library", ...unit.id.split("/"), "thumbnail.webp");
  assert.equal((await sharp(thumbnail).metadata()).format, "webp");
});

test("portable export materializes a real directory instead of the active symlink", async (t) => {
  const { root, paths, store } = await readyFixture(t);
  await exportLibrary(store);
  assert.ok((await lstat(paths.activeExport)).isSymbolicLink());

  const destination = path.join(root, "usb", "YarReader");
  const result = await materializePortableExport(store, destination);
  assert.equal(result.units, 1);
  assert.equal(result.pages, 2);
  const info = await lstat(destination);
  assert.ok(info.isDirectory());
  assert.ok(!info.isSymbolicLink());
  const rootHtml = await readFile(path.join(destination, "index.html"), "utf8");
  assert.ok(rootHtml.includes("fixture-series/issue-0001/index.html"));
  const leafHtml = await readFile(path.join(destination, "library", "fixture-series", "issue-0001", "index.html"), "utf8");
  assert.equal(leafHtml.match(/<img\b/g)?.length, 2);
});

test("workspace curation selects a stable continuous scroll reader", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  await fixtureCbz(root, path.join(paths.source, "Example Longform 001.cbz"), "Example Longform", 1);
  await scan(store, 0); await classify(store); await normalize(store);
  await writeJson(paths.curation, {
    schemaVersion: 1,
    series: [{ series: "Example Longform", seriesSlug: "example-longform", readingMode: "scroll", genres: ["Example"] }],
    merges: []
  });
  await exportLibrary(store);

  const catalog = await store.load();
  assert.equal(catalog.seriesMetadata["example-longform"]?.readingMode, "scroll");
  assert.deepEqual(catalog.seriesMetadata["example-longform"]?.genres, ["Example"]);
  const catalogScript = await readFile(path.join(paths.activeExport, "catalog.js"), "utf8");
  assert.match(catalogScript, /"readingMode":"scroll"/);
  assert.match(catalogScript, /"genres":\["Example"\]/);
  assert.match(catalogScript, /"pageSizes":\[\[8,12\],\[8,12\]\]/);
});

test("workspace curation overrides missing source direction", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  await fixtureCbz(root, path.join(paths.source, "Example Manga One 001.cbz"), "Example Manga One", 1);
  await fixtureCbz(root, path.join(paths.source, "Example Manga Two 001.cbz"), "Example Manga Two", 1);
  await scan(store, 0); await classify(store); await normalize(store);
  await writeJson(paths.curation, {
    schemaVersion: 1,
    series: [
      { series: "Example Manga One", seriesSlug: "example-manga-one", readingMode: "rtl", genres: ["Action", "Example"] },
      { series: "Example Manga Two", seriesSlug: "example-manga-two", readingMode: "rtl", genres: ["Example"] }
    ],
    merges: []
  });
  await exportLibrary(store);

  const catalog = await store.load();
  assert.equal(catalog.seriesMetadata["example-manga-one"]?.readingMode, "rtl");
  assert.equal(catalog.seriesMetadata["example-manga-two"]?.readingMode, "rtl");
  assert.deepEqual(catalog.seriesMetadata["example-manga-one"]?.genres, ["Action", "Example"]);
  const catalogScript = await readFile(path.join(paths.activeExport, "catalog.js"), "utf8");
  assert.equal((catalogScript.match(/"readingMode":"rtl"/g) ?? []).length, 2);
});

test("configured issue ranges curate into one collision-free series", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  await fixtureCbz(root, path.join(paths.source, "Example Saga Part One 001.cbz"), "Example Saga Part One", 1);
  await fixtureCbz(root, path.join(paths.source, "Example Saga Part Two 013.cbz"), "Example Saga Part Two", 13);
  await scan(store, 0); await classify(store); await normalize(store);
  await writeJson(paths.curation, {
    schemaVersion: 1,
    series: [{ series: "Example Saga", seriesSlug: "example-saga", readingMode: "ltr", genres: ["Example"] }],
    merges: [{ sourceSlugs: ["example-saga-part-one", "example-saga-part-two"], targetSeries: "Example Saga", targetSeriesSlug: "example-saga" }]
  });
  await exportLibrary(store);

  const catalog = await store.load();
  assert.deepEqual(Object.keys(catalog.units).sort(), ["example-saga/issue-0001", "example-saga/issue-0013"]);
  assert.ok(Object.values(catalog.units).every((unit) => unit.series === "Example Saga" && unit.seriesSlug === "example-saga"));
  assert.equal(catalog.seriesMetadata["example-saga"]?.readingMode, "ltr");
  assert.ok(!catalog.seriesMetadata["example-saga-part-one"]);
  assert.match(await readFile(path.join(paths.activeExport, "catalog.js"), "utf8"), /"seriesSlug":"example-saga","series":"Example Saga"/);
});

test("curated cover fetches are optimized, persisted, and exported", async (t) => {
  const { root, paths, store } = await readyFixture(t);
  const sourceImage = await readFile(await png(path.join(root, "cover.png"), "#579", 120, 80));
  const pageUrl = "https://example.test/fixture";
  const imageUrl = "https://example.test/fixture.png?size=full";
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === pageUrl) return new Response(`<html><head><meta property='og:image' content='${imageUrl.replace("&", "&amp;")}'></head></html>`, { status: 200, headers: { "content-type": "text/html" } });
    if (url === imageUrl) return new Response(sourceImage, { status: 200, headers: { "content-type": "image/png" } });
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
  const fetched = await fetchSeriesCovers(store, { sources: [{ series: "Fixture Series", seriesSlug: "fixture-series", pageUrl }], fetchImpl });
  assert.equal(fetched.updated, 1);
  assert.deepEqual(fetched.failed, []);
  const metadata = await sharp(path.join(paths.covers, "fixture-series.webp")).metadata();
  assert.deepEqual({ width: metadata.width, height: metadata.height, format: metadata.format }, { width: 480, height: 720, format: "webp" });
  await exportLibrary(store);
  assert.ok(await lstat(path.join(paths.activeExport, "covers", "fixture-series.webp")));
  assert.match(await readFile(path.join(paths.activeExport, "catalog.js"), "utf8"), /"seriesCover":"covers\/fixture-series\.webp"/);
});

test("compiled legacy viewer stays self-contained and publishes its browser entry points", async () => {
  const viewerRoot = path.resolve("dist/viewer");
  for (const name of ["reader.js", "library.js"]) {
    const source = await readFile(path.join(viewerRoot, name), "utf8");
    assert.ok(!/^\s*(?:import|export)\s/m.test(source), `${name} must be a plain script`);
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|\bnew\s+WebSocket\b|https?:\/\//.test(source), `${name} must not use the network`);
  }
  assert.match(await readFile(path.join(viewerRoot, "reader.js"), "utf8"), /ComicReader/);
  const library = await readFile(path.join(viewerRoot, "library.js"), "utf8");
  assert.match(library, /ComicLibrary/);
  assert.match(library, /UNIT_PAGE_SIZE = 120/);
  assert.match(library, /Manga \(RTL\)/);
  assert.match(library, /Webtoons \(Scroll\)/);
  assert.match(library, /Filter by genre/);
  const reader = await readFile(path.join(viewerRoot, "reader.js"), "utf8");
  assert.match(reader, /layout-v2:/);
  assert.match(reader, /state\.mode === "scroll"/);
  for (const name of ["reader.css", "library.css"]) {
    const source = await readFile(path.join(viewerRoot, name), "utf8");
    assert.ok(!/@import|url\(\s*['"]?https?:/i.test(source), `${name} must not load remote styles`);
  }
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

test("failed activation leaves the last valid export active and resumes", async (t) => {
  const { root, paths, store } = await readyFixture(t);
  await exportLibrary(store);
  const oldTarget = await readlink(paths.activeExport);
  await fixtureCbz(root, path.join(paths.source, "Fixture 002.cbz"), "Fixture Series", 2);
  await scan(store, 0); await classify(store); await normalize(store);
  await assert.rejects(exportLibrary(store, { beforeActivation: async () => { throw new Error("simulated interruption"); } }), /simulated interruption/);
  assert.equal(await readlink(paths.activeExport), oldTarget);
  assert.equal((await validateActiveExport(store)).units, 1);
  const recovered = await exportLibrary(store);
  assert.equal(recovered.recovered, true);
  assert.equal((await validateActiveExport(store)).units, 2);
});

test("empty work and export rebuild from archive plus catalog state", async (t) => {
  const { paths, store } = await readyFixture(t);
  await archive(store); await exportLibrary(store);
  await rm(paths.work, { recursive: true, force: true });
  await rm(paths.exportRoot, { recursive: true, force: true });
  await initializePaths(paths);
  const normalized = await normalize(store);
  assert.equal(normalized.normalized, 1);
  const rebuilt = await exportLibrary(store);
  assert.equal(rebuilt.units, 1);
  assert.equal((await validateActiveExport(store)).pages, 2);
});

test("file and browser acquisition adapters deposit only into source", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  const external = await fixtureCbz(root, path.join(root, "external", "Acquired.cbz"));
  const result = await acquireFile(store, external, true);
  assert.ok(await lstat(external));
  assert.ok(await lstat(path.join(paths.source, result.relative)));
  assert.equal(Object.keys((await store.load()).sources).length, 0, "acquisition does not bypass scan/classification");
  assert.equal((await store.load()).acquisitions[result.id]!.status, "completed");
});

test("page collector verifies images and creates a durable source CBZ", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  const page1 = await png(path.join(root, "pages", "one.png"), "#135");
  const page2 = await png(path.join(root, "pages", "two.png"), "#246");
  const result = await acquirePages(store, { name: "Collected Issue 009", series: "Collected Issue", number: 9, pages: [{ path: page1 }, { path: page2 }] });
  const bundle = path.join(paths.source, result.relative);
  assert.deepEqual((await listZip(bundle)).filter((entry) => !entry.directory).map((entry) => entry.name), ["000001.png", "000002.png", "ComicInfo.xml"]);
  assert.equal(Object.keys((await store.load()).units).length, 0);
});

test("acquisition rejects incomplete artifacts", async (t) => {
  const { root, store } = await temporaryStore(t);
  const partial = path.join(root, "bad.cbz.part"); await writeFile(partial, "bad");
  await assert.rejects(acquireFile(store, partial), /completed regular file/);
});

test("HTTP acquisition stages a partial in work and activates only the verified source artifact", async (t) => {
  const { root, paths, store } = await temporaryStore(t);
  const fixture = await fixtureCbz(root, path.join(root, "served", "Remote.cbz"));
  const bytes = await readFile(fixture);
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/zip" }); response.end(bytes); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server port");
  const result = await acquireHttp(store, `http://127.0.0.1:${address.port}/Remote.cbz`);
  assert.ok(await lstat(path.join(paths.source, result.relative)));
  assert.equal((await store.load()).acquisitions[result.id]!.status, "completed");
  assert.equal(Object.keys((await store.load()).sources).length, 0);
});
