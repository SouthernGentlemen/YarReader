import assert from "node:assert/strict";
import { lstat, readFile, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { acquireFile, acquireHttp, acquirePages } from "../src/acquisition.js";
import { createServer } from "node:http";
import { once } from "node:events";
import { archive } from "../src/archive.js";
import { classify } from "../src/classification.js";
import { exportLibrary, validateActiveExport } from "../src/export.js";
import { initializePaths } from "../src/paths.js";
import { normalize } from "../src/normalization.js";
import { scan } from "../src/scanner.js";
import { listZip } from "../src/zip.js";
import { fixtureCbz, png, temporaryStore } from "./helpers.js";

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
