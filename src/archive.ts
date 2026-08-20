import { copyFile, lstat, mkdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import type { CatalogStore } from "./catalog.js";
import { nowIso, type ArchiveTransaction, type Catalog, type Occurrence, type SourceRecord } from "./domain.js";
import { fsyncDirectory, fsyncFile, hashDirectory, safeJoin, sha256File, sha256Text } from "./fs.js";
import { inboxPath } from "./scanner.js";
import { verifyNormalization } from "./normalization.js";
import { createStoredBundle, verifyZip } from "./zip.js";

export interface ArchiveIO {
  rename(source: string, destination: string): Promise<void>;
  copyFile(source: string, destination: string): Promise<void>;
}

const defaultIO: ArchiveIO = { rename, copyFile };

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch { return false; }
}

async function verifyOriginal(source: SourceRecord, file: string): Promise<void> {
  const info = await lstat(file);
  if (info.isSymbolicLink()) throw new Error(`Symbolic source rejected during archive: ${file}`);
  const actual = source.kind === "directory" ? (await hashDirectory(file)).sha256 : await sha256File(file);
  if (actual !== source.id) throw new Error(`Source changed after scan: ${file}`);
}

async function sourceReady(store: CatalogStore, catalog: Catalog, source: SourceRecord): Promise<boolean> {
  for (const inspected of source.inspection.units) {
    const decision = source.decisions[inspected.key];
    if (!decision || decision.status !== "accepted") return false;
    const release = Object.values(catalog.units).flatMap((unit) => unit.releases).find((candidate) => candidate.sourceId === source.id && candidate.unitKey === inspected.key);
    if (!release?.normalization || !(await verifyNormalization(store, release.normalization))) return false;
  }
  return true;
}

function archiveRelative(source: SourceRecord, occurrence: Occurrence): string {
  const slugs = new Set(Object.values(source.decisions).filter((decision) => decision.status === "accepted").map((decision) => decision.proposal.seriesSlug));
  const bucket = source.kind === "directory" || slugs.size > 1
    ? "_bundles"
    : slugs.size === 1 && [...slugs][0] !== "unresolved"
      ? [...slugs][0]!
      : "_unresolved";
  const filename = source.kind === "directory"
    ? `${occurrence.originalFilename.replace(/\.[^.]+$/, "")}.cbz`
    : occurrence.originalFilename;
  return path.posix.join(bucket, source.id, filename);
}

async function prepareTransaction(store: CatalogStore, catalog: Catalog, source: SourceRecord, occurrence: Occurrence): Promise<ArchiveTransaction> {
  const destinationRelative = archiveRelative(source, occurrence);
  const id = sha256Text(`archive\0${occurrence.id}\0${destinationRelative}`);
  const existing = catalog.archiveTransactions[id];
  if (existing) return existing;
  const transaction: ArchiveTransaction = {
    id,
    sourceId: source.id,
    occurrenceId: occurrence.id,
    sourceRelative: occurrence.inboxRelative,
    destinationRelative,
    bundledDirectory: source.kind === "directory",
    status: "prepared",
    preparedAt: nowIso()
  };
  if (source.kind !== "directory") transaction.destinationSha256 = source.id;
  catalog.archiveTransactions[id] = transaction;
  return transaction;
}

async function prepareDirectoryBundle(store: CatalogStore, catalog: Catalog, source: SourceRecord, transaction: ArchiveTransaction, sourcePath: string): Promise<string> {
  const bundleRoot = safeJoin(store.paths.work, "archive-prepare", transaction.id);
  const bundle = path.join(bundleRoot, path.basename(transaction.destinationRelative));
  await rm(bundleRoot, { recursive: true, force: true });
  await mkdir(bundleRoot, { recursive: true });
  const result = await createStoredBundle(sourcePath, bundle);
  await verifyZip(bundle);
  transaction.destinationSha256 = result.sha256;
  await store.save(catalog);
  return bundle;
}

async function verifyDestination(destination: string, transaction: ArchiveTransaction): Promise<void> {
  if (!transaction.destinationSha256) throw new Error(`Archive transaction lacks destination hash: ${transaction.id}`);
  if (await sha256File(destination) !== transaction.destinationSha256) throw new Error(`Archived destination hash mismatch: ${destination}`);
  if (transaction.bundledDirectory) await verifyZip(destination);
}

async function moveWithExdevFallback(source: string, destination: string, transaction: ArchiveTransaction, io: ArchiveIO): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const incoming = `${destination}.incoming-${transaction.id}`;
  if (await exists(incoming)) {
    if (await sha256File(incoming) !== transaction.destinationSha256) await unlink(incoming);
    else {
      await io.rename(incoming, destination);
      await fsyncDirectory(path.dirname(destination));
      return;
    }
  }
  try {
    await io.rename(source, destination);
    await fsyncDirectory(path.dirname(destination));
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  if (await exists(incoming)) {
    if (await sha256File(incoming) !== transaction.destinationSha256) await unlink(incoming);
  }
  if (!(await exists(incoming))) {
    await io.copyFile(source, incoming);
    await fsyncFile(incoming);
  }
  if (await sha256File(incoming) !== transaction.destinationSha256) throw new Error(`EXDEV copy verification failed: ${incoming}`);
  await io.rename(incoming, destination);
  await fsyncDirectory(path.dirname(destination));
}

