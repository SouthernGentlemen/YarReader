import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { rebaselineDryRun } from "../src/rebaseline.js";
import { png, temporaryStore } from "./helpers.js";

const execFileAsync = promisify(execFile);

test("single yar CLI initializes and reports the same path authority", async (t) => {
  const { root } = await temporaryStore(t);
  const workspace = path.join(root, "cli-media");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const initialized = JSON.parse((await execFileAsync(process.execPath, [cli, "--workspace", workspace, "init"])).stdout) as { paths: { workspace: string } };
  const reported = JSON.parse((await execFileAsync(process.execPath, [cli, "--workspace", workspace, "paths"])).stdout) as { workspace: string };
  assert.equal(initialized.paths.workspace, workspace);
  assert.equal(reported.workspace, workspace);
});

test("rebaseline dry run inventories loose directories and audits old page counts", async (t) => {
  const { root } = await temporaryStore(t);
  const legacyRoot = path.join(root, "legacy");
  const source = path.join(legacyRoot, "Series 001");
  await png(path.join(source, "001.png"), "#111");
  await png(path.join(source, "002.png"), "#222");
  const legacy = { units: { "series/0001": { source: { path: source, adapter: "images" }, state: { pageCount: 2 } } } };
  const report = await rebaselineDryRun([legacyRoot], legacy);
  assert.equal(report.dryRun, true);
  assert.equal(report.legacyUnitCount, 1);
  assert.equal(report.totals.sources, 1);
  assert.equal(report.totals.pages, 2);
  assert.equal(report.discrepancies.length, 0);
});
