import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatalogStore } from "../src/catalog.js";
import { CatalogSchema } from "../src/domain.js";
import { safeJoin } from "../src/fs.js";
import { initializePaths, projectRoot, resolvePaths } from "../src/paths.js";
import { temporaryStore } from "./helpers.js";

test("path authority resolves every runtime tree outside the repository", async (t) => {
  const { paths } = await temporaryStore(t);
  assert.equal(paths.source, path.join(paths.workspace, "source"));
  assert.equal(paths.activeExport, path.join(paths.workspace, "export", "library-001"));
  assert.ok(!paths.workspace.startsWith(projectRoot()));
});

test("path authority rejects a runtime workspace inside the repository", async () => {
  await assert.rejects(resolvePaths(path.join(projectRoot(), "runtime")), /must not overlap/);
});

test("safeJoin rejects traversal", () => {
  assert.throws(() => safeJoin("/tmp/safe", "..", "escape"), /Unsafe path/);
});

test("initialization rejects a symlinked runtime root", async (t) => {
  const { root } = await temporaryStore(t);
  const workspace = path.join(root, "symlink-workspace");
  await mkdir(workspace);
  await symlink(os.tmpdir(), path.join(workspace, "source"));
  const paths = await resolvePaths(workspace);
  await assert.rejects(initializePaths(paths), /Symbolic link traversal|Unsafe runtime root/);
});

test("catalog writes are schema validated and durable JSON", async (t) => {
  const { paths, store } = await temporaryStore(t);
  const catalog = await store.load();
  await store.save(catalog);
  const parsed = CatalogSchema.parse(JSON.parse(await readFile(paths.catalog, "utf8")));
  assert.equal(parsed.schemaVersion, 1);
  assert.ok(parsed.revision >= 2);
  assert.equal(await store.exists(), true);
});

test("catalog rejects malformed external state", async (t) => {
  const { paths } = await temporaryStore(t);
  await writeFile(paths.catalog, '{"schemaVersion":1,"revision":"bad"}');
  const store = new CatalogStore(paths);
  await assert.rejects(store.load());
});
