import { z } from "zod";
import type { Catalog, UnitRecord } from "./domain.js";

const MetadataRecord = z.record(z.string(), z.unknown());
const LegacyUnit = z.object({
  identity: z.object({
    id: z.string().optional(),
    seriesSlug: z.string().optional(),
    segments: z.array(z.number()).optional()
  }).passthrough().optional(),
  source: z.object({ path: z.string() }).passthrough(),
  inferred: MetadataRecord.optional(),
  embedded: MetadataRecord.optional(),
  pinned: MetadataRecord.optional(),
  curated: MetadataRecord.optional(),
  state: z.object({ pageCount: z.number().int().nonnegative().optional() }).passthrough().optional()
}).passthrough();

const LegacyCatalog = z.object({ units: z.record(z.string(), LegacyUnit) }).passthrough();

const comparedMetadataFields = [
  "series", "title", "year", "unitType", "issue", "chapter", "volume",
  "publisher", "authors", "artists", "language", "direction", "readingMode",
  "tags", "summary"
] as const;

type Difference = { field: string; kind: "missing-in-greenfield" | "changed"; legacy: unknown; greenfield?: unknown };

function equalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function selectedRelease(unit: UnitRecord) {
  return unit.releases.find((release) => release.sourceId === unit.selectedRelease.sourceId && release.unitKey === unit.selectedRelease.unitKey);
}

function greenfieldMetadata(catalog: Catalog, unit: UnitRecord): Record<string, unknown> {
  const release = selectedRelease(unit);
  const source = release ? catalog.sources[release.sourceId] : undefined;
  const inspected = source?.inspection.units.find((candidate) => candidate.key === release?.unitKey);
  return {
    ...source?.inspection.metadata,
    ...inspected?.metadata,
    series: unit.series,
    seriesSlug: unit.seriesSlug,
    unitType: unit.unitType,
    ...(unit.issue !== undefined ? { issue: unit.issue } : {}),
    ...(unit.chapter !== undefined ? { chapter: unit.chapter } : {}),
    ...(unit.volume !== undefined ? { volume: unit.volume } : {}),
    ...(unit.sequence !== undefined ? { sequence: unit.sequence } : {}),
    ...(unit.title !== undefined ? { title: unit.title } : {}),
    ...(unit.year !== undefined ? { year: unit.year } : {})
  };
}

export function auditLegacyCatalog(catalog: Catalog, legacyInput: unknown) {
  const legacy = LegacyCatalog.parse(legacyInput);
  const candidates = new Map<string, UnitRecord[]>();
  for (const unit of Object.values(catalog.units)) {
    const key = `${unit.seriesSlug}\0${unit.sequence ?? ""}`;
    const matches = candidates.get(key) ?? [];
    matches.push(unit);
    candidates.set(key, matches);
  }
  const matchedGreenfield = new Set<string>();
  const comparisons: Array<Record<string, unknown>> = [];
  let matched = 0;
  let unmatched = 0;
  let ambiguous = 0;
  let identityDiscrepancies = 0;
  let pageCountDiscrepancies = 0;
  let metadataDiscrepancies = 0;
  const metadataFields: Record<string, number> = {};

  for (const [legacyId, unit] of Object.entries(legacy.units)) {
    const metadata = { ...unit.inferred, ...unit.embedded, ...unit.pinned, ...unit.curated };
    metadata.unitType ??= metadata.issue !== undefined ? "issue"
      : metadata.chapter !== undefined ? "chapter"
        : metadata.volume !== undefined ? "volume" : undefined;
    const seriesSlug = unit.identity?.seriesSlug ?? legacyId.split("/")[0]!;
    const sequence = typeof metadata.sequence === "number"
      ? metadata.sequence
      : unit.identity?.segments?.at(-1);
    const matches = candidates.get(`${seriesSlug}\0${sequence ?? ""}`) ?? [];
    if (matches.length !== 1) {
      if (matches.length === 0) unmatched += 1;
      else ambiguous += 1;
      comparisons.push({
        legacyId,
        legacyPath: unit.source.path,
        status: matches.length === 0 ? "unmatched" : "ambiguous",
        seriesSlug,
        sequence,
        candidates: matches.map((candidate) => candidate.id)
      });
      continue;
    }

    matched += 1;
    const current = matches[0]!;
    matchedGreenfield.add(current.id);
    const currentMetadata = greenfieldMetadata(catalog, current);
    const identityDifferences: Difference[] = [];
    if (typeof metadata.series === "string" && metadata.series !== current.series) {
      identityDifferences.push({ field: "series", kind: "changed", legacy: metadata.series, greenfield: current.series });
    }
    if (identityDifferences.length) identityDiscrepancies += 1;

    const release = selectedRelease(current);
    const currentPageCount = release?.normalization?.status === "verified" ? release.normalization.pageCount : undefined;
    const legacyPageCount = unit.state?.pageCount;
    const pageCountDifference = legacyPageCount !== undefined && currentPageCount !== undefined && legacyPageCount !== currentPageCount
      ? { legacy: legacyPageCount, greenfield: currentPageCount }
      : undefined;
    if (pageCountDifference) pageCountDiscrepancies += 1;

    const differences: Difference[] = [];
    for (const field of comparedMetadataFields) {
      const oldValue = metadata[field];
      if (oldValue === undefined || field === "series") continue;
      const newValue = currentMetadata[field];
      if (newValue === undefined) differences.push({ field, kind: "missing-in-greenfield", legacy: oldValue });
      else if (!equalValue(oldValue, newValue)) differences.push({ field, kind: "changed", legacy: oldValue, greenfield: newValue });
    }
    if (differences.length) metadataDiscrepancies += 1;
    for (const difference of differences) metadataFields[difference.field] = (metadataFields[difference.field] ?? 0) + 1;
    comparisons.push({
      legacyId,
      legacyPath: unit.source.path,
      status: "matched",
      greenfieldId: current.id,
      ...(identityDifferences.length ? { identityDifferences } : {}),
      ...(pageCountDifference ? { pageCountDifference } : {}),
      ...(differences.length ? { metadataDifferences: differences } : {})
    });
  }

  const greenfieldOnly = Object.keys(catalog.units).filter((id) => !matchedGreenfield.has(id)).sort();
  return {
    generatedAt: new Date().toISOString(),
    matchingRule: "legacy seriesSlug + pinned sequence matched to greenfield seriesSlug + sequence",
    summary: {
      legacyUnits: Object.keys(legacy.units).length,
      greenfieldUnits: Object.keys(catalog.units).length,
      matched,
      unmatched,
      ambiguous,
      greenfieldOnly: greenfieldOnly.length,
      identityDiscrepancies,
      pageCountDiscrepancies,
      metadataDiscrepancies,
      metadataFields
    },
    comparisons,
    greenfieldOnly
  };
}
