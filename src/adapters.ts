import { execFile } from "node:child_process";
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { XMLParser } from "fast-xml-parser";
import { createExtractorFromFile } from "node-unrar-js";
import { z } from "zod";
import { EmbeddedMetadataSchema, InspectionSchema, UnitType, type EmbeddedMetadata, type Inspection, type InspectionUnit, type SourceFormat } from "./domain.js";
import { isPartialName, listTree, safeJoin, sha256File } from "./fs.js";
import { extractZipEntries, listZip, readZipEntry, sha256ZipEntry } from "./zip.js";

const execFileAsync = promisify(execFile);
export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".tif", ".tiff", ".bmp"]);
const ARCHIVE_EXTENSIONS = new Set([".cbz", ".zip", ".epub", ".cbr", ".rar", ".pdf"]);

export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

function imageName(name: string): boolean {
  const base = path.basename(name).toLowerCase();
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()) && !/^(?:thumb|thumbnail|cover-thumb)\./.test(base);
}
function nestedArchiveName(name: string): boolean { return ARCHIVE_EXTENSIONS.has(path.extname(name).toLowerCase()) && !name.toLowerCase().endsWith(".epub"); }

const CollectionManifestSchema = z.object({
  series: z.string().min(1),
  chapters: z.record(z.string(), z.object({
    displayNumber: z.string().min(1),
    pageCount: z.number().int().nonnegative(),
    localPageCount: z.number().int().nonnegative(),
    status: z.string()
  }).passthrough())
}).passthrough();
type CollectionManifest = z.infer<typeof CollectionManifestSchema>;

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const list = value.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

export function parseComicInfo(xml: string): EmbeddedMetadata {
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
  const parsed = parser.parse(xml) as { ComicInfo?: Record<string, unknown> };
  const info = parsed.ComicInfo ?? {};
  const metadata: EmbeddedMetadata = {};
  if (typeof info.Series === "string" && info.Series.trim()) metadata.series = info.Series.trim();
  if (typeof info.YarReaderUnitType === "string" && UnitType.safeParse(info.YarReaderUnitType).success) metadata.unitType = UnitType.parse(info.YarReaderUnitType);
  if (typeof info.Title === "string" && info.Title.trim()) metadata.title = info.Title.trim();
  const issue = numberValue(info.Number); if (issue !== undefined) metadata.issue = issue;
  const volume = numberValue(info.Volume); if (volume !== undefined) metadata.volume = volume;
  const canonicalSequence = numberValue(info.YarReaderSequence); if (canonicalSequence !== undefined) metadata.sequence = canonicalSequence;
  const year = numberValue(info.Year); if (year !== undefined && Number.isInteger(year)) metadata.year = year;
  const authors = stringList(info.Writer); if (authors) metadata.authors = authors;
  const artists = stringList([info.Penciller, info.Inker, info.Colorist].filter(Boolean).join(",")); if (artists) metadata.artists = artists;
  if (typeof info.Publisher === "string") metadata.publisher = info.Publisher;
  if (typeof info.LanguageISO === "string") metadata.language = info.LanguageISO;
  const tags = stringList(info.Genre); if (tags) metadata.tags = tags;
  if (typeof info.Summary === "string") metadata.summary = info.Summary;
  if (String(info.Manga).toLowerCase().includes("yes")) metadata.direction = "rtl";
  return EmbeddedMetadataSchema.parse(metadata);
}

function groupsFromEntries(allNames: string[], metadata: EmbeddedMetadata): InspectionUnit[] {
  const images = allNames.filter(imageName).sort(naturalCompare);
  const nested = allNames.filter(nestedArchiveName).sort(naturalCompare);
  if (images.length === 0 && nested.length > 0) {
    return nested.map((name) => ({ key: `nested:${name}`, label: path.basename(name, path.extname(name)), entryNames: [name], pageCount: 0, metadata: {}, warnings: ["Nested archive page count is verified during normalization"] }));
  }
  if (images.length === 0) throw new Error("Source contains no supported page images or nested archives");
  const rootImages = images.filter((name) => !name.includes("/"));
  const nestedImages = images.filter((name) => name.includes("/"));
  const onlyAncillaryRootImages = rootImages.length > 0 && rootImages.every((name) => /^(?:cover|folder)\.[^.]+$/i.test(path.basename(name)));
  if (rootImages.length > 0 && !(onlyAncillaryRootImages && nestedImages.length > 0)) {
    return [{ key: "root", label: "root", entryNames: images, pageCount: images.length, metadata, warnings: [] }];
  }
  const groups = new Map<string, string[]>();
  for (const name of nestedImages) {
    const top = name.split("/")[0]!;
    const list = groups.get(top) ?? [];
    list.push(name);
    groups.set(top, list);
  }
  return [...groups.entries()].sort(([a], [b]) => naturalCompare(a, b)).map(([key, entryNames]) => ({
    key,
    label: key,
    entryNames: entryNames.sort(naturalCompare),
    pageCount: entryNames.length,
    metadata,
    warnings: []
  }));
}

