import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import sharp from "sharp";
import { CatalogStore } from "../src/catalog.js";
import { initializePaths, resolvePaths, type YarPaths } from "../src/paths.js";
import { createBundleFromFiles } from "../src/zip.js";

export async function temporaryStore(t: TestContext): Promise<{ root: string; paths: YarPaths; store: CatalogStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "yarreader-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const paths = await resolvePaths(path.join(root, "media"));
  await initializePaths(paths);
  const store = new CatalogStore(paths);
  await store.initialize();
  return { root, paths, store };
}

export async function png(file: string, color: string, width = 8, height = 12): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: color } }).png().toFile(file);
  return file;
}

export function comicInfo(series: string, number: number, title = "Fixture"): Buffer {
  return Buffer.from(`<?xml version="1.0"?><ComicInfo><Series>${series}</Series><Number>${number}</Number><Title>${title}</Title><Year>2026</Year><Writer>A. Writer</Writer><Penciller>B. Artist</Penciller></ComicInfo>`);
}

export async function cbz(file: string, pages: string[], series = "Fixture Series", number = 1): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await createBundleFromFiles(
    pages.map((source, index) => ({ source, name: `${String(index + 1).padStart(3, "0")}.png` })),
    file,
    [{ name: "ComicInfo.xml", data: comicInfo(series, number) }]
  );
  return file;
}

export async function fixtureCbz(root: string, destination: string, series = "Fixture Series", number = 1): Promise<string> {
  const fixture = path.join(root, "fixtures", `${series}-${number}`);
  const pages = [await png(path.join(fixture, "1.png"), "#f00"), await png(path.join(fixture, "2.png"), "#0f0")];
  return cbz(destination, pages, series, number);
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
