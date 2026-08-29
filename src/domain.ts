import { z } from "zod";

export const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
export const IsoDate = z.string().datetime({ offset: true });
export const SourceFormat = z.enum(["cbz", "zip", "epub", "pdf", "cbr", "rar", "image", "directory"]);
export type SourceFormat = z.infer<typeof SourceFormat>;

export const UnitType = z.enum(["issue", "chapter", "volume", "annual", "special", "book", "unknown"]);
export type UnitType = z.infer<typeof UnitType>;

export const ReadingMode = z.enum(["ltr", "rtl", "scroll"]);
export type ReadingMode = z.infer<typeof ReadingMode>;

export const SeriesMetadataSchema = z.object({
  series: z.string().min(1),
  readingMode: ReadingMode,
  genres: z.array(z.string().min(1)),
  updatedAt: IsoDate
}).strict();
export type SeriesMetadata = z.infer<typeof SeriesMetadataSchema>;

export const EmbeddedMetadataSchema = z.object({
  series: z.string().min(1).optional(),
  unitType: UnitType.optional(),
  title: z.string().min(1).optional(),
  issue: z.number().nonnegative().optional(),
  chapter: z.number().nonnegative().optional(),
  volume: z.number().nonnegative().optional(),
  sequence: z.number().nonnegative().optional(),
  year: z.number().int().min(1000).max(9999).optional(),
  authors: z.array(z.string()).optional(),
  artists: z.array(z.string()).optional(),
  publisher: z.string().optional(),
  language: z.string().optional(),
  direction: z.enum(["ltr", "rtl"]).optional(),
  readingMode: ReadingMode.optional(),
  genres: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string()).optional(),
  summary: z.string().optional()
}).strict();
export type EmbeddedMetadata = z.infer<typeof EmbeddedMetadataSchema>;

export const InspectionUnitSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  entryNames: z.array(z.string()),
  pageCount: z.number().int().nonnegative(),
  contentFingerprints: z.array(SHA256).optional(),
  metadata: EmbeddedMetadataSchema,
  warnings: z.array(z.string())
}).strict();
export type InspectionUnit = z.infer<typeof InspectionUnitSchema>;

export const InspectionSchema = z.object({
  adapter: z.string().min(1),
  format: SourceFormat,
  metadata: EmbeddedMetadataSchema,
  units: z.array(InspectionUnitSchema).min(1),
  warnings: z.array(z.string())
}).strict();
export type Inspection = z.infer<typeof InspectionSchema>;

export const ClassificationProposalSchema = z.object({
  series: z.string().min(1),
  seriesSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  unitType: UnitType,
  issue: z.number().nonnegative().optional(),
  chapter: z.number().nonnegative().optional(),
  volume: z.number().nonnegative().optional(),
  sequence: z.number().nonnegative().optional(),
  title: z.string().optional(),
  year: z.number().int().min(1000).max(9999).optional(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).min(1),
  warnings: z.array(z.string()),
  matchingCatalogCandidates: z.array(z.string())
}).strict();
export type ClassificationProposal = z.infer<typeof ClassificationProposalSchema>;

export const ClassificationDecisionSchema = z.object({
  unitKey: z.string(),
  status: z.enum(["pending", "accepted", "rejected"]),
  proposal: ClassificationProposalSchema,
  proposalSource: z.enum(["deterministic", "ai", "human"]),
  reviewedAt: IsoDate.optional(),
  warnings: z.array(z.string())
}).strict();
export type ClassificationDecision = z.infer<typeof ClassificationDecisionSchema>;

export const PageVerificationSchema = z.object({
  file: z.string(),
  sha256: SHA256,
  size: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive()
}).strict();

export const NormalizationSchema = z.object({
  status: z.enum(["prepared", "verified", "failed"]),
  workRelative: z.string(),
  sourceId: SHA256,
  profile: z.string(),
  pageCount: z.number().int().nonnegative(),
  pages: z.array(PageVerificationSchema),
  verifiedAt: IsoDate.optional(),
  error: z.string().optional()
}).strict();
export type Normalization = z.infer<typeof NormalizationSchema>;

export const ReleaseSchema = z.object({
  sourceId: SHA256,
  unitKey: z.string(),
  selected: z.boolean(),
  normalization: NormalizationSchema.optional()
}).strict();
export type Release = z.infer<typeof ReleaseSchema>;

