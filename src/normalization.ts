import { copyFile, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import sharp, { type Metadata } from "sharp";
import { extractUnit } from "./adapters.js";
import type { CatalogStore } from "./catalog.js";
import { nowIso, type Catalog, type Normalization, type Release, type SourceFormat, type SourceRecord } from "./domain.js";
import { fsyncDirectory, fsyncFile, safeJoin, sha256File, sha256Text } from "./fs.js";
import { inboxPath } from "./scanner.js";

sharp.concurrency(Math.min(8, availableParallelism()));

export interface ResolvedSource { path: string; format: SourceFormat; occurrenceId: string }

export async function resolvePhysicalSource(store: CatalogStore, catalog: Catalog, source: SourceRecord): Promise<ResolvedSource> {
  for (const occurrenceId of source.occurrences) {
    const occurrence = catalog.occurrences[occurrenceId];
    if (!occurrence) continue;
    const candidate = occurrence.status === "inbox"
      ? inboxPath(store, occurrence.inboxRelative)
      : occurrence.archiveRelative
        ? safeJoin(store.paths.archive, ...occurrence.archiveRelative.split("/"))
        : undefined;
    if (!candidate) continue;
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) continue;
      const format: SourceFormat = source.kind === "directory" && occurrence.status !== "inbox" ? "cbz" : source.format;
      return { path: candidate, format, occurrenceId };
    } catch { /* Try another occurrence. */ }
  }
  throw new Error(`No physical occurrence is available for source ${source.id}`);
}

export async function verifyNormalization(store: CatalogStore, normalization: Normalization): Promise<boolean> {
  if (normalization.status !== "verified" || normalization.pages.length !== normalization.pageCount || normalization.pageCount === 0) return false;
  const root = safeJoin(store.paths.work, ...normalization.workRelative.split("/"));
  for (const page of normalization.pages) {
    const file = safeJoin(root, page.file);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size !== page.size || await sha256File(file) !== page.sha256) return false;
      const metadata = await sharp(file).metadata();
      if (metadata.width !== page.width || metadata.height !== page.height) return false;
    } catch { return false; }
  }
  return true;
}

export async function reconcileNormalizationPageCounts(store: CatalogStore): Promise<{ corrected: number }> {
  const catalog = await store.load();
  let corrected = 0;
  for (const unit of Object.values(catalog.units)) for (const release of unit.releases) {
    if (release.normalization?.status !== "verified") continue;
    const source = catalog.sources[release.sourceId];
    const inspected = source?.inspection.units.find((candidate) => candidate.key === release.unitKey);
    if (!inspected || inspected.pageCount === release.normalization.pageCount) continue;
    const previous = inspected.pageCount;
    inspected.pageCount = release.normalization.pageCount;
    inspected.warnings = inspected.warnings.filter((warning) => warning !== "Nested archive page count is verified during normalization");
    inspected.warnings.push(`Verified normalization corrected inspected page count from ${previous} to ${release.normalization.pageCount}`);
    corrected += 1;
  }
  if (corrected) await store.save(catalog);
  return { corrected };
}

function findInspectionUnit(source: SourceRecord, unitKey: string) {
  const unit = source.inspection.units.find((candidate) => candidate.key === unitKey);
  if (!unit) throw new Error(`Inspection unit disappeared: ${source.id}:${unitKey}`);
  return unit;
}

function releaseWorkRelative(unitId: string, release: Release): string {
  return path.posix.join("normalized", unitId, release.sourceId, sha256Text(release.unitKey));
}

async function isDisguisedComicInfo(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8").replace(/^\uFEFF/, "").trimStart();
    return text.startsWith("<?xml") && /<ComicInfo(?:\s|>)/i.test(text);
  } finally {
    await handle.close();
  }
}