function applyCollectionManifest(units: InspectionUnit[], manifest: CollectionManifest): void {
  for (const unit of units) {
    const chapter = manifest.chapters[unit.key];
    if (!chapter) continue;
    const display = Number(chapter.displayNumber);
    const keyNumber = Number(unit.key);
    const metadata: EmbeddedMetadata = { series: manifest.series, unitType: "chapter" };
    if (/-b$/i.test(unit.key) && Number.isFinite(display)) {
      metadata.sequence = 1000 + display;
      metadata.unitType = "special";
      metadata.title = `Prologue ${chapter.displayNumber}`;
    } else if (Number.isFinite(keyNumber)) {
      metadata.chapter = keyNumber;
      metadata.sequence = keyNumber;
    } else if (Number.isFinite(display)) {
      metadata.chapter = display;
      metadata.sequence = display;
    }
    unit.metadata = EmbeddedMetadataSchema.parse({ ...unit.metadata, ...metadata });
    if (chapter.status !== "complete") unit.warnings.push(`Collection manifest status is ${chapter.status}`);
    if (chapter.localPageCount !== unit.pageCount || chapter.pageCount !== unit.pageCount) {
      unit.warnings.push(`Collection manifest page count ${chapter.localPageCount}/${chapter.pageCount} differs from ${unit.pageCount} entries`);
    }
  }
}

async function zipMetadata(file: string, names: string[]): Promise<EmbeddedMetadata> {
  const comicInfo = names.find((name) => /(^|\/)ComicInfo\.xml$/i.test(name));
  if (!comicInfo) return {};
  const buffer = await readZipEntry(file, comicInfo);
  return buffer ? parseComicInfo(buffer.toString("utf8")) : {};
}

async function inspectZip(file: string, format: SourceFormat): Promise<Inspection> {
  const entries = await listZip(file);
  const names = entries.filter((entry) => !entry.directory).map((entry) => entry.name);
  let metadata = await zipMetadata(file, names);
  const units = groupsFromEntries(names, metadata);
  for (const unit of units.filter((candidate) => candidate.key.startsWith("nested:"))) {
    const nestedName = unit.entryNames[0]!;
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "yarreader-nested-inspect-"));
    try {
      const nestedPath = path.join(temporaryRoot, `nested${path.extname(nestedName).toLowerCase()}`);
      await extractZipEntries(file, new Map([[nestedName, nestedPath]]));
      const nestedInspection = await inspectSource(nestedPath);
      if (nestedInspection.units.length !== 1) throw new Error(`Nested source has ${nestedInspection.units.length} logical units; explicit review is required`);
      const nestedUnit = nestedInspection.units[0]!;
      unit.pageCount = nestedUnit.pageCount;
      unit.metadata = EmbeddedMetadataSchema.parse({ ...unit.metadata, ...nestedInspection.metadata, ...nestedUnit.metadata });
      unit.warnings = [...nestedInspection.warnings, ...nestedUnit.warnings];
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
  const manifestName = names.find((name) => name === "manifest.json");
  if (manifestName) {
    const manifestBytes = await readZipEntry(file, manifestName, 16 * 1024 * 1024);
    if (manifestBytes) {
      const parsed = CollectionManifestSchema.safeParse(JSON.parse(manifestBytes.toString("utf8")) as unknown);
      if (parsed.success) {
        metadata = EmbeddedMetadataSchema.parse({ ...metadata, series: parsed.data.series });
        applyCollectionManifest(units, parsed.data);
      }
    }
  }
  for (const unit of units) {
    const sampleNames = [...new Set([unit.entryNames[0], unit.entryNames.at(-1)].filter((name): name is string => Boolean(name)))];
    const fingerprints = (await Promise.all(sampleNames.map((name) => sha256ZipEntry(file, name)))).filter((hash): hash is string => Boolean(hash));
    if (fingerprints.length) unit.contentFingerprints = fingerprints;
  }
  return InspectionSchema.parse({ adapter: format === "epub" ? "epub" : "zip", format, metadata, units, warnings: [] });
}

function findDeepValues(node: unknown, key: string, output: string[] = []): string[] {
  if (!node || typeof node !== "object") return output;
  for (const [entryKey, value] of Object.entries(node as Record<string, unknown>)) {
    if (entryKey === key && typeof value === "string") output.push(value);
    else findDeepValues(value, key, output);
  }
  return output;
}

