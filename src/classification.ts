import { spawn } from "node:child_process";
import path from "node:path";
import { ClassificationProposalSchema, nowIso, type Catalog, type ClassificationDecision, type ClassificationProposal, type InspectionUnit, type Release, type SourceRecord, type UnitRecord, type UnitType } from "./domain.js";
import type { CatalogStore } from "./catalog.js";

export interface AiClassificationContext {
  sourceId: string;
  originalFilename: string;
  inboxRelative: string;
  inspection: SourceRecord["inspection"];
  unit: InspectionUnit;
  deterministic: ClassificationProposal;
  catalogCandidates: string[];
}

export interface AiClassifier { propose(context: AiClassificationContext): Promise<unknown> }

export class CommandAiClassifier implements AiClassifier {
  constructor(private readonly command: string, private readonly args: string[] = []) {}
  async propose(context: AiClassificationContext): Promise<unknown> {
    const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "inherit"] });
    child.stdin.end(JSON.stringify(context));
    const chunks: Buffer[] = [];
    for await (const chunk of child.stdout) chunks.push(Buffer.from(chunk));
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    if (code !== 0) throw new Error(`AI classifier exited with ${code}`);
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }
}

export function slugify(value: string): string {
  const slug = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").replace(/-+/g, "-");
  return slug || "unresolved";
}

function cleanStem(filename: string): string {
  return path.basename(filename, path.extname(filename))
    .replace(/\([^)]*(?:digital|webrip|empire|dcp|\d{4}|c2c|covers?)[^)]*\)/gi, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/[_\.]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

function numericMatch(text: string, pattern: RegExp): number | undefined {
  const match = text.match(pattern)?.[1];
  return match === undefined ? undefined : Number(match);
}

function catalogMatches(catalog: Catalog, seriesSlug: string, fingerprints: string[] = []): string[] {
  const matches = new Set<string>();
  for (const unit of Object.values(catalog.units)) {
    if (unit.seriesSlug === seriesSlug || unit.seriesSlug.includes(seriesSlug) || seriesSlug.includes(unit.seriesSlug)) matches.add(unit.id);
  }
  if (fingerprints.length) {
    const wanted = new Set(fingerprints);
    for (const source of Object.values(catalog.sources)) for (const inspected of source.inspection.units) {
      if (!(inspected.contentFingerprints ?? []).some((hash) => wanted.has(hash))) continue;
      const decision = source.decisions[inspected.key];
      if (decision?.status === "accepted") matches.add(canonicalUnitId(decision.proposal));
    }
  }
  return [...matches].sort().slice(0, 20);
}

