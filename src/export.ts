import { copyFile, cp, link, lstat, mkdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import sharp from "sharp";
import type { CatalogStore } from "./catalog.js";
import { nowIso, type Catalog, type UnitRecord } from "./domain.js";
import { fsyncDirectory, fsyncFile, listTree, safeJoin, sha256File } from "./fs.js";
import { verifyNormalization } from "./normalization.js";
import { applyCatalogCuration, loadSeriesCuration } from "./series-metadata.js";

const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  generation: z.number().int().positive(),
  units: z.array(z.object({ id: z.string(), pageCount: z.number().int().positive() }).strict()),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/))
}).strict();
type Manifest = z.infer<typeof ManifestSchema>;

export interface ExportHooks { beforeActivation?: (stage: string) => Promise<void> }

async function runBounded<T>(items: readonly T[], concurrency: number, task: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await task(items[index]!, index);
    }
  }));
}

function selectedRelease(unit: UnitRecord) {
  return unit.releases.find((release) => release.sourceId === unit.selectedRelease.sourceId && release.unitKey === unit.selectedRelease.unitKey);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const VIEWER_ASSET_NAMES = ["reader.js", "library.js", "reader.css", "library.css"] as const;
const VIEWER_ROOT = fileURLToPath(new URL("../viewer/", import.meta.url));
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Library"><rect width="64" height="64" rx="12" fill="#17191f"/><rect x="12" y="14" width="12" height="36" rx="2" fill="#6ea8fe"/><rect x="27" y="14" width="10" height="36" rx="2" fill="#9aa1b1"/><rect x="40" y="18" width="12" height="32" rx="2" fill="#e8eaf0"/></svg>\n`;
const FALLBACK_CSS = `:root{color-scheme:dark;background:#111;color:#eee;font:16px system-ui,sans-serif}body{margin:0 auto;max-width:80rem;padding:1rem}a{color:#9bd}.yar-static-library section{border-top:1px solid #333;margin-top:1rem}.yar-static-library ol{line-height:1.7}.yar-reader-body{max-width:none;padding:0}.reader-fallback header{position:sticky;top:0;background:#111e;padding:.6rem;z-index:2}.reader-fallback img{display:block;max-width:100%;height:auto;margin:0 auto}`;

function jsString(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function unitTitle(unit: UnitRecord): string {
  if (unit.title) return unit.title;
  const number = unit.chapter ?? unit.issue ?? unit.volume ?? unit.sequence;
  const label = unit.unitType.charAt(0).toUpperCase() + unit.unitType.slice(1);
  return number === undefined ? label : `${label} ${number}`;
}

function libraryMarkup(units: readonly UnitRecord[]): string {
  const groups = new Map<string, UnitRecord[]>();
  for (const unit of units) {
    const group = groups.get(unit.series) ?? [];
    group.push(unit);
    groups.set(unit.series, group);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true, sensitivity: "base" }))
    .map(([series, members]) => {
      const items = members.map((unit) => {
        const href = path.posix.join("library", unit.id, "index.html");
        return `<li><a href="${escapeHtml(href)}">${escapeHtml(unitTitle(unit))}</a></li>`;
      }).join("");
      return `<section><h2>${escapeHtml(series)}</h2><ol>${items}</ol></section>`;
    }).join("");
}

function unitMetadata(unit: UnitRecord, catalog: Catalog) {
  const release = selectedRelease(unit)!;
  const source = catalog.sources[release.sourceId];
  const inspectedUnit = source?.inspection.units.find((candidate) => candidate.key === release.unitKey);
  return { ...(source?.inspection.metadata ?? {}), ...(inspectedUnit?.metadata ?? {}) };
}