async function normalizeRelease(store: CatalogStore, catalog: Catalog, unitId: string, release: Release): Promise<"normalized" | "skipped"> {
  if (release.normalization && await verifyNormalization(store, release.normalization)) return "skipped";
  const source = catalog.sources[release.sourceId];
  if (!source) throw new Error(`Missing source ${release.sourceId}`);
  const decision = source.decisions[release.unitKey];
  if (!decision || decision.status !== "accepted") throw new Error(`Unit is not accepted: ${source.id}:${release.unitKey}`);
  const inspectedUnit = findInspectionUnit(source, release.unitKey);
  const workRelative = releaseWorkRelative(unitId, release);
  const finalRoot = safeJoin(store.paths.work, ...workRelative.split("/"));
  const temporaryRoot = `${finalRoot}.building-${process.pid}`;
  await rm(temporaryRoot, { recursive: true, force: true });
  await rm(finalRoot, { recursive: true, force: true });
  await mkdir(path.join(temporaryRoot, "raw"), { recursive: true });
  release.normalization = {
    status: "prepared",
    workRelative,
    sourceId: source.id,
    profile: "reader-webp-v1",
    pageCount: 0,
    pages: []
  };
  try {
    const physical = await resolvePhysicalSource(store, catalog, source);
    const rawPages = await extractUnit(physical.path, physical.format, inspectedUnit, path.join(temporaryRoot, "raw"));
    if (rawPages.length === 0) throw new Error("Adapter produced no pages");
    const pagesDirectory = path.join(temporaryRoot, "pages");
    await mkdir(pagesDirectory, { recursive: true });
    const pages: Normalization["pages"] = [];
    for (const rawPage of rawPages) {
      let rawMetadata: Metadata;
      try {
        rawMetadata = await sharp(rawPage, { animated: false, failOn: "warning" }).metadata();
      } catch (error) {
        if (await isDisguisedComicInfo(rawPage)) continue;
        throw error;
      }
      const outputName = `${String(pages.length + 1).padStart(6, "0")}.webp`;
      const output = path.join(pagesDirectory, outputName);
      if (path.extname(rawPage).toLowerCase() === ".webp" && !rawMetadata.orientation) {
        await copyFile(rawPage, output);
      } else {
        await sharp(rawPage, { animated: false, failOn: "warning" })
          .rotate()
          .webp({ quality: 88, effort: 5, smartSubsample: true })
          .toFile(output);
      }
      await fsyncFile(output);
      const info = await lstat(output);
      const metadata = await sharp(output).metadata();
      if (!metadata.width || !metadata.height) throw new Error(`Normalized page lacks dimensions: ${outputName}`);
      pages.push({
        file: path.posix.join("pages", outputName),
        sha256: await sha256File(output),
        size: info.size,
        width: metadata.width,
        height: metadata.height
      });
    }
    await rm(path.join(temporaryRoot, "raw"), { recursive: true, force: true });
    await fsyncDirectory(pagesDirectory);
    await fsyncDirectory(temporaryRoot);
    await mkdir(path.dirname(finalRoot), { recursive: true });
    await rename(temporaryRoot, finalRoot);
    await fsyncDirectory(path.dirname(finalRoot));
    release.normalization = {
      status: "verified",
      workRelative,
      sourceId: source.id,
      profile: "reader-webp-v1",
      pageCount: pages.length,
      pages,
      verifiedAt: nowIso()
    };
    return "normalized";
  } catch (error) {
    release.normalization = {
      ...release.normalization,
      status: "failed",
      error: (error as Error).message
    };
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function normalize(store: CatalogStore, options: { failedOnly?: boolean; unverifiedOnly?: boolean } = {}): Promise<{ normalized: number; skipped: number; failed: Array<{ unitId: string; sourceId: string; error: string }> }> {
  const catalog = await store.load();
  const result = { normalized: 0, skipped: 0, failed: [] as Array<{ unitId: string; sourceId: string; error: string }> };
  const jobs: Array<{ unitId: string; release: Release }> = [];
  for (const unit of Object.values(catalog.units).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }))) for (const release of unit.releases) {
    if (options.failedOnly && release.normalization?.status !== "failed") { result.skipped += 1; continue; }
    if (options.unverifiedOnly && release.normalization?.status === "verified") { result.skipped += 1; continue; }
    if (release.normalization && await verifyNormalization(store, release.normalization)) { result.skipped += 1; continue; }
    release.normalization = {
      status: "prepared",
      workRelative: releaseWorkRelative(unit.id, release),
      sourceId: release.sourceId,
      profile: "reader-webp-v1",
      pageCount: 0,
      pages: []
    };
    jobs.push({ unitId: unit.id, release });
  }
  if (jobs.length) await store.save(catalog);
  let sinceCheckpoint = 0;
  const concurrency = 8;
  for (let offset = 0; offset < jobs.length; offset += concurrency) {
    const batch = jobs.slice(offset, offset + concurrency);
    await Promise.all(batch.map(async ({ unitId, release }) => {
      try {
        const state = await normalizeRelease(store, catalog, unitId, release);
        result[state] += 1;
      } catch (error) {
        result.failed.push({ unitId, sourceId: release.sourceId, error: (error as Error).message });
      }
    }));
    sinceCheckpoint += batch.length;
    if (sinceCheckpoint >= 24) { await store.save(catalog); sinceCheckpoint = 0; }
  }
  if (sinceCheckpoint > 0) await store.save(catalog);
  await reconcileNormalizationPageCounts(store);
  return result;
}
