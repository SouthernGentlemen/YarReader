import { createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { z } from "zod";
import type { CatalogStore } from "./catalog.js";
import { nowIso } from "./domain.js";
import { copyFileVerified, fsyncDirectory, fsyncFile, isPartialName, safeJoin, sha256File, sha256Text } from "./fs.js";
import { createBundleFromFiles } from "./zip.js";

const PagesManifestSchema = z.object({
  name: z.string().min(1),
  series: z.string().min(1).optional(),
  number: z.number().nonnegative().optional(),
  pages: z.array(z.object({
    url: z.url().optional(),
    path: z.string().min(1).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
  }).strict().refine((page) => Boolean(page.url) !== Boolean(page.path), "Each page requires exactly one of url or path")).min(1)
}).strict();
export type PagesManifest = z.infer<typeof PagesManifestSchema>;

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  await mkdir(path.dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination, { flags: "wx" }));
  await fsyncFile(destination);
}

function safeFilename(value: string): string {
  const name = path.basename(value).normalize("NFC").replace(/[\u0000-\u001f]/g, "");
  if (!name || name === "." || name === ".." || isPartialName(name)) throw new Error(`Unsafe or incomplete acquisition filename: ${value}`);
  return name;
}

async function deposit(store: CatalogStore, completed: string, requestedName: string): Promise<{ relative: string; sha256: string }> {
  const info = await lstat(completed);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Acquisition output is not a regular file: ${completed}`);
  const sha256 = await sha256File(completed);
  const name = safeFilename(requestedName);
  let destination = safeJoin(store.paths.source, name);
  try {
    const existing = await lstat(destination);
    if (existing.isFile() && await sha256File(destination) === sha256) return { relative: name, sha256 };
    destination = safeJoin(store.paths.source, `${path.basename(name, path.extname(name))}-${sha256.slice(0, 12)}${path.extname(name)}`);
  } catch { /* Destination is unused. */ }
  try {
    await rename(completed, destination);
    await fsyncDirectory(store.paths.source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFileVerified(completed, destination, sha256);
  }
  if (await sha256File(destination) !== sha256) throw new Error("Deposited acquisition failed hash verification");
  return { relative: path.basename(destination), sha256 };
}

function acquisitionId(adapter: string, manifest: Record<string, unknown>): string {
  return sha256Text(`${adapter}\0${nowIso()}\0${JSON.stringify(manifest)}`);
}

async function withAcquisition(store: CatalogStore, adapter: string, manifest: Record<string, unknown>, operation: (jobRoot: string) => Promise<{ relative: string; sha256: string }>) {
  const catalog = await store.load();
  const id = acquisitionId(adapter, manifest);
  catalog.acquisitions[id] = { id, adapter, status: "prepared", requestedAt: nowIso(), manifest };
  await store.save(catalog);
  const jobRoot = safeJoin(store.paths.work, "acquire", id);
  await rm(jobRoot, { recursive: true, force: true });
  await mkdir(jobRoot, { recursive: true });
  try {
    const result = await operation(jobRoot);
    const record = catalog.acquisitions[id]!;
    record.status = "completed"; record.completedAt = nowIso(); record.sourceRelative = result.relative; record.sha256 = result.sha256;
    await store.save(catalog);
    return { id, ...result };
  } catch (error) {
    const record = catalog.acquisitions[id]!;
    record.status = "failed"; record.error = (error as Error).message;
    await store.save(catalog);
    throw error;
  }
}

export async function acquireFile(store: CatalogStore, input: string, browser = false) {
  const absolute = path.resolve(input);
  return withAcquisition(store, browser ? "browser" : "file", { input: absolute }, async (jobRoot) => {
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || isPartialName(path.basename(absolute))) throw new Error(`Input is not a completed regular file: ${absolute}`);
    const temporary = path.join(jobRoot, safeFilename(path.basename(absolute)));
    await copyFile(absolute, temporary);
    await fsyncFile(temporary);
    return deposit(store, temporary, path.basename(absolute));
  });
}

export async function acquireHttp(store: CatalogStore, url: string, name?: string) {
  const parsed = new URL(url);
  const filename = safeFilename(name ?? (path.basename(parsed.pathname) || "download.bin"));
  return withAcquisition(store, "http", { url, filename }, async (jobRoot) => {
    const temporary = path.join(jobRoot, `${filename}.part`);
    await download(url, temporary);
    const completed = path.join(jobRoot, filename);
    await rename(temporary, completed);
    await fsyncDirectory(jobRoot);
    return deposit(store, completed, filename);
  });
}

function comicInfo(manifest: PagesManifest): Buffer {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return Buffer.from(`<?xml version="1.0" encoding="utf-8"?><ComicInfo><Series>${escape(manifest.series ?? manifest.name)}</Series>${manifest.number === undefined ? "" : `<Number>${manifest.number}</Number>`}<Title>${escape(manifest.name)}</Title><PageCount>${manifest.pages.length}</PageCount></ComicInfo>\n`);
}

export async function acquirePages(store: CatalogStore, manifestInput: unknown, baseDirectory = process.cwd()) {
  const manifest = PagesManifestSchema.parse(manifestInput);
  return withAcquisition(store, "pages", manifest as unknown as Record<string, unknown>, async (jobRoot) => {
    const pages: Array<{ source: string; name: string }> = [];
    for (let index = 0; index < manifest.pages.length; index += 1) {
      const page = manifest.pages[index]!;
      const extension = path.extname(page.path ?? new URL(page.url!).pathname).toLowerCase() || ".img";
      const target = path.join(jobRoot, `${String(index + 1).padStart(6, "0")}${extension}`);
      if (page.url) await download(page.url, target);
      else { await copyFile(path.resolve(baseDirectory, page.path!), target); await fsyncFile(target); }
      if (page.sha256 && await sha256File(target) !== page.sha256) throw new Error(`Page ${index + 1} failed manifest hash verification`);
      const metadata = await sharp(target).metadata();
      if (!metadata.width || !metadata.height) throw new Error(`Page ${index + 1} is not a valid image`);
      pages.push({ source: target, name: `${String(index + 1).padStart(6, "0")}${extension}` });
    }
    const bundleName = `${safeFilename(manifest.name).replace(/\.[^.]+$/, "")}.cbz`;
    const bundle = path.join(jobRoot, bundleName);
    await createBundleFromFiles(pages, bundle, [{ name: "ComicInfo.xml", data: comicInfo(manifest) }]);
    return deposit(store, bundle, bundleName);
  });
}

export async function acquireFromManifestFile(store: CatalogStore, manifestPath: string) {
  const absolute = path.resolve(manifestPath);
  const parsed = JSON.parse(await readFile(absolute, "utf8")) as unknown;
  return acquirePages(store, parsed, path.dirname(absolute));
}
