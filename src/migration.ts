import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { directoryContainsPages, formatFromPath, naturalCompare } from "./adapters.js";
import type { CatalogStore } from "./catalog.js";
import type { Catalog } from "./domain.js";
import { atomicWriteJson, copyFileVerified, hashDirectory, isPartialName, isWithin, safeJoin, sha256File, treeContainsPartial } from "./fs.js";
import { createBundleFromFiles, createStoredBundle, verifyZip } from "./zip.js";

const LegacyUnitSchema = z.object({
  identity: z.object({ id: z.string(), seriesSlug: z.string().optional() }).passthrough().optional(),
  source: z.object({ path: z.string() }).passthrough(),
  inferred: z.record(z.string(), z.unknown()).optional(),
  embedded: z.record(z.string(), z.unknown()).optional(),
  pinned: z.record(z.string(), z.unknown()).optional(),
  curated: z.record(z.string(), z.unknown()).optional(),
  state: z.object({ pageCount: z.number().int().nonnegative().optional() }).passthrough().optional()
}).passthrough();
const LegacyCatalogSchema = z.object({ units: z.record(z.string(), LegacyUnitSchema) }).passthrough();

export interface MigrationItem {
  action: "copied-original" | "already-staged" | "created-original-bundle" | "created-recovery-bundle" | "missing" | "skipped-changing";
  legacyPath: string;
  destination?: string;
  sha256?: string;
  unitId?: string;
  pageCount?: number;
  expectedPageCount?: number;
  note?: string;
}

export interface MigrationResult {
  dryRun: boolean;
  legacyCatalogBackup: string;
  copiedOriginals: number;
  existingOriginals: number;
  originalBundles: number;
  recoveryBundles: number;
  missingUnits: number;
  skippedChanging: number;
  copiedBytes: number;
  items: MigrationItem[];
  record?: string;
}

const IMAGE = /\.(?:jpe?g|png|webp|gif|avif|tiff?|bmp)$/i;

