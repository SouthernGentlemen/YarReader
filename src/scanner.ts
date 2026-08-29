import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { formatFromPath, inspectSource, isSupportedPath } from "./adapters.js";
import type { CatalogStore } from "./catalog.js";
import { nowIso, type Catalog, type SourceRecord } from "./domain.js";
import { hashDirectory, isPartialName, safeJoin, sha256File, sha256Text, treeContainsPartial } from "./fs.js";

interface Snapshot { kind: "file" | "directory"; size: number; mtimeMs: number }
export interface ScanResult { discovered: number; pending: number; ignored: number; failed: Array<{ path: string; error: string }>; duplicates: number }

async function directorySnapshot(directory: string): Promise<Snapshot> {
  let size = 0;
  let mtimeMs = (await stat(directory)).mtimeMs;
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (isPartialName(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Symbolic link inside input: ${absolute}`);
      mtimeMs = Math.max(mtimeMs, info.mtimeMs);
      if (info.isDirectory()) await walk(absolute);
      else if (info.isFile()) size += info.size;
    }
  }
  await walk(directory);
  return { kind: "directory", size, mtimeMs };
}

async function snapshot(candidate: string): Promise<Snapshot> {
  const info = await lstat(candidate);
  if (info.isSymbolicLink()) throw new Error(`Symbolic media input rejected: ${candidate}`);
  if (info.isDirectory()) return directorySnapshot(candidate);
  return { kind: "file", size: info.size, mtimeMs: info.mtimeMs };
}

async function discoverCandidates(sourceRoot: string): Promise<{ paths: string[]; ignored: number }> {
  const paths: string[] = [];
  let ignored = 0;
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }));
    for (const entry of entries) {
      if (isPartialName(entry.name)) { ignored += 1; continue; }
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) { ignored += 1; continue; }
      if (info.isDirectory()) {
        if (await treeContainsPartial(absolute)) { ignored += 1; continue; }
        if (await isSupportedPath(absolute)) paths.push(absolute);
        else await walk(absolute);
      } else if (formatFromPath(absolute, false)) paths.push(absolute);
      else ignored += 1;
    }
  }
  await walk(sourceRoot);
  return { paths, ignored };
}

function sameSnapshot(a: { kind: string; size: number; mtimeMs: number }, b: Snapshot): boolean {
  return a.kind === b.kind && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

async function hashCandidate(candidate: string, current: Snapshot): Promise<{ id: string; size: number }> {
  if (current.kind === "directory") {
    const hashed = await hashDirectory(candidate);
    return { id: hashed.sha256, size: hashed.size };
  }
  return { id: await sha256File(candidate), size: current.size };
}

function occurrenceId(sourceId: string, relative: string): string {
  return sha256Text(`${sourceId}\0${relative.normalize("NFC")}`);
}

async function registerStable(catalog: Catalog, absolute: string, relative: string, current: Snapshot, refresh: boolean): Promise<"new" | "duplicate"> {
  const hashed = await hashCandidate(absolute, current);
  const after = await snapshot(absolute);
  if (!sameSnapshot(current, after)) throw new Error("Input changed while it was being hashed");
  const existing = catalog.sources[hashed.id];
  const id = occurrenceId(hashed.id, relative);
  if (existing) {
    if (refresh) {
      const inspection = await inspectSource(absolute);
      existing.format = inspection.format;
      existing.inspection = inspection;
      existing.decisions = {};
      existing.warnings = [...inspection.warnings];
    }
    if (!catalog.occurrences[id]) {
      catalog.occurrences[id] = { id, sourceId: hashed.id, originalFilename: path.basename(absolute), inboxRelative: relative, size: hashed.size, discoveredAt: nowIso(), status: "inbox" };
    }
    if (!existing.occurrences.includes(id)) existing.occurrences.push(id);
    delete catalog.scanCandidates[relative];
    return "duplicate";
  }
  const inspection = await inspectSource(absolute);
  if (!catalog.occurrences[id]) {
    catalog.occurrences[id] = { id, sourceId: hashed.id, originalFilename: path.basename(absolute), inboxRelative: relative, size: hashed.size, discoveredAt: nowIso(), status: "inbox" };
  }
  const source: SourceRecord = {
    id: hashed.id,
    kind: current.kind,
    format: inspection.format,
    size: hashed.size,
    inspection,
    occurrences: [id],
    decisions: {},
    discoveredAt: nowIso(),
    warnings: [...inspection.warnings]
  };
  catalog.sources[hashed.id] = source;
  delete catalog.scanCandidates[relative];
  return "new";
}

export async function scan(store: CatalogStore, stableSeconds = 10, refresh = false): Promise<ScanResult> {
  const catalog = await store.load();
  if (refresh) catalog.units = {};
  const discovered = await discoverCandidates(store.paths.source);
  const result: ScanResult = { discovered: 0, pending: 0, ignored: discovered.ignored, failed: [], duplicates: 0 };
  const seen = new Set<string>();
  const now = Date.now();
  for (const absolute of discovered.paths) {
    const relative = path.relative(store.paths.source, absolute).split(path.sep).join("/");
    seen.add(relative);
    try {
      const current = await snapshot(absolute);
      const previous = catalog.scanCandidates[relative];
      if (!previous || !sameSnapshot(previous, current)) {
        catalog.scanCandidates[relative] = {
          relativePath: relative,
          ...current,
          stableSince: new Date(now).toISOString(),
          lastSeenAt: new Date(now).toISOString()
        };
        if (stableSeconds > 0) { result.pending += 1; continue; }
      } else {
        previous.lastSeenAt = new Date(now).toISOString();
        if (now - Date.parse(previous.stableSince) < stableSeconds * 1000) { result.pending += 1; continue; }
      }
      const state = await registerStable(catalog, absolute, relative, current, refresh);
      if (state === "new") result.discovered += 1;
      else result.duplicates += 1;
    } catch (error) {
      result.failed.push({ path: relative, error: (error as Error).message });
      const candidate = catalog.scanCandidates[relative];
      if (candidate) candidate.stableSince = new Date(now).toISOString();
    }
  }
  for (const relative of Object.keys(catalog.scanCandidates)) {
    if (!seen.has(relative)) delete catalog.scanCandidates[relative];
  }
  await store.save(catalog);
  return result;
}

export function inboxPath(store: CatalogStore, inboxRelative: string): string {
  return safeJoin(store.paths.source, ...inboxRelative.split("/"));
}