export const UnitRecordSchema = z.object({
  id: z.string().min(1),
  series: z.string().min(1),
  seriesSlug: z.string(),
  unitType: UnitType,
  issue: z.number().optional(),
  chapter: z.number().optional(),
  volume: z.number().optional(),
  sequence: z.number().optional(),
  title: z.string().optional(),
  year: z.number().int().optional(),
  releases: z.array(ReleaseSchema).min(1),
  selectedRelease: z.object({ sourceId: SHA256, unitKey: z.string() }).strict()
}).strict();
export type UnitRecord = z.infer<typeof UnitRecordSchema>;

export const OccurrenceSchema = z.object({
  id: SHA256,
  sourceId: SHA256,
  originalFilename: z.string().min(1),
  inboxRelative: z.string().min(1),
  size: z.number().int().nonnegative(),
  discoveredAt: IsoDate,
  status: z.enum(["inbox", "archived", "deduplicated", "missing"]),
  archiveRelative: z.string().optional()
}).strict();
export type Occurrence = z.infer<typeof OccurrenceSchema>;

export const SourceRecordSchema = z.object({
  id: SHA256,
  kind: z.enum(["file", "directory"]),
  format: SourceFormat,
  size: z.number().int().nonnegative(),
  inspection: InspectionSchema,
  occurrences: z.array(SHA256).min(1),
  decisions: z.record(z.string(), ClassificationDecisionSchema),
  discoveredAt: IsoDate,
  warnings: z.array(z.string())
}).strict();
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

export const ScanCandidateSchema = z.object({
  relativePath: z.string(),
  kind: z.enum(["file", "directory"]),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  stableSince: IsoDate,
  lastSeenAt: IsoDate
}).strict();

export const ArchiveTransactionSchema = z.object({
  id: SHA256,
  sourceId: SHA256,
  occurrenceId: SHA256,
  sourceRelative: z.string(),
  destinationRelative: z.string(),
  destinationSha256: SHA256.optional(),
  bundledDirectory: z.boolean(),
  status: z.enum(["prepared", "completed"]),
  preparedAt: IsoDate,
  completedAt: IsoDate.optional()
}).strict();
export type ArchiveTransaction = z.infer<typeof ArchiveTransactionSchema>;

export const ExportBuildSchema = z.object({
  generation: z.number().int().positive(),
  status: z.enum(["prepared", "validated", "activated", "failed"]),
  stageName: z.string(),
  generationName: z.string(),
  unitIds: z.array(z.string()),
  manifestSha256: SHA256.optional(),
  preparedAt: IsoDate,
  activatedAt: IsoDate.optional(),
  error: z.string().optional()
}).strict();

export const AcquisitionSchema = z.object({
  id: SHA256,
  adapter: z.string(),
  status: z.enum(["prepared", "completed", "failed"]),
  requestedAt: IsoDate,
  completedAt: IsoDate.optional(),
  sourceRelative: z.string().optional(),
  sha256: SHA256.optional(),
  manifest: z.record(z.string(), z.unknown()),
  error: z.string().optional()
}).strict();

export const CatalogSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  scanCandidates: z.record(z.string(), ScanCandidateSchema),
  sources: z.record(z.string(), SourceRecordSchema),
  occurrences: z.record(z.string(), OccurrenceSchema),
  units: z.record(z.string(), UnitRecordSchema),
  aiDecisions: z.record(z.string(), z.record(z.string(), ClassificationProposalSchema)),
  seriesMetadata: z.record(z.string(), SeriesMetadataSchema).default({}),
  archiveTransactions: z.record(z.string(), ArchiveTransactionSchema),
  exportBuilds: z.record(z.string(), ExportBuildSchema),
  activeExportGeneration: z.number().int().positive().optional(),
  acquisitions: z.record(z.string(), AcquisitionSchema)
}).strict();
export type Catalog = z.infer<typeof CatalogSchema>;

export function emptyCatalog(): Catalog {
  return {
    schemaVersion: 1,
    revision: 0,
    scanCandidates: {},
    sources: {},
    occurrences: {},
    units: {},
    aiDecisions: {},
    seriesMetadata: {},
    archiveTransactions: {},
    exportBuilds: {},
    acquisitions: {}
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}