function metadataValue(unit: z.infer<typeof LegacyUnitSchema>, key: string): unknown {
  return unit.curated?.[key] ?? unit.pinned?.[key] ?? unit.embedded?.[key] ?? unit.inferred?.[key];
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function recoveryIdentity(unit: z.infer<typeof LegacyUnitSchema>, unitId: string): { sequence: unknown; unitType: string; number: unknown } {
  const legacySource = unit.source.path.replaceAll("\\", "/");
  const leaf = path.posix.basename(legacySource);
  if (!path.isAbsolute(unit.source.path) && /-b$/i.test(leaf)) {
    const display = Number(leaf.match(/\d+(?:\.\d+)?/)?.[0]);
    if (Number.isFinite(display)) return { sequence: 1000 + display, unitType: "special", number: display };
  }
  if (!path.isAbsolute(unit.source.path) && Number.isFinite(Number(leaf))) {
    const number = Number(leaf);
    return { sequence: number, unitType: "chapter", number };
  }
  const sequence = metadataValue(unit, "sequence") ?? metadataValue(unit, "chapter") ?? metadataValue(unit, "issue") ?? metadataValue(unit, "volume") ?? unitId.split("/").at(-1)?.replace(/^0+/, "");
  const unitType = metadataValue(unit, "issue") !== undefined ? "issue"
    : metadataValue(unit, "chapter") !== undefined ? "chapter"
      : metadataValue(unit, "volume") !== undefined ? "volume" : "issue";
  return { sequence, unitType, number: metadataValue(unit, unitType) ?? sequence };
}

function comicInfo(unit: z.infer<typeof LegacyUnitSchema>, unitId: string, pageCount: number): Buffer {
  const series = String(metadataValue(unit, "series") ?? unit.identity?.seriesSlug ?? unitId.split("/")[0] ?? "Legacy Recovery");
  const identity = recoveryIdentity(unit, unitId);
  const number = identity.number;
  const volume = metadataValue(unit, "volume");
  const title = metadataValue(unit, "title");
  const year = metadataValue(unit, "year");
  return Buffer.from(`<?xml version="1.0" encoding="utf-8"?><ComicInfo><Series>${xmlEscape(series)}</Series><YarReaderUnitType>${identity.unitType}</YarReaderUnitType><YarReaderSequence>${xmlEscape(String(identity.sequence))}</YarReaderSequence>${number === undefined ? "" : `<Number>${xmlEscape(String(number))}</Number>`}${volume === undefined ? "" : `<Volume>${xmlEscape(String(volume))}</Volume>`}${title === undefined ? "" : `<Title>${xmlEscape(String(title))}</Title>`}${year === undefined ? "" : `<Year>${xmlEscape(String(year))}</Year>`}<PageCount>${pageCount}</PageCount><Notes>Recovered from legacy normalized pages because the catalog-recorded original was already missing before greenfield migration.</Notes></ComicInfo>\n`);
}

async function exists(candidate: string): Promise<boolean> {
  try { await lstat(candidate); return true; } catch { return false; }
}

async function catalogedLocation(store: CatalogStore, catalog: Catalog, sourceId: string): Promise<string | undefined> {
  const source = catalog.sources[sourceId];
  if (!source) return undefined;
  for (const occurrenceId of source.occurrences) {
    const occurrence = catalog.occurrences[occurrenceId];
    if (!occurrence) continue;
    const candidate = occurrence.status === "inbox"
      ? safeJoin(store.paths.source, ...occurrence.inboxRelative.split("/"))
      : occurrence.archiveRelative
        ? safeJoin(store.paths.archive, ...occurrence.archiveRelative.split("/"))
        : undefined;
    if (candidate && await exists(candidate)) return candidate;
  }
  return undefined;
}

async function catalogedFilenameLocation(store: CatalogStore, catalog: Catalog, filename: string): Promise<string | undefined> {
  for (const occurrence of Object.values(catalog.occurrences)) {
    if (occurrence.originalFilename !== filename) continue;
    const candidate = occurrence.status === "inbox"
      ? safeJoin(store.paths.source, ...occurrence.inboxRelative.split("/"))
      : occurrence.archiveRelative
        ? safeJoin(store.paths.archive, ...occurrence.archiveRelative.split("/"))
        : undefined;
    if (candidate && await exists(candidate)) return candidate;
  }
  return undefined;
}

async function stableFile(file: string): Promise<{ sha256: string; size: number } | undefined> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || isPartialName(path.basename(file))) return undefined;
  const sha256 = await sha256File(file);
  const after = await lstat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return undefined;
  return { sha256, size: after.size };
}

async function destinationFor(store: CatalogStore, source: string, sha256: string, requestedName?: string): Promise<{ path: string; state: "copy" | "existing" }> {
  const name = requestedName ?? path.basename(source);
  let destination = safeJoin(store.paths.source, name);
  if (await exists(destination)) {
    if (await sha256File(destination) === sha256) return { path: destination, state: "existing" };
    destination = safeJoin(store.paths.source, `${path.basename(name, path.extname(name))}-${sha256.slice(0, 12)}${path.extname(name)}`);
    if (await exists(destination) && await sha256File(destination) === sha256) return { path: destination, state: "existing" };
  }
  return { path: destination, state: "copy" };
}

function migrationFilename(source: string, directory = false): string {
  if (directory) return `${path.basename(path.dirname(source))} - ${path.basename(source)}.cbz`;
  const name = path.basename(source);
  if (/^source\.(?:cbz|cbr|zip|rar|pdf|epub)$/i.test(name)) {
    const unit = path.basename(path.dirname(source));
    const series = path.basename(path.dirname(path.dirname(source)));
    return `${series} - ${unit}${path.extname(name).toLowerCase()}`;
  }
  return name;
}

async function discoverOriginals(store: CatalogStore, roots: string[]): Promise<Array<{ path: string; kind: "file" | "directory" }>> {
  const output: Array<{ path: string; kind: "file" | "directory" }> = [];
  const excluded = [store.paths.source, store.paths.archive, store.paths.state, store.paths.work, store.paths.exportRoot].map((item) => path.resolve(item));
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => naturalCompare(a.name, b.name))) {
      if (isPartialName(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (excluded.some((root) => isWithin(root, path.resolve(absolute)))) continue;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (await directoryContainsPages(absolute)) {
          if (!(await treeContainsPartial(absolute))) output.push({ path: absolute, kind: "directory" });
        } else await walk(absolute);
      } else if (formatFromPath(absolute, false) && !isPartialName(entry.name)) output.push({ path: absolute, kind: "file" });
    }
  }
  for (const root of roots) if (await exists(root)) await walk(path.resolve(root));
  const deduplicated = new Map<string, { path: string; kind: "file" | "directory" }>();
  for (const item of output) deduplicated.set(await realpath(item.path), item);
  return [...deduplicated.values()].sort((a, b) => naturalCompare(a.path, b.path));
}