async function inspectEpub(file: string): Promise<Inspection> {
  const base = await inspectZip(file, "epub");
  const entries = await listZip(file);
  const names = entries.map((entry) => entry.name);
  const container = await readZipEntry(file, "META-INF/container.xml");
  let metadata: EmbeddedMetadata = {};
  if (container) {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });
    const parsedContainer = parser.parse(container.toString("utf8"));
    const roots = findDeepValues(parsedContainer, "@_full-path");
    const opfName = roots[0];
    if (opfName && names.includes(opfName)) {
      const opf = await readZipEntry(file, opfName);
      if (opf) {
        const parsed = parser.parse(opf.toString("utf8")) as Record<string, unknown>;
        const first = (name: string): string | undefined => findDeepValues(parsed, name)[0];
        const title = first("dc:title"); if (title) metadata.title = title;
        const creator = first("dc:creator"); if (creator) metadata.authors = [creator];
        const publisher = first("dc:publisher"); if (publisher) metadata.publisher = publisher;
        const language = first("dc:language"); if (language) metadata.language = language;
        const date = first("dc:date"); const year = date?.match(/\b(\d{4})\b/)?.[1]; if (year) metadata.year = Number(year);
      }
    }
  }
  const units = base.units.map((unit) => ({ ...unit, metadata: { ...unit.metadata, ...metadata } }));
  return InspectionSchema.parse({ ...base, metadata, units });
}

async function inspectDirectory(directory: string): Promise<Inspection> {
  const names = await listTree(directory);
  let metadata: EmbeddedMetadata = {};
  const comicInfo = names.find((name) => /(^|\/)ComicInfo\.xml$/i.test(name));
  if (comicInfo) metadata = parseComicInfo(await readFile(safeJoin(directory, ...comicInfo.split("/")), "utf8"));
  const units = groupsFromEntries(names, metadata);
  const manifestName = names.find((name) => name === "manifest.json");
  if (manifestName) {
    const parsed = CollectionManifestSchema.safeParse(JSON.parse(await readFile(safeJoin(directory, manifestName), "utf8")) as unknown);
    if (parsed.success) {
      metadata = EmbeddedMetadataSchema.parse({ ...metadata, series: parsed.data.series });
      applyCollectionManifest(units, parsed.data);
    }
  }
  for (const unit of units) {
    const sampleNames = [...new Set([unit.entryNames[0], unit.entryNames.at(-1)].filter((name): name is string => Boolean(name)))];
    if (sampleNames.length) unit.contentFingerprints = await Promise.all(sampleNames.map((name) => sha256File(safeJoin(directory, ...name.split("/")))));
  }
  return InspectionSchema.parse({ adapter: "loose-directory", format: "directory", metadata, units, warnings: [] });
}

async function inspectPdf(file: string): Promise<Inspection> {
  let pageCount = 0;
  let metadata: EmbeddedMetadata = {};
  const warnings: string[] = [];
  try {
    const { stdout } = await execFileAsync("pdfinfo", [file], { maxBuffer: 2 * 1024 * 1024 });
    const fields = new Map(stdout.split(/\r?\n/).map((line) => {
      const index = line.indexOf(":");
      return index > 0 ? [line.slice(0, index).trim(), line.slice(index + 1).trim()] : ["", ""];
    }));
    pageCount = Number(fields.get("Pages") ?? 0);
    const title = fields.get("Title"); if (title) metadata.title = title;
    const author = fields.get("Author"); if (author) metadata.authors = [author];
  } catch (error) {
    warnings.push(`pdfinfo unavailable or failed: ${(error as Error).message}`);
  }
  return InspectionSchema.parse({ adapter: "pdf", format: "pdf", metadata, units: [{ key: "root", label: "root", entryNames: [], pageCount, contentFingerprints: [await sha256File(file)], metadata, warnings }], warnings });
}

async function inspectRar(file: string, format: "cbr" | "rar"): Promise<Inspection> {
  const extractor = await createExtractorFromFile({ filepath: file });
  const headers = [...extractor.getFileList().fileHeaders];
  const names = headers.filter((header) => !header.flags.directory).map((header) => header.name.replaceAll("\\", "/"));
  for (const name of names) {
    if (name.startsWith("/") || name.split("/").includes("..")) throw new Error(`Unsafe RAR entry name: ${name}`);
  }
  const units = groupsFromEntries(names, {});
  const sourceFingerprint = await sha256File(file);
  for (const unit of units) unit.contentFingerprints = [sourceFingerprint];
  return InspectionSchema.parse({ adapter: "rar", format, metadata: {}, units, warnings: [] });
}

