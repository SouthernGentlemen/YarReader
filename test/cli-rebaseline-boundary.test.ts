import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { projectRoot } from "../src/paths.js";
import { emptyCatalog } from "../src/domain.js";
import { auditLegacyCatalog } from "../src/legacy-audit.js";
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

test("legacy catalog audit reports per-unit identity, page, and curated metadata differences", () => {
  const catalog = emptyCatalog();
  const sourceId = "a".repeat(64);
  catalog.sources[sourceId] = {
    id: sourceId,
    kind: "file",
    format: "cbz",
    size: 10,
    inspection: {
      adapter: "zip",
      format: "cbz",
      metadata: {},
      units: [{ key: "root", label: "Example 1", entryNames: ["1.png"], pageCount: 1, metadata: {}, warnings: [] }],
      warnings: []
    },
    occurrences: ["b".repeat(64)],
    decisions: {},
    discoveredAt: new Date().toISOString(),
    warnings: []
  };
  catalog.units["example/issue-0001"] = {
    id: "example/issue-0001",
    series: "Example",
    seriesSlug: "example",
    unitType: "issue",
    issue: 1,
    sequence: 1,
    title: "New title",
    releases: [{
      sourceId,
      unitKey: "root",
      selected: true,
      normalization: { status: "verified", workRelative: "normalized/example", sourceId, profile: "reader-webp-v1", pageCount: 1, pages: [] }
    }],
    selectedRelease: { sourceId, unitKey: "root" }
  };
  const legacy = { units: { "example/0001": {
    identity: { seriesSlug: "example", segments: [1] },
    source: { path: "/legacy/example.cbz" },
    pinned: { series: "Example", sequence: 1, issue: 1 },
    curated: { title: "Old title", publisher: "Example Press" },
    state: { pageCount: 2 }
  } } };
  const report = auditLegacyCatalog(catalog, legacy);
  assert.equal(report.summary.matched, 1);
  assert.equal(report.summary.pageCountDiscrepancies, 1);
  assert.equal(report.summary.metadataDiscrepancies, 1);
  assert.deepEqual(report.summary.metadataFields, { title: 1, publisher: 1 });
});

test("repository contains no runtime media or catalog state", async () => {
  const entries = new Set(await readdir(projectRoot()));
  for (const forbidden of ["source", "archive", "state", "work", "export", "catalog.json"]) assert.equal(entries.has(forbidden), false, forbidden);
  const packageJson = JSON.parse(await readFile(path.join(projectRoot(), "package.json"), "utf8")) as { bin: Record<string, string> };
  assert.deepEqual(Object.keys(packageJson.bin), ["yar"]);
});
