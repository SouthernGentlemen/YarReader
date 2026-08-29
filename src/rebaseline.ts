import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { directoryContainsPages, formatFromPath, inspectSource } from "./adapters.js";
import { hashDirectory, isPartialName, sha256File, treeContainsPartial } from "./fs.js";

const LegacyCatalogSchema = z.object({
  units: z.record(z.string(), z.object({
    source: z.object({ path: z.string(), adapter: z.string().optional(), size: z.number().optional() }).passthrough(),
    state: z.object({ pageCount: z.number().int().nonnegative().optional() }).passthrough().optional()
  }).passthrough())
}).passthrough();

export interface RebaselineItem {
  path: string;
  provenance: string;
  size: number;
  sha256: string;
  format: string;
  logicalUnits: number;
  pageCounts: number[];
  duplicateOf?: string;
  proposedDestination: string;
  warnings: string[];
}

async function discover(root: string): Promise<string[]> {
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) return [];
  if (rootInfo.isFile()) return formatFromPath(root, false) && !isPartialName(path.basename(root)) ? [root] : [];
  const output: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))) {
      if (isPartialName(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (await directoryContainsPages(absolute)) {
          if (!(await treeContainsPartial(absolute))) output.push(absolute);
        } else await walk(absolute);
      }
      else if (formatFromPath(absolute, false)) output.push(absolute);
    }
  }
  await walk(root);
  return output;
}

export async function rebaselineDryRun(inputRoots: string[], legacyCatalogInput?: unknown): Promise<{
  generatedAt: string;
  dryRun: true;
  legacyUnitCount: number;
  inventory: RebaselineItem[];
  totals: { sources: number; uniqueSources: number; logicalUnits: number; pages: number; bytes: number };
  discrepancies: Array<Record<string, unknown>>;
  cleanupCandidates: Array<Record<string, unknown>>;
}> {
  const legacy = legacyCatalogInput ? LegacyCatalogSchema.parse(legacyCatalogInput) : undefined;
  const legacyByPath = new Map<string, Array<{ id: string; pageCount?: number }>>();
  for (const [id, unit] of Object.entries(legacy?.units ?? {})) {
    const key = path.resolve(unit.source.path).toLowerCase();
    const records = legacyByPath.get(key) ?? [];
    records.push({ id, ...(unit.state?.pageCount !== undefined ? { pageCount: unit.state.pageCount } : {}) });
    legacyByPath.set(key, records);
  }
  const files = (await Promise.all(inputRoots.map((root) => discover(path.resolve(root))))).flat().sort();
  const inventory: RebaselineItem[] = [];
  const firstByHash = new Map<string, string>();
  const discrepancies: Array<Record<string, unknown>> = [];
  for (const file of files) {
    try {
      const info = await lstat(file);
      const directoryHash = info.isDirectory() ? await hashDirectory(file) : undefined;
      const sha256 = directoryHash?.sha256 ?? await sha256File(file);
      const inspection = await inspectSource(file);
      const duplicateOf = firstByHash.get(sha256);
      if (!duplicateOf) firstByHash.set(sha256, file);
      const pageCounts = inspection.units.map((unit) => unit.pageCount);
      const legacyUnits = legacyByPath.get(path.resolve(file).toLowerCase()) ?? [];
      if (legacyUnits.length && (legacyUnits.length !== inspection.units.length || legacyUnits.some((unit, index) => unit.pageCount !== undefined && unit.pageCount !== pageCounts[index]))) {
        discrepancies.push({ path: file, legacyUnits, inspectedPageCounts: pageCounts });
      }
      inventory.push({
        path: file,
        provenance: inputRoots.find((root) => file === path.resolve(root) || file.startsWith(`${path.resolve(root)}${path.sep}`)) ?? "unknown",
        size: directoryHash?.size ?? info.size,
        sha256,
        format: inspection.format,
        logicalUnits: inspection.units.length,
        pageCounts,
        ...(duplicateOf ? { duplicateOf } : {}),
        proposedDestination: info.isDirectory()
          ? `source/${path.basename(path.dirname(file))}-${path.basename(file)}.cbz`
          : `source/${path.basename(file)}`,
        warnings: inspection.warnings
      });
    } catch (error) {
      discrepancies.push({ path: file, error: (error as Error).message });
    }
  }
  const inventoriedPaths = new Set(inventory.map((item) => path.resolve(item.path).toLowerCase()));
  for (const [legacyPath, units] of legacyByPath) {
    if (!inventoriedPaths.has(legacyPath)) discrepancies.push({ path: units.length ? legacy?.units[units[0]!.id]?.source.path : legacyPath, kind: "legacy-source-not-in-inventory", legacyUnits: units });
  }
  const uniqueSources = new Set(inventory.map((item) => item.sha256)).size;
  return {
    generatedAt: new Date().toISOString(),
    dryRun: true,
    legacyUnitCount: Object.keys(legacy?.units ?? {}).length,
    inventory,
    totals: {
      sources: inventory.length,
      uniqueSources,
      logicalUnits: inventory.reduce((sum, item) => sum + item.logicalUnits, 0),
      pages: inventory.reduce((sum, item) => sum + item.pageCounts.reduce((a, b) => a + b, 0), 0),
      bytes: inventory.reduce((sum, item) => sum + item.size, 0)
    },
    discrepancies,
    cleanupCandidates: inventory.filter((item) => item.duplicateOf).map((item) => ({ path: item.path, duplicateOf: item.duplicateOf, sha256: item.sha256, action: "candidate-only; do not delete" }))
  };
}