async function normalizedPages(root: string, unitId: string): Promise<string[] | undefined> {
  const directory = path.join(root, ...unitId.split("/"));
  if (!(await exists(directory))) return undefined;
  const entries = await readdir(directory, { withFileTypes: true });
  const pages = entries.filter((entry) => entry.isFile() && IMAGE.test(entry.name) && !/^(?:thumb|thumbnail|cover-thumb)\./i.test(entry.name)).map((entry) => path.join(directory, entry.name)).sort(naturalCompare);
  return pages.length ? pages : undefined;
}

export async function migrateLegacy(store: CatalogStore, options: {
  legacyCatalogPath: string;
  normalizedRoot: string;
  originalRoots: string[];
  execute?: boolean;
}): Promise<MigrationResult> {
  const execute = options.execute === true;
  const legacyBytes = await readFile(options.legacyCatalogPath);
  const legacyHash = await sha256File(options.legacyCatalogPath);
  const legacy = LegacyCatalogSchema.parse(JSON.parse(legacyBytes.toString("utf8")) as unknown);
  const currentCatalog = await store.load();
  const backupRelative = path.posix.join("rebaseline-backup", `legacy-catalog-${legacyHash}.json`);
  const backup = safeJoin(store.paths.state, ...backupRelative.split("/"));
  if (execute && !(await exists(backup))) await copyFileVerified(options.legacyCatalogPath, backup, legacyHash);
  const result: MigrationResult = {
    dryRun: !execute,
    legacyCatalogBackup: backup,
    copiedOriginals: 0,
    existingOriginals: 0,
    originalBundles: 0,
    recoveryBundles: 0,
    missingUnits: 0,
    skippedChanging: 0,
    copiedBytes: 0,
    items: []
  };

  const originals = new Map<string, { path: string; kind: "file" | "directory" }>();
  for (const item of await discoverOriginals(store, options.originalRoots)) originals.set(await realpath(item.path), item);
  for (const unit of Object.values(legacy.units)) if (await exists(unit.source.path)) {
    const canonical = await realpath(unit.source.path);
    originals.set(canonical, { path: canonical, kind: (await lstat(canonical)).isDirectory() ? "directory" : "file" });
  }
  for (const item of [...originals.values()].sort((a, b) => naturalCompare(a.path, b.path))) {
    const original = item.path;
    if (item.kind === "directory") {
      const before = await hashDirectory(original);
      const filename = migrationFilename(original, true);
      const destination = safeJoin(store.paths.source, filename);
      const cataloged = await catalogedLocation(store, currentCatalog, before.sha256);
      if (cataloged) {
        result.existingOriginals += 1;
        result.items.push({ action: "already-staged", legacyPath: original, destination: cataloged, sha256: before.sha256, note: "Already represented by a physical greenfield catalog occurrence" });
        continue;
      }
      if (execute) {
        const jobRoot = safeJoin(store.paths.work, "migration-originals", before.sha256);
        await rm(jobRoot, { recursive: true, force: true }); await mkdir(jobRoot, { recursive: true });
        const built = path.join(jobRoot, filename);
        const bundle = await createStoredBundle(original, built);
        await verifyZip(built);
        const after = await hashDirectory(original);
        if (after.sha256 !== before.sha256) {
          result.skippedChanging += 1;
          result.items.push({ action: "skipped-changing", legacyPath: original, note: "Loose directory changed while bundling" });
          continue;
        }
        const target = await destinationFor(store, destination, bundle.sha256, filename);
        if (target.state === "copy") await copyFileVerified(built, target.path, bundle.sha256);
      }
      result.originalBundles += 1; result.copiedBytes += before.size;
      result.items.push({ action: "created-original-bundle", legacyPath: original, destination, sha256: before.sha256, note: "Verified lossless bundle; legacy directory preserved" });
      continue;
    }
    const stable = await stableFile(original);
    if (!stable) { result.skippedChanging += 1; result.items.push({ action: "skipped-changing", legacyPath: original }); continue; }
    const cataloged = await catalogedLocation(store, currentCatalog, stable.sha256);
    if (cataloged) {
      result.existingOriginals += 1;
      result.items.push({ action: "already-staged", legacyPath: original, destination: cataloged, sha256: stable.sha256, note: "Already represented by a physical greenfield catalog occurrence" });
      continue;
    }
    const destination = await destinationFor(store, original, stable.sha256, migrationFilename(original));
    if (destination.state === "existing") {
      result.existingOriginals += 1;
      result.items.push({ action: "already-staged", legacyPath: original, destination: destination.path, sha256: stable.sha256 });
    } else {
      if (execute) await copyFileVerified(original, destination.path, stable.sha256);
      result.copiedOriginals += 1; result.copiedBytes += stable.size;
      result.items.push({ action: "copied-original", legacyPath: original, destination: destination.path, sha256: stable.sha256 });
    }
  }

  for (const [unitId, unit] of Object.entries(legacy.units).sort(([a], [b]) => naturalCompare(a, b))) {
    if (await exists(unit.source.path)) continue;
    const pages = await normalizedPages(options.normalizedRoot, unitId);
    if (!pages) {
      result.missingUnits += 1;
      result.items.push({ action: "missing", legacyPath: unit.source.path, unitId, note: "Neither original nor normalized fallback exists" });
      continue;
    }
    const filename = `Legacy Recovery - ${unitId.replaceAll("/", " - ")}.cbz`;
    const destination = safeJoin(store.paths.source, filename);
    const expectedPageCount = unit.state?.pageCount;
    const cataloged = await catalogedFilenameLocation(store, currentCatalog, filename);
    if (cataloged) {
      result.items.push({ action: "already-staged", legacyPath: unit.source.path, destination: cataloged, unitId, pageCount: pages.length, ...(expectedPageCount !== undefined ? { expectedPageCount } : {}), note: "Recovery derivative is already represented by a physical greenfield catalog occurrence" });
      continue;
    }
    if (execute) {
      const jobRoot = safeJoin(store.paths.work, "migration", unitId);
      await rm(jobRoot, { recursive: true, force: true });
      await mkdir(jobRoot, { recursive: true });
      const built = path.join(jobRoot, filename);
      const recovery = Buffer.from(`${JSON.stringify({
        schemaVersion: 1,
        kind: "legacy-normalized-recovery",
        unitId,
        missingOriginal: unit.source.path,
        normalizedDirectory: path.dirname(pages[0]!),
        pageCount: pages.length,
        expectedLegacyPageCount: expectedPageCount ?? null
      }, null, 2)}\n`);
      await createBundleFromFiles(pages.map((source) => ({ source, name: path.basename(source) })), built, [
        { name: "ComicInfo.xml", data: comicInfo(unit, unitId, pages.length) },
        { name: "YarReaderRecovery.json", data: recovery }
      ]);
      await verifyZip(built);
      const builtHash = await sha256File(built);
      const target = await destinationFor(store, destination, builtHash, filename);
      if (target.state === "copy") await copyFileVerified(built, target.path, builtHash);
    }
    result.recoveryBundles += 1;
    result.items.push({
      action: "created-recovery-bundle",
      legacyPath: unit.source.path,
      destination,
      unitId,
      pageCount: pages.length,
      ...(expectedPageCount !== undefined ? { expectedPageCount } : {}),
      note: "Recovery derivative; not represented as a legacy original"
    });
  }
  if (execute) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    const recordRelative = path.posix.join("migration-records", `legacy-${legacyHash.slice(0, 16)}-${stamp}-${process.pid}.json`);
    const record = safeJoin(store.paths.state, ...recordRelative.split("/"));
    result.record = record;
    await atomicWriteJson(record, { ...result, generatedAt: new Date().toISOString(), legacyCatalogSha256: legacyHash, originalRoots: options.originalRoots, normalizedRoot: options.normalizedRoot });
  }
  return result;
}
