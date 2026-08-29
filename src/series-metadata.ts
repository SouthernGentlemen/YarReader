import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ReadingMode, type Catalog, type EmbeddedMetadata, type UnitRecord } from "./domain.js";

export const CuratedSeriesSchema = z.object({
  series: z.string().min(1),
  seriesSlug: z.string().min(1),
  readingMode: ReadingMode,
  genres: z.array(z.string().min(1)),
  coverPageUrl: z.string().url().optional()
}).strict();
export type CuratedSeries = z.infer<typeof CuratedSeriesSchema>;

export const SeriesMergeSchema = z.object({
  sourceSlugs: z.array(z.string().min(1)).min(1),
  targetSeries: z.string().min(1),
  targetSeriesSlug: z.string().min(1)
}).strict();
export type SeriesMerge = z.infer<typeof SeriesMergeSchema>;

export const SeriesCurationSchema = z.object({
  schemaVersion: z.literal(1),
  series: z.array(CuratedSeriesSchema).default([]),
  merges: z.array(SeriesMergeSchema).default([])
}).strict();
export type SeriesCuration = z.infer<typeof SeriesCurationSchema>;

export const EMPTY_SERIES_CURATION: SeriesCuration = { schemaVersion: 1, series: [], merges: [] };

export async function loadSeriesCuration(file: string): Promise<SeriesCuration> {
  try {
    return SeriesCurationSchema.parse(JSON.parse(await readFile(file, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_SERIES_CURATION;
    throw error;
  }
}

function selectedMetadata(catalog: Catalog, unit: UnitRecord): EmbeddedMetadata {
  const release = unit.releases.find((candidate) => candidate.sourceId === unit.selectedRelease.sourceId && candidate.unitKey === unit.selectedRelease.unitKey);
  const source = release ? catalog.sources[release.sourceId] : undefined;
  const inspected = source?.inspection.units.find((candidate) => candidate.key === release?.unitKey);
  return { ...(source?.inspection.metadata ?? {}), ...(inspected?.metadata ?? {}) };
}

function normalizedGenres(values: readonly (string | undefined)[]): string[] {
  const genres = new Map<string, string>();
  for (const value of values) {
    const clean = value?.trim();
    if (clean) genres.set(clean.toLocaleLowerCase("en"), clean);
  }
  return [...genres.values()].sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));
}

function mergeConfiguredSeries(catalog: Catalog, merges: readonly SeriesMerge[]): number {
  let mergedUnits = 0;
  for (const merge of merges) {
    const sourceSlugs = new Set(merge.sourceSlugs);
    const moves = Object.entries(catalog.units).filter(([, unit]) => sourceSlugs.has(unit.seriesSlug));
    for (const [, unit] of moves) {
      const suffix = unit.id.slice(unit.id.indexOf("/") + 1);
      const targetId = `${merge.targetSeriesSlug}/${suffix}`;
      if (catalog.units[targetId] && catalog.units[targetId] !== unit) throw new Error(`Series merge would collide at ${targetId}`);
    }
    for (const [oldId, unit] of moves) {
      const suffix = unit.id.slice(unit.id.indexOf("/") + 1);
      const targetId = `${merge.targetSeriesSlug}/${suffix}`;
      delete catalog.units[oldId];
      unit.id = targetId;
      unit.series = merge.targetSeries;
      unit.seriesSlug = merge.targetSeriesSlug;
      catalog.units[targetId] = unit;
      mergedUnits += 1;
    }
    for (const source of Object.values(catalog.sources)) {
      for (const decision of Object.values(source.decisions)) {
        if (!sourceSlugs.has(decision.proposal.seriesSlug)) continue;
        decision.proposal.series = merge.targetSeries;
        decision.proposal.seriesSlug = merge.targetSeriesSlug;
        const evidence = `curated series merge: ${merge.targetSeriesSlug}`;
        if (!decision.proposal.evidence.includes(evidence)) decision.proposal.evidence.push(evidence);
      }
    }
    for (const proposals of Object.values(catalog.aiDecisions)) {
      for (const proposal of Object.values(proposals)) {
        if (!sourceSlugs.has(proposal.seriesSlug)) continue;
        proposal.series = merge.targetSeries;
        proposal.seriesSlug = merge.targetSeriesSlug;
      }
    }
    for (const slug of sourceSlugs) delete catalog.seriesMetadata[slug];
  }
  return mergedUnits;
}

export function applyCatalogCuration(catalog: Catalog, curation: SeriesCuration = EMPTY_SERIES_CURATION): {
  changed: boolean;
  mergedUnits: number;
  series: number;
  formats: Record<z.infer<typeof ReadingMode>, number>;
} {
  const mergedUnits = mergeConfiguredSeries(catalog, curation.merges);
  let changed = mergedUnits > 0;
  const groups = new Map<string, UnitRecord[]>();
  for (const unit of Object.values(catalog.units)) {
    const group = groups.get(unit.seriesSlug) ?? [];
    group.push(unit);
    groups.set(unit.seriesSlug, group);
  }
  for (const slug of Object.keys(catalog.seriesMetadata)) {
    if (!groups.has(slug)) {
      delete catalog.seriesMetadata[slug];
      changed = true;
    }
  }

  const curatedBySlug = new Map(curation.series.map((entry) => [entry.seriesSlug, entry]));
  const formats: Record<z.infer<typeof ReadingMode>, number> = { ltr: 0, rtl: 0, scroll: 0 };
  for (const [slug, units] of groups) {
    const existing = catalog.seriesMetadata[slug];
    const curated = curatedBySlug.get(slug);
    const metadata = units.map((unit) => selectedMetadata(catalog, unit));
    const detectedModes = metadata.map((entry) => entry.readingMode ?? (entry.direction === "rtl" ? "rtl" : undefined)).filter((mode): mode is z.infer<typeof ReadingMode> => Boolean(mode));
    const readingMode = curated?.readingMode ?? existing?.readingMode ?? (detectedModes.includes("scroll") ? "scroll" : detectedModes.includes("rtl") ? "rtl" : "ltr");
    const genres = normalizedGenres([
      ...(existing?.genres ?? []),
      ...(curated?.genres ?? []),
      ...metadata.flatMap((entry) => [...(entry.genres ?? []), ...(entry.tags ?? [])])
    ]);
    const series = units[0]!.series;
    formats[readingMode] += 1;
    if (!existing || existing.series !== series || existing.readingMode !== readingMode || JSON.stringify(existing.genres) !== JSON.stringify(genres)) {
      catalog.seriesMetadata[slug] = { series, readingMode, genres, updatedAt: new Date().toISOString() };
      changed = true;
    }
  }
  return { changed, mergedUnits, series: groups.size, formats };
}