function catalogPayload(units: UnitRecord[], catalog: Catalog, seriesCovers: ReadonlySet<string>): string {
  const items = units.map((unit) => {
    const release = selectedRelease(unit)!;
    const normalization = release.normalization!;
    const metadata = unitMetadata(unit, catalog);
    const firstPage = path.basename(normalization.pages[0]!.file);
    const firstMatch = /^(\d+)\.([a-z0-9]+)$/i.exec(firstPage);
    if (!firstMatch) throw new Error(`Normalized page is not canonically numbered: ${unit.id}:${firstPage}`);
    const pageDigits = firstMatch[1]!.length;
    const pageExtension = firstMatch[2]!.toLowerCase();
    normalization.pages.forEach((page, index) => {
      const expected = `${pad(index + 1, pageDigits)}.${pageExtension}`;
      if (path.basename(page.file).toLowerCase() !== expected.toLowerCase()) throw new Error(`Normalized page sequence is not canonical: ${unit.id}:${page.file}`);
    });
    const itemPath = `library/${unit.id}/`;
    const sequence = unit.sequence ?? unit.chapter ?? unit.issue ?? unit.volume ?? 0;
    const discoveredAt = catalog.sources[release.sourceId]?.discoveredAt;
    const seriesMetadata = catalog.seriesMetadata[unit.seriesSlug];
    const readingMode = seriesMetadata?.readingMode ?? metadata.readingMode ?? (metadata.direction === "rtl" ? "rtl" : "ltr");
    const genres = [...new Map([
      ...(seriesMetadata?.genres ?? []),
      ...(metadata.genres ?? []),
      ...(metadata.tags ?? [])
    ].map((genre) => [genre.toLocaleLowerCase("en"), genre])).values()].sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));
    return {
      path: itemPath,
      seriesSlug: unit.seriesSlug,
      series: unit.series,
      title: unitTitle(unit),
      ...(unit.volume !== undefined ? { volume: unit.volume } : {}),
      ...(unit.chapter !== undefined ? { chapter: unit.chapter } : {}),
      ...(unit.issue !== undefined ? { issue: unit.issue } : {}),
      sequence,
      ...(unit.year !== undefined ? { year: unit.year } : {}),
      ...(metadata.authors?.length ? { authors: metadata.authors } : {}),
      ...(metadata.artists?.length ? { artists: metadata.artists } : {}),
      ...(metadata.publisher ? { publisher: metadata.publisher } : {}),
      ...(metadata.tags?.length ? { tags: metadata.tags } : {}),
      ...(genres.length ? { genres } : {}),
      ...(metadata.summary ? { summary: metadata.summary } : {}),
      ...(metadata.language ? { language: metadata.language } : {}),
      readingMode,
      direction: readingMode === "rtl" ? "rtl" : "ltr",
      pageCount: normalization.pageCount,
      pageExtension,
      pageRoot: "pages/",
      pageDigits,
      ...(readingMode === "scroll" ? { pageSizes: normalization.pages.map((page) => [page.width, page.height]) } : {}),
      cover: `${itemPath}pages/${firstPage}`,
      thumbnail: `${itemPath}thumbnail.webp`,
      ...(seriesCovers.has(unit.seriesSlug) ? { seriesCover: `covers/${unit.seriesSlug}.webp` } : {}),
      added: discoveredAt ? Math.floor(Date.parse(discoveredAt) / 1000) : 0,
      sortTitle: `${unit.series.toLocaleLowerCase("en")} ${pad(sequence, 8)}`
    };
  });
  const payload = JSON.stringify({ schemaVersion: 1, generator: "YarReader", itemCount: items.length, items }).replaceAll("<", "\\u003c");
  return `window.COMIC_LIBRARY = ${payload};\nwindow.YAR_LIBRARY = window.COMIC_LIBRARY;\n`;
}

async function writeAndSync(file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await fsyncFile(file);
}

async function writeViewerAssets(stage: string): Promise<void> {
  for (const name of VIEWER_ASSET_NAMES) {
    await writeAndSync(path.join(stage, name), await readFile(path.join(VIEWER_ROOT, name)));
  }
  await writeAndSync(path.join(stage, "assets", "favicon.svg"), FAVICON);
}