async function finalize(store: CatalogStore, catalog: Catalog, transaction: ArchiveTransaction, occurrence: Occurrence, sourcePath: string): Promise<void> {
  const destination = safeJoin(store.paths.archive, ...transaction.destinationRelative.split("/"));
  await verifyDestination(destination, transaction);
  if (await exists(sourcePath)) {
    const source = catalog.sources[transaction.sourceId]!;
    await verifyOriginal(source, sourcePath);
    if (source.kind === "directory") await rm(sourcePath, { recursive: true });
    else await unlink(sourcePath);
    await fsyncDirectory(path.dirname(sourcePath));
  }
  occurrence.status = sourcePath === destination ? "archived" : "archived";
  occurrence.archiveRelative = transaction.destinationRelative;
  transaction.status = "completed";
  transaction.completedAt = nowIso();
}

async function executeTransaction(store: CatalogStore, catalog: Catalog, transaction: ArchiveTransaction, io: ArchiveIO): Promise<void> {
  const source = catalog.sources[transaction.sourceId];
  const occurrence = catalog.occurrences[transaction.occurrenceId];
  if (!source || !occurrence) throw new Error(`Archive transaction references missing records: ${transaction.id}`);
  const sourcePath = inboxPath(store, transaction.sourceRelative);
  const destination = safeJoin(store.paths.archive, ...transaction.destinationRelative.split("/"));
  if (await exists(destination)) {
    await finalize(store, catalog, transaction, occurrence, sourcePath);
    return;
  }
  if (!(await exists(sourcePath))) throw new Error(`Neither archive source nor destination exists for ${transaction.id}`);
  await verifyOriginal(source, sourcePath);
  const moving = transaction.bundledDirectory
    ? await prepareDirectoryBundle(store, catalog, source, transaction, sourcePath)
    : sourcePath;
  await moveWithExdevFallback(moving, destination, transaction, io);
  if (!transaction.bundledDirectory && await exists(sourcePath)) {
    await unlink(sourcePath);
    await fsyncDirectory(path.dirname(sourcePath));
  }
  await finalize(store, catalog, transaction, occurrence, sourcePath);
}

export async function archive(store: CatalogStore, io: ArchiveIO = defaultIO): Promise<{ archived: number; waiting: number; recovered: number; failed: Array<{ sourceId: string; error: string }> }> {
  const catalog = await store.load();
  const result = { archived: 0, waiting: 0, recovered: 0, failed: [] as Array<{ sourceId: string; error: string }> };
  let sinceCheckpoint = 0;
  for (const transaction of Object.values(catalog.archiveTransactions).filter((item) => item.status === "prepared")) {
    try { await executeTransaction(store, catalog, transaction, io); result.recovered += 1; }
    catch (error) { result.failed.push({ sourceId: transaction.sourceId, error: (error as Error).message }); }
    sinceCheckpoint += 1;
    if (sinceCheckpoint >= 25) { await store.save(catalog); sinceCheckpoint = 0; }
  }
  if (sinceCheckpoint > 0) { await store.save(catalog); sinceCheckpoint = 0; }
  const prepared: ArchiveTransaction[] = [];
  for (const source of Object.values(catalog.sources)) {
    const inboxOccurrences = source.occurrences.filter((id) => catalog.occurrences[id]?.status === "inbox");
    if (inboxOccurrences.length === 0) continue;
    if (!(await sourceReady(store, catalog, source))) { result.waiting += inboxOccurrences.length; continue; }
    for (const occurrenceId of inboxOccurrences) {
      const occurrence = catalog.occurrences[occurrenceId];
      if (!occurrence || occurrence.status !== "inbox") continue;
      try {
        const transaction = await prepareTransaction(store, catalog, source, occurrence);
        prepared.push(transaction);
      } catch (error) {
        result.failed.push({ sourceId: source.id, error: (error as Error).message });
      }
    }
  }
  if (prepared.length) await store.save(catalog);
  for (const transaction of prepared) {
    try { await executeTransaction(store, catalog, transaction, io); result.archived += 1; }
    catch (error) { result.failed.push({ sourceId: transaction.sourceId, error: (error as Error).message }); }
    sinceCheckpoint += 1;
    if (sinceCheckpoint >= 25) { await store.save(catalog); sinceCheckpoint = 0; }
  }
  if (sinceCheckpoint > 0) await store.save(catalog);
  return result;
}
