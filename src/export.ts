import { copyFile, lstat, mkdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CatalogStore } from "./catalog.js";
import { nowIso, type Catalog, type ExportBuildSchema, type UnitRecord } from "./domain.js";
import { fsyncDirectory, fsyncFile, listTree, safeJoin, sha256File, sha256Text } from "./fs.js";
import { verifyNormalization } from "./normalization.js";

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
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const APP_JS = `(() => {
  const q = (s) => document.querySelector(s);
  const catalog = window.YAR_CATALOG;
  if (q('[data-library]')) {
    const root = q('[data-library]');
    const groups = new Map();
    for (const unit of catalog.units) {
      const list = groups.get(unit.series) || [];
      list.push(unit); groups.set(unit.series, list);
    }
    for (const [series, units] of [...groups].sort((a,b)=>a[0].localeCompare(b[0]))) {
      const section = document.createElement('section');
      const h = document.createElement('h2'); h.textContent = series; section.append(h);
      const list = document.createElement('ol');
      for (const unit of units) { const li=document.createElement('li'); const a=document.createElement('a'); a.href='library/'+unit.id+'/index.html'; a.textContent=unit.title || unit.label; li.append(a); list.append(li); }
      section.append(list); root.append(section);
    }
  }
  if (window.YAR_UNIT) {
    const root=q('[data-pages]');
    for (const page of window.YAR_UNIT.pages) { const img=document.createElement('img'); img.loading='lazy'; img.decoding='async'; img.src='pages/'+page; img.alt=''; root.append(img); }
  }
})();\n`;

const APP_CSS = `:root{color-scheme:dark;background:#111;color:#eee;font:16px system-ui,sans-serif}body{margin:0 auto;max-width:80rem;padding:1rem}a{color:#9bd}section{border-top:1px solid #333;margin-top:1rem}.reader{max-width:none;padding:0}.reader header{position:sticky;top:0;background:#111e;padding:.6rem;z-index:2}.pages{display:flex;flex-direction:column;align-items:center}.pages img{display:block;max-width:100%;height:auto}ol{line-height:1.7}\n`;

function catalogPayload(units: UnitRecord[]): string {
  const records = units.map((unit) => {
    const release = selectedRelease(unit)!;
    const normalization = release.normalization!;
    const labelNumber = unit.chapter ?? unit.issue ?? unit.sequence ?? unit.volume;
    return {
      id: unit.id,
      series: unit.series,
      label: `${unit.unitType}${labelNumber === undefined ? "" : ` ${labelNumber}`}`,
      ...(unit.title ? { title: unit.title } : {}),
      pageCount: normalization.pageCount
    };
  });
  return JSON.stringify({ schemaVersion: 1, units: records }).replaceAll("<", "\\u003c");
}

async function writeAndSync(file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await fsyncFile(file);
}

async function buildStage(store: CatalogStore, catalog: Catalog, stage: string, generation: number): Promise<Manifest> {
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  const units = Object.values(catalog.units).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  await runBounded(units, 8, async (unit) => {
    const release = selectedRelease(unit);
    if (!release?.normalization || !(await verifyNormalization(store, release.normalization))) throw new Error(`Selected release is not normalized: ${unit.id}`);
  });
  await writeAndSync(path.join(stage, "assets", "app.js"), APP_JS);
  await writeAndSync(path.join(stage, "assets", "app.css"), APP_CSS);
  await writeAndSync(path.join(stage, "catalog.js"), `window.YAR_CATALOG=${catalogPayload(units)};\n`);
  await writeAndSync(path.join(stage, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>YarReader</title><link rel="stylesheet" href="assets/app.css"></head><body><h1>YarReader</h1><main data-library></main><script src="catalog.js"></script><script src="assets/app.js"></script></body></html>\n`);
  const manifestUnits: Manifest["units"] = [];
  for (const unit of units) {
    const normalization = selectedRelease(unit)!.normalization!;
    const unitRoot = safeJoin(stage, "library", ...unit.id.split("/"));
    const pagesRoot = path.join(unitRoot, "pages");
    await mkdir(pagesRoot, { recursive: true });
    const pageNames = new Array<string>(normalization.pages.length);
    await runBounded(normalization.pages, 8, async (page, index) => {
      const sourceRoot = safeJoin(store.paths.work, ...normalization.workRelative.split("/"));
      const outputName = path.basename(page.file);
      await copyFile(safeJoin(sourceRoot, page.file), path.join(pagesRoot, outputName));
      await fsyncFile(path.join(pagesRoot, outputName));
      pageNames[index] = outputName;
    });
    const unitJson = JSON.stringify({ id: unit.id, pages: pageNames }).replaceAll("<", "\\u003c");
    await writeAndSync(path.join(unitRoot, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(unit.title ?? unit.id)}</title><link rel="stylesheet" href="../../../assets/app.css"></head><body class="reader"><header><a href="../../../index.html">Library</a> · ${escapeHtml(unit.series)}</header><main class="pages" data-pages></main><script>window.YAR_UNIT=${unitJson};</script><script src="../../../assets/app.js"></script></body></html>\n`);
    await fsyncDirectory(pagesRoot);
    await fsyncDirectory(unitRoot);
    manifestUnits.push({ id: unit.id, pageCount: pageNames.length });
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
      if (/\bfetch\s*\(|XMLHttpRequest|indexedDB/i.test(text)) throw new Error(`Network/runtime API is forbidden in portable export: ${relative}`);
    }
  });
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