function renderRootHtml(units: readonly UnitRecord[]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="generator" content="YarReader">
<title>YarReader</title>
<link rel="icon" href="./assets/favicon.svg" type="image/svg+xml">
<style>${FALLBACK_CSS}</style>
<link rel="stylesheet" href="./reader.css">
<link rel="stylesheet" href="./library.css">
</head>
<body class="yar-library-body">
<h1>YarReader</h1>
<main id="library" data-library class="yar-static-library">${libraryMarkup(units)}</main>
<script src="./catalog.js"></script>
<script src="./library.js"></script>
<script>
  ComicLibrary.start({ root: "./", label: "YarReader" });
</script>
</body>
</html>
`;
}

function renderLeafHtml(unit: UnitRecord, rootPrefix: string, pageNames: readonly string[]): string {
  const itemPath = `library/${unit.id}/`;
  const pageMarkup = pageNames.map((page, index) =>
    `<img src="pages/${escapeHtml(page)}" loading="${index === 0 ? "eager" : "lazy"}" decoding="async" alt="Page ${index + 1}">`
  ).join("");
  return `<!doctype html>
<html lang="en" data-yar-unit="${escapeHtml(itemPath)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="generator" content="YarReader">
<title>${escapeHtml(`${unit.series} - ${unitTitle(unit)}`)}</title>
<link rel="icon" href="${rootPrefix}assets/favicon.svg" type="image/svg+xml">
<style>${FALLBACK_CSS}</style>
<link rel="stylesheet" href="${rootPrefix}reader.css">
</head>
<body class="yar-reader-body">
<main id="reader" class="reader-fallback" data-pages><header><a href="${rootPrefix}index.html">Library</a> · ${escapeHtml(unit.series)}</header>${pageMarkup}</main>
<script src="${rootPrefix}catalog.js"></script>
<script src="${rootPrefix}reader.js"></script>
<script>
  ComicReader.start({ path: ${jsString(itemPath)}, root: ${jsString(rootPrefix)} });
</script>
</body>
</html>
`;
}

async function publishImmutable(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
    await copyFile(source, destination);
  }
  await fsyncFile(destination);
}

async function publishSeriesCovers(store: CatalogStore, stage: string, units: readonly UnitRecord[]): Promise<Set<string>> {
  const available = new Set<string>();
  for (const slug of new Set(units.map((unit) => unit.seriesSlug))) {
    const source = safeJoin(store.paths.covers, `${slug}.webp`);
    try {
      const info = await stat(source);
      if (!info.isFile()) continue;
      await mkdir(path.join(stage, "covers"), { recursive: true });
      await publishImmutable(source, path.join(stage, "covers", `${slug}.webp`));
      available.add(slug);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return available;
}

async function unitThumbnail(store: CatalogStore, normalization: NonNullable<ReturnType<typeof selectedRelease>>["normalization"]): Promise<string> {
  if (!normalization?.pages.length) throw new Error("Cannot generate a thumbnail for an empty normalization");
  const firstPage = normalization.pages[0]!;
  const destination = safeJoin(store.paths.thumbnails, `${firstPage.sha256}.webp`);
  try {
    const info = await stat(destination);
    if (info.isFile() && info.size > 0) return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(store.paths.thumbnails, { recursive: true });
  const sourceRoot = safeJoin(store.paths.work, ...normalization.workRelative.split("/"));
  const temporary = path.join(store.paths.thumbnails, `.${firstPage.sha256}.${process.pid}.webp.tmp`);
  await rm(temporary, { force: true });
  try {
    await sharp(safeJoin(sourceRoot, firstPage.file))
      .rotate()
      .resize(320, 480, { fit: "cover", position: "attention" })
      .webp({ quality: 74, effort: 4 })
      .toFile(temporary);
    await fsyncFile(temporary);
    await rename(temporary, destination);
    await fsyncDirectory(store.paths.thumbnails);
    return destination;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function buildStage(store: CatalogStore, catalog: Catalog, stage: string, generation: number): Promise<Manifest> {
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  const units = Object.values(catalog.units).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  await runBounded(units, 8, async (unit) => {
    const release = selectedRelease(unit);
    if (!release?.normalization || !(await verifyNormalization(store, release.normalization))) throw new Error(`Selected release is not normalized: ${unit.id}`);
  });
  await writeViewerAssets(stage);
  const seriesCovers = await publishSeriesCovers(store, stage, units);
  await writeAndSync(path.join(stage, "catalog.js"), catalogPayload(units, catalog, seriesCovers));
  await writeAndSync(path.join(stage, "index.html"), renderRootHtml(units));
  const manifestUnits: Manifest["units"] = [];
  for (const unit of units) {
    const normalization = selectedRelease(unit)!.normalization!;
    const unitRoot = safeJoin(stage, "library", ...unit.id.split("/"));
    const pagesRoot = path.join(unitRoot, "pages");
    await mkdir(pagesRoot, { recursive: true });
    const sourceRoot = safeJoin(store.paths.work, ...normalization.workRelative.split("/"));
    const pageNames = normalization.pages.map((page) => path.basename(page.file));
    await runBounded(normalization.pages, 8, async (page, index) => {
      const outputName = pageNames[index]!;
      const expectedName = `${pad(index + 1, outputName.slice(0, outputName.indexOf(".")).length)}${path.extname(outputName)}`;
      if (outputName.toLowerCase() !== expectedName.toLowerCase()) throw new Error(`Normalized page sequence is not canonical: ${unit.id}:${page.file}`);
      await publishImmutable(safeJoin(sourceRoot, page.file), path.join(pagesRoot, outputName));
    });
    await publishImmutable(await unitThumbnail(store, normalization), path.join(unitRoot, "thumbnail.webp"));
    const rootPrefix = "../".repeat(unit.id.split("/").length + 1);
    await writeAndSync(path.join(unitRoot, "index.html"), renderLeafHtml(unit, rootPrefix, pageNames));
    await fsyncDirectory(pagesRoot);
    await fsyncDirectory(unitRoot);
    manifestUnits.push({ id: unit.id, pageCount: normalization.pages.length });
  }

  const files: Record<string, string> = {};
  const stagedFiles = await listTree(stage);
  const stagedHashes = new Array<string>(stagedFiles.length);
  await runBounded(stagedFiles, 16, async (relative, index) => {
    stagedHashes[index] = await sha256File(safeJoin(stage, ...relative.split("/")));
  });
  stagedFiles.forEach((relative, index) => { files[relative] = stagedHashes[index]!; });
  const manifest = ManifestSchema.parse({ schemaVersion: 1, generation, units: manifestUnits, files });
  await writeAndSync(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await fsyncDirectory(stage);
  return manifest;
}

export async function validateExport(root: string): Promise<{ files: number; units: number; pages: number; manifestSha256: string }> {
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error(`Export is not a directory: ${root}`);
  const manifestPath = path.join(root, "manifest.json");
  const manifest = ManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  const actual = (await listTree(root)).filter((relative) => relative !== "manifest.json").sort();
  const expected = Object.keys(manifest.files).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Export file membership differs from its manifest");
  const manifestFiles = Object.entries(manifest.files);
  await runBounded(manifestFiles, 16, async ([relative, expectedHash]) => {
    const file = safeJoin(root, ...relative.split("/"));
    if (await sha256File(file) !== expectedHash) throw new Error(`Export hash mismatch: ${relative}`);
    if (/\.(?:html|js|css|json)$/i.test(relative)) {
      const text = await readFile(file, "utf8");
      if (/file:\/\/\/|\/Users\/|[A-Za-z]:\\\\/.test(text)) throw new Error(`Machine path leaked into export: ${relative}`);
      if (/\bfetch\s*\(|XMLHttpRequest|indexedDB|serviceWorker|\bimport\s*\(/i.test(text)) throw new Error(`Network/runtime API is forbidden in portable export: ${relative}`);
    }
  });

  const rootHtml = await readFile(path.join(root, "index.html"), "utf8");
  if (!/<main\b[^>]*\bdata-library\b/i.test(rootHtml)) throw new Error("Portable root index is missing its static library markup");
  for (const unit of manifest.units) {
    const rootHref = path.posix.join("library", unit.id, "index.html");
    if (!rootHtml.includes(`href="${escapeHtml(rootHref)}"`)) throw new Error(`Portable root index is missing a static unit link: ${unit.id}`);
    const unitIndex = safeJoin(root, "library", ...unit.id.split("/"), "index.html");
    const html = await readFile(unitIndex, "utf8");
    const pagePrefix = `${path.posix.join("library", unit.id, "pages")}/`;
    const expectedPages = expected
      .filter((relative) => relative.startsWith(pagePrefix) && !relative.slice(pagePrefix.length).includes("/"))
      .map((relative) => relative.slice(pagePrefix.length))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    const representedPages = [...html.matchAll(/<img\b[^>]*\bsrc=["']pages\/([^"']+)["']/gi)]
      .map((match) => match[1]!)
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    if (expectedPages.length !== unit.pageCount || JSON.stringify(representedPages) !== JSON.stringify(expectedPages)) {
      throw new Error(`Portable unit HTML does not represent every expected page image: ${unit.id}`);
    }
  }

  const pages = manifest.units.reduce((sum, unit) => sum + unit.pageCount, 0);
  if (pages === 0 && manifest.units.length > 0) throw new Error("Export units contain no pages");
  return { files: expected.length + 1, units: manifest.units.length, pages, manifestSha256: await sha256File(manifestPath) };
}

async function activeTarget(store: CatalogStore): Promise<string | undefined> {
  try {
    const info = await lstat(store.paths.activeExport);
    if (!info.isSymbolicLink()) throw new Error(`Active export must be an atomic generation symlink: ${store.paths.activeExport}`);
    const target = await readlink(store.paths.activeExport);
    const resolved = path.resolve(store.paths.exportRoot, target);
    if (!resolved.startsWith(`${path.resolve(store.paths.exportRoot)}${path.sep}`)) throw new Error("Active export symlink escapes export root");
    return resolved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function materializePortableExport(store: CatalogStore, destination: string): Promise<{ destination: string; files: number; units: number; pages: number; manifestSha256: string }> {
  const target = await activeTarget(store);
  if (!target) throw new Error("No active export exists");
  await validateExport(target);

  const destinationRoot = path.resolve(destination);
  if (await pathExists(destinationRoot)) throw new Error(`Portable export destination already exists: ${destinationRoot}`);
  const parent = path.dirname(destinationRoot);
  await mkdir(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(destinationRoot)}.portable-${process.pid}`);
  await rm(temporary, { recursive: true, force: true });

  try {
    await cp(target, temporary, { recursive: true, dereference: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await validateExport(temporary);
    await rename(temporary, destinationRoot);
    const validation = await validateExport(destinationRoot);
    return { destination: destinationRoot, ...validation };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function activate(store: CatalogStore, generationName: string): Promise<void> {
  const target = safeJoin(store.paths.exportRoot, generationName);
  await validateExport(target);
  const temporaryLink = path.join(store.paths.exportRoot, `.library-001.activate-${process.pid}`);
  await rm(temporaryLink, { force: true });
  await symlink(generationName, temporaryLink, "dir");
  await rename(temporaryLink, store.paths.activeExport);
  await fsyncDirectory(store.paths.exportRoot);
}

async function recoverLatest(store: CatalogStore, catalog: Catalog, hooks: ExportHooks): Promise<number | undefined> {
  const pending = Object.values(catalog.exportBuilds).filter((build) => build.status === "prepared" || build.status === "validated" || build.status === "failed").sort((a, b) => b.generation - a.generation)[0];
  if (!pending) return undefined;
  const stage = safeJoin(store.paths.exportRoot, pending.stageName);
  const generationRoot = safeJoin(store.paths.exportRoot, pending.generationName);
  if (pending.status === "failed") {
    try {
      const validation = await validateExport(stage);
      pending.status = "validated";
      pending.manifestSha256 = validation.manifestSha256;
      delete pending.error;
      await store.save(catalog);
    } catch {
      return undefined;
    }
  }
  try {
    if (await (async () => { try { await lstat(generationRoot); return true; } catch { return false; } })()) {
      await validateExport(generationRoot);
    } else {
      const validation = await validateExport(stage);
      pending.manifestSha256 = validation.manifestSha256;
      pending.status = "validated";
      await store.save(catalog);
      if (hooks.beforeActivation) await hooks.beforeActivation(stage);
      await rename(stage, generationRoot);
      await fsyncDirectory(store.paths.exportRoot);
    }
    await activate(store, pending.generationName);
    pending.status = "activated"; pending.activatedAt = nowIso(); catalog.activeExportGeneration = pending.generation;
    await store.save(catalog);
    return pending.generation;
  } catch (error) {
    if (pending.status === "prepared") { pending.status = "failed"; pending.error = (error as Error).message; await store.save(catalog); }
    throw error;
  }
}

export async function exportLibrary(store: CatalogStore, hooks: ExportHooks = {}): Promise<{ generation: number; units: number; pages: number; files: number; recovered: boolean }> {
  const catalog = await store.load();
  const recovered = await recoverLatest(store, catalog, hooks);
  if (recovered !== undefined) {
    const validation = await validateExport(store.paths.activeExport);
    return { generation: recovered, units: validation.units, pages: validation.pages, files: validation.files, recovered: true };
  }
  const curation = applyCatalogCuration(catalog, await loadSeriesCuration(store.paths.curation));
  if (curation.changed) await store.save(catalog);
  const generation = Math.max(0, ...Object.values(catalog.exportBuilds).map((build) => build.generation)) + 1;
  const key = String(generation);
  const stageName = `.library-001.staging-g${String(generation).padStart(6, "0")}`;
  const generationName = `.library-001.g${String(generation).padStart(6, "0")}`;
  catalog.exportBuilds[key] = {
    generation,
    status: "prepared",
    stageName,
    generationName,
    unitIds: Object.keys(catalog.units).sort(),
    preparedAt: nowIso()
  };
  await store.save(catalog);
  const stage = safeJoin(store.paths.exportRoot, stageName);
  try {
    await buildStage(store, catalog, stage, generation);
    const validation = await validateExport(stage);
    const build = catalog.exportBuilds[key]!;
    build.status = "validated"; build.manifestSha256 = validation.manifestSha256;
    await store.save(catalog);
    if (hooks.beforeActivation) await hooks.beforeActivation(stage);
    const generationRoot = safeJoin(store.paths.exportRoot, generationName);
    await rename(stage, generationRoot);
    await fsyncDirectory(store.paths.exportRoot);
    await activate(store, generationName);
    build.status = "activated"; build.activatedAt = nowIso(); catalog.activeExportGeneration = generation;
    await store.save(catalog);
    return { generation, units: validation.units, pages: validation.pages, files: validation.files, recovered: false };
  } catch (error) {
    const build = catalog.exportBuilds[key]!;
    if (build.status === "prepared") { build.status = "failed"; build.error = (error as Error).message; await store.save(catalog); }
    throw error;
  }
}

export async function validateActiveExport(store: CatalogStore) {
  const target = await activeTarget(store);
  if (!target) throw new Error("No active export exists");
  return validateExport(target);
}