export function deterministicProposal(catalog: Catalog, source: SourceRecord, unit: InspectionUnit, originalFilename: string, inboxRelative: string): ClassificationProposal {
  const embedded = { ...source.inspection.metadata, ...unit.metadata };
  const stem = cleanStem(originalFilename);
  const unitText = unit.key === "root" ? "" : cleanStem(unit.label);
  const combined = `${stem} ${unitText}`;
  const volume = embedded.volume ?? numericMatch(combined, /\bv(?:ol(?:ume)?)?\.?\s*0*(\d+(?:\.\d+)?)/i);
  const chapter = embedded.chapter ?? numericMatch(combined, /\b(?:ch(?:apter)?|episode|ep)\.?\s*#?0*(\d+(?:\.\d+)?)/i);
  const explicitIssue = embedded.issue ?? numericMatch(combined, /\b(?:issue|no\.?|#)\s*0*(\d+(?:\.\d+)?)/i);
  const candidates = [...combined.matchAll(/(?:^|\s)0*(\d{1,4}(?:\.\d+)?)(?=\s|$)/g)].map((match) => Number(match[1])).filter((value) => value < 1900 || value > 2100);
  const structuredSequence = unit.key !== "root" ? numericMatch(unitText, /(?:^|\D)0*(\d+(?:\.\d+)?)(?:\D|$)/) : undefined;
  const sequence = embedded.sequence ?? chapter ?? explicitIssue ?? structuredSequence ?? candidates.at(-1) ?? volume;
  const issue = explicitIssue ?? (!chapter && !volume ? sequence : undefined);
  let unitType: ClassificationProposal["unitType"] = embedded.unitType ?? "unknown";
  if (unitType === "unknown") {
    if (/^prologue\b/i.test(embedded.title ?? "")) unitType = "special";
    else if (/annual/i.test(combined)) unitType = "annual";
    else if (chapter !== undefined) unitType = "chapter";
    else if (volume !== undefined && issue === undefined) unitType = "volume";
    else if (issue !== undefined) unitType = "issue";
    else if (/special|one[- ]?shot/i.test(combined)) unitType = "special";
  }
  const removePatterns = [
    /\bv(?:ol(?:ume)?)?\.?\s*0*\d+(?:\.\d+)?\b.*$/i,
    /\b(?:ch(?:apter)?|episode|ep|issue|no\.?)\.?\s*#?0*\d+(?:\.\d+)?\b.*$/i,
    /\s+#?0*\d{1,4}(?:\.\d+)?(?:\s|$).*$/i
  ];
  let inferredSeries = stem;
  for (const pattern of removePatterns) inferredSeries = inferredSeries.replace(pattern, "").trim();
  inferredSeries = inferredSeries.replace(/\s*\(?(?:19|20)\d{2}.*$/i, "").replace(/[-–—]+$/g, "").trim();
  const series = embedded.series ?? (inferredSeries || path.basename(path.dirname(inboxRelative)));
  const seriesSlug = slugify(series);
  const evidence: string[] = [];
  if (embedded.series) evidence.push("embedded metadata supplied series"); else evidence.push("series inferred from filename and inbox provenance");
  if (embedded.issue !== undefined || embedded.chapter !== undefined || embedded.volume !== undefined || embedded.sequence !== undefined) evidence.push("embedded metadata supplied sequence fields");
  else if (sequence !== undefined) evidence.push("numeric identity inferred from archive structure or filename");
  else evidence.push("no numeric identity was found");
  if (unit.contentFingerprints?.length) evidence.push(`${unit.contentFingerprints.length} page/content fingerprint(s) available for catalog matching`);
  const warnings: string[] = [];
  if (sequence === undefined) warnings.push("No issue, chapter, volume, or sequence could be established");
  if (!embedded.series) warnings.push("Series was not embedded in the source");
  let confidence = embedded.series ? 0.9 : 0.68;
  if (sequence !== undefined) confidence += embedded.issue !== undefined || embedded.chapter !== undefined || embedded.volume !== undefined ? 0.08 : 0.14;
  if (unit.key !== "root") confidence += 0.04;
  confidence = Math.min(confidence, 0.99);
  const proposal: ClassificationProposal = {
    series,
    seriesSlug,
    unitType,
    confidence,
    evidence,
    warnings,
    matchingCatalogCandidates: catalogMatches(catalog, seriesSlug, unit.contentFingerprints)
  };
  if (issue !== undefined) proposal.issue = issue;
  if (chapter !== undefined) proposal.chapter = chapter;
  if (volume !== undefined) proposal.volume = volume;
  if (sequence !== undefined) proposal.sequence = sequence;
  if (embedded.title) proposal.title = embedded.title;
  if (embedded.year) proposal.year = embedded.year;
  return ClassificationProposalSchema.parse(proposal);
}

export function canonicalUnitId(proposal: ClassificationProposal): string {
  const number = proposal.sequence ?? proposal.chapter ?? proposal.issue ?? proposal.volume;
  const numberPart = number === undefined ? "unsequenced" : String(number).replace(".", "p").padStart(4, "0");
  const volumePart = proposal.volume !== undefined && proposal.unitType !== "volume" ? `v${String(proposal.volume).padStart(3, "0")}-` : "";
  return `${proposal.seriesSlug}/${volumePart}${proposal.unitType}-${numberPart}`;
}

function upsertAcceptedUnit(catalog: Catalog, sourceId: string, unitKey: string, proposal: ClassificationProposal): void {
  const id = canonicalUnitId(proposal);
  let record = catalog.units[id];
  if (!record) {
    const release = { sourceId, unitKey, selected: true };
    record = {
      id,
      series: proposal.series,
      seriesSlug: proposal.seriesSlug,
      unitType: proposal.unitType,
      releases: [release],
      selectedRelease: { sourceId, unitKey }
    };
    if (proposal.issue !== undefined) record.issue = proposal.issue;
    if (proposal.chapter !== undefined) record.chapter = proposal.chapter;
    if (proposal.volume !== undefined) record.volume = proposal.volume;
    if (proposal.sequence !== undefined) record.sequence = proposal.sequence;
    if (proposal.title !== undefined) record.title = proposal.title;
    if (proposal.year !== undefined) record.year = proposal.year;
    catalog.units[id] = record;
  } else if (!record.releases.some((release) => release.sourceId === sourceId && release.unitKey === unitKey)) {
    record.releases.push({ sourceId, unitKey, selected: false });
  }
}

function applyProposalToUnit(unit: UnitRecord, proposal: ClassificationProposal): void {
  unit.series = proposal.series;
  unit.seriesSlug = proposal.seriesSlug;
  unit.unitType = proposal.unitType;
  for (const field of ["issue", "chapter", "volume", "sequence", "title", "year"] as const) {
    const value = proposal[field];
    if (value === undefined) delete unit[field];
    else (unit as Record<string, unknown>)[field] = value;
  }
}

function relocateAcceptedUnit(catalog: Catalog, sourceId: string, unitKey: string, proposal: ClassificationProposal): void {
  let preserved: Release | undefined;
  for (const [id, unit] of Object.entries(catalog.units)) {
    const index = unit.releases.findIndex((release) => release.sourceId === sourceId && release.unitKey === unitKey);
    if (index < 0) continue;
    const [removed] = unit.releases.splice(index, 1);
    preserved ??= removed;
    if (unit.releases.length === 0) delete catalog.units[id];
    else if (unit.selectedRelease.sourceId === sourceId && unit.selectedRelease.unitKey === unitKey) {
      const replacement = unit.releases[0]!;
      for (const release of unit.releases) release.selected = release === replacement;
      unit.selectedRelease = { sourceId: replacement.sourceId, unitKey: replacement.unitKey };
    }
  }
  upsertAcceptedUnit(catalog, sourceId, unitKey, proposal);
  const target = catalog.units[canonicalUnitId(proposal)]!;
  applyProposalToUnit(target, proposal);
  if (preserved?.normalization) {
    const attached = target.releases.find((release) => release.sourceId === sourceId && release.unitKey === unitKey)!;
    attached.normalization = preserved.normalization;
  }
}

function originalOccurrence(catalog: Catalog, source: SourceRecord): { originalFilename: string; inboxRelative: string } {
  const occurrence = source.occurrences.map((id) => catalog.occurrences[id]).find(Boolean);
  if (!occurrence) throw new Error(`Source ${source.id} has no occurrence`);
  return occurrence;
}

export async function classify(store: CatalogStore, options: { threshold?: number; ai?: AiClassifier } = {}): Promise<{ accepted: number; pending: number; rejected: number; ai: number }> {
  const catalog = await store.load();
  const threshold = options.threshold ?? 0.82;
  let accepted = 0, pending = 0, rejected = 0, aiCount = 0;
  for (const source of Object.values(catalog.sources)) {
    const occurrence = originalOccurrence(catalog, source);
    for (const unit of source.inspection.units) {
      const existing = source.decisions[unit.key];
      if (existing?.status === "accepted") { upsertAcceptedUnit(catalog, source.id, unit.key, existing.proposal); accepted += 1; continue; }
      if (existing?.status === "rejected") { rejected += 1; continue; }
      let proposal = deterministicProposal(catalog, source, unit, occurrence.originalFilename, occurrence.inboxRelative);
      let proposalSource: ClassificationDecision["proposalSource"] = "deterministic";
      const persistedAi = catalog.aiDecisions[source.id]?.[unit.key];
      if (persistedAi) { proposal = persistedAi; proposalSource = "ai"; aiCount += 1; }
      else if (options.ai && proposal.confidence < threshold) {
        const aiRaw = await options.ai.propose({
          sourceId: source.id,
          originalFilename: occurrence.originalFilename,
          inboxRelative: occurrence.inboxRelative,
          inspection: source.inspection,
          unit,
          deterministic: proposal,
          catalogCandidates: proposal.matchingCatalogCandidates
        });
        proposal = ClassificationProposalSchema.parse(aiRaw);
        catalog.aiDecisions[source.id] ??= {};
        catalog.aiDecisions[source.id]![unit.key] = proposal;
        proposalSource = "ai";
        aiCount += 1;
      }
      const status: ClassificationDecision["status"] = proposal.confidence >= threshold && proposal.sequence !== undefined ? "accepted" : "pending";
      source.decisions[unit.key] = { unitKey: unit.key, status, proposal, proposalSource, warnings: [...proposal.warnings] };
      if (status === "accepted") { upsertAcceptedUnit(catalog, source.id, unit.key, proposal); accepted += 1; }
      else pending += 1;
    }
  }
  await store.save(catalog);
  return { accepted, pending, rejected, ai: aiCount };
}

function findDecision(catalog: Catalog, selector: string): { source: SourceRecord; unitKey: string; decision: ClassificationDecision } {
  const separator = selector.indexOf(":");
  if (separator < 0) throw new Error("Review selector must be <source-sha256>:<unit-key>");
  const sourceId = selector.slice(0, separator);
  const unitKey = selector.slice(separator + 1);
  const source = catalog.sources[sourceId];
  const decision = source?.decisions[unitKey];
  if (!source || !decision) throw new Error(`Unknown review item: ${selector}`);
  return { source, unitKey, decision };
}

export async function review(store: CatalogStore, options: { acceptAll?: boolean; accept?: string; reject?: string; correction?: { selector: string; proposal: unknown }; retype?: { seriesSlug: string; fromUnitType?: UnitType; unitType: UnitType }; selectRelease?: { unitId: string; sourceId: string; unitKey: string } } = {}): Promise<Array<{ selector: string; decision: ClassificationDecision }>> {
  const catalog = await store.load();
  if (options.selectRelease) {
    const unit = catalog.units[options.selectRelease.unitId];
    if (!unit) throw new Error(`Unknown logical unit: ${options.selectRelease.unitId}`);
    const selected = unit.releases.find((release) => release.sourceId === options.selectRelease!.sourceId && release.unitKey === options.selectRelease!.unitKey);
    if (!selected) throw new Error("Selected release is not attached to the logical unit");
    for (const release of unit.releases) release.selected = release === selected;
    unit.selectedRelease = { sourceId: selected.sourceId, unitKey: selected.unitKey };
  }
  if (options.correction) {
    const item = findDecision(catalog, options.correction.selector);
    item.decision.proposal = ClassificationProposalSchema.parse(options.correction.proposal);
    item.decision.proposalSource = "human";
    item.decision.status = "accepted";
    item.decision.reviewedAt = nowIso();
    relocateAcceptedUnit(catalog, item.source.id, item.unitKey, item.decision.proposal);
  }
  if (options.retype) {
    for (const source of Object.values(catalog.sources)) for (const [unitKey, decision] of Object.entries(source.decisions)) {
      if (decision.status !== "accepted" || decision.proposal.seriesSlug !== options.retype.seriesSlug) continue;
      if (options.retype.fromUnitType && decision.proposal.unitType !== options.retype.fromUnitType) continue;
      decision.proposal = ClassificationProposalSchema.parse({ ...decision.proposal, unitType: options.retype.unitType });
      decision.proposalSource = "human";
      decision.reviewedAt = nowIso();
      relocateAcceptedUnit(catalog, source.id, unitKey, decision.proposal);
    }
  }
  if (options.accept) {
    const item = findDecision(catalog, options.accept);
    item.decision.status = "accepted";
    item.decision.proposalSource = "human";
    item.decision.reviewedAt = nowIso();
    upsertAcceptedUnit(catalog, item.source.id, item.unitKey, item.decision.proposal);
  }
  if (options.reject) {
    const item = findDecision(catalog, options.reject);
    item.decision.status = "rejected";
    item.decision.proposalSource = "human";
    item.decision.reviewedAt = nowIso();
  }
  if (options.acceptAll) {
    for (const source of Object.values(catalog.sources)) for (const [unitKey, decision] of Object.entries(source.decisions)) {
      if (decision.status !== "pending") continue;
      if (decision.proposal.sequence === undefined) continue;
      decision.status = "accepted"; decision.proposalSource = "human"; decision.reviewedAt = nowIso();
      upsertAcceptedUnit(catalog, source.id, unitKey, decision.proposal);
    }
  }
  await store.save(catalog);
  const pending: Array<{ selector: string; decision: ClassificationDecision }> = [];
  for (const source of Object.values(catalog.sources)) for (const [unitKey, decision] of Object.entries(source.decisions)) {
    if (decision.status === "pending") pending.push({ selector: `${source.id}:${unitKey}`, decision });
  }
  return pending;
}