export function formatFromPath(sourcePath: string, directory: boolean): SourceFormat | undefined {
  if (directory) return "directory";
  const extension = path.extname(sourcePath).toLowerCase();
  if (extension === ".cbz") return "cbz";
  if (extension === ".zip") return "zip";
  if (extension === ".epub") return "epub";
  if (extension === ".pdf") return "pdf";
  if (extension === ".cbr") return "cbr";
  if (extension === ".rar") return "rar";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  return undefined;
}

export async function inspectSource(sourcePath: string, forcedFormat?: SourceFormat): Promise<Inspection> {
  const info = await lstat(sourcePath);
  if (info.isSymbolicLink()) throw new Error(`Symbolic media input rejected: ${sourcePath}`);
  const format = forcedFormat ?? formatFromPath(sourcePath, info.isDirectory());
  if (!format) throw new Error(`Unsupported source format: ${sourcePath}`);
  if (format === "directory") return inspectDirectory(sourcePath);
  if (format === "cbz" || format === "zip") return inspectZip(sourcePath, format);
  if (format === "epub") return inspectEpub(sourcePath);
  if (format === "pdf") return inspectPdf(sourcePath);
  if (format === "cbr" || format === "rar") return inspectRar(sourcePath, format);
  return InspectionSchema.parse({ adapter: "image", format: "image", metadata: {}, units: [{ key: "root", label: "root", entryNames: [path.basename(sourcePath)], pageCount: 1, contentFingerprints: [await sha256File(sourcePath)], metadata: {}, warnings: [] }], warnings: [] });
}

export async function extractUnit(sourcePath: string, format: SourceFormat, unit: InspectionUnit, destination: string): Promise<string[]> {
  await mkdir(destination, { recursive: true });
  if (format === "directory") {
    const outputs: string[] = [];
    for (let index = 0; index < unit.entryNames.length; index += 1) {
      const name = unit.entryNames[index]!;
      const output = path.join(destination, `${String(index + 1).padStart(6, "0")}${path.extname(name).toLowerCase()}`);
      await copyFile(safeJoin(sourcePath, ...name.split("/")), output);
      outputs.push(output);
    }
    return outputs;
  }
  if (format === "cbz" || format === "zip" || format === "epub") {
    if (unit.key.startsWith("nested:")) {
      const nestedName = unit.entryNames[0]!;
      const nestedPath = path.join(destination, `nested${path.extname(nestedName).toLowerCase()}`);
      await extractZipEntries(sourcePath, new Map([[nestedName, nestedPath]]));
      const nestedInspection = await inspectSource(nestedPath);
      if (nestedInspection.units.length !== 1) throw new Error(`Nested source has ${nestedInspection.units.length} logical units; explicit review is required`);
      return extractUnit(nestedPath, nestedInspection.format, nestedInspection.units[0]!, path.join(destination, "nested-pages"));
    }
    const mapping = new Map<string, string>();
    const outputs: string[] = [];
    for (let index = 0; index < unit.entryNames.length; index += 1) {
      const name = unit.entryNames[index]!;
      const output = path.join(destination, `${String(index + 1).padStart(6, "0")}${path.extname(name).toLowerCase()}`);
      mapping.set(name, output); outputs.push(output);
    }
    await extractZipEntries(sourcePath, mapping);
    return outputs;
  }
  if (format === "cbr" || format === "rar") {
    const rarRoot = path.join(destination, "rar");
    await mkdir(rarRoot, { recursive: true });
    const extractor = await createExtractorFromFile({ filepath: sourcePath, targetPath: rarRoot });
    [...extractor.extract({ files: unit.entryNames }).files];
    return unit.entryNames.map((name) => safeJoin(rarRoot, ...name.replaceAll("\\", "/").split("/")));
  }
  if (format === "pdf") {
    const prefix = path.join(destination, "page");
    await execFileAsync("pdftoppm", ["-png", "-r", "144", sourcePath, prefix], { maxBuffer: 8 * 1024 * 1024 });
    return (await readdir(destination)).filter((name) => /^page-\d+\.png$/i.test(name)).sort(naturalCompare).map((name) => path.join(destination, name));
  }
  const output = path.join(destination, `000001${path.extname(sourcePath).toLowerCase()}`);
  await copyFile(sourcePath, output);
  return [output];
}

export async function directoryContainsPages(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.some((entry) => entry.isFile() && imageName(entry.name));
}

export async function isSupportedPath(candidate: string): Promise<boolean> {
  if (isPartialName(path.basename(candidate))) return false;
  const info = await lstat(candidate);
  if (info.isSymbolicLink()) return false;
  if (info.isDirectory()) {
    const files = await listTree(candidate);
    return files.some(imageName);
  }
  return Boolean(formatFromPath(candidate, false));
}
