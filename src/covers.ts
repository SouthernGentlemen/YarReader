import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { CatalogStore } from "./catalog.js";
import { atomicWriteFile, atomicWriteJson } from "./fs.js";
import { loadSeriesCuration, type SeriesCuration } from "./series-metadata.js";

export interface CoverSource {
  series: string;
  seriesSlug: string;
  pageUrl: string;
}

export function coverSourcesFromCuration(curation: SeriesCuration): CoverSource[] {
  return curation.series
    .filter((entry): entry is typeof entry & { coverPageUrl: string } => Boolean(entry.coverPageUrl))
    .map((entry) => ({ series: entry.series, seriesSlug: entry.seriesSlug, pageUrl: entry.coverPageUrl }));
}

interface CoverIndexEntry {
  series: string;
  pageUrl: string;
  imageUrl: string;
  imageSha256: string;
  updatedAt: string;
}

interface CoverIndex {
  schemaVersion: 1;
  covers: Record<string, CoverIndexEntry>;
}

function decodeHtmlAttribute(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}

export function findOpenGraphImage(html: string): string | undefined {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!/\b(?:property|name)\s*=\s*["']og:image["']/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2];
    if (content) return decodeHtmlAttribute(content);
  }
  return undefined;
}

async function renderPortraitCover(input: Buffer): Promise<Buffer> {
  const metadata = await sharp(input).rotate().metadata();
  if (!metadata.width || !metadata.height) throw new Error("Cover image has no dimensions");
  if (metadata.height / metadata.width >= 1.25) {
    return sharp(input).rotate().resize(480, 720, { fit: "cover", position: "attention" }).webp({ quality: 82, effort: 4 }).toBuffer();
  }
  const background = await sharp(input).rotate().resize(480, 720, { fit: "cover", position: "attention" }).blur(20).modulate({ brightness: 0.5, saturation: 0.8 }).toBuffer();
  const foreground = await sharp(input).rotate().resize(440, 660, { fit: "inside" }).toBuffer();
  const foregroundMetadata = await sharp(foreground).metadata();
  const width = foregroundMetadata.width ?? 440;
  const height = foregroundMetadata.height ?? 440;
  return sharp(background)
    .composite([{ input: foreground, left: Math.floor((480 - width) / 2), top: Math.floor((720 - height) / 2) }])
    .webp({ quality: 82, effort: 4 })
    .toBuffer();
}

async function readCoverIndex(file: string): Promise<CoverIndex> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as CoverIndex;
    if (parsed.schemaVersion === 1 && parsed.covers && typeof parsed.covers === "object") return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { schemaVersion: 1, covers: {} };
}

export async function fetchSeriesCovers(
  store: CatalogStore,
  options: { sources?: readonly CoverSource[]; fetchImpl?: typeof fetch } = {},
): Promise<{ discovered: number; updated: number; unchanged: number; failed: Array<{ seriesSlug: string; error: string }> }> {
  const catalog = await store.load();
  const currentSlugs = new Set(Object.values(catalog.units).map((unit) => unit.seriesSlug));
  const configured = options.sources ?? coverSourcesFromCuration(await loadSeriesCuration(store.paths.curation));
  const sources = configured.filter((source) => currentSlugs.has(source.seriesSlug));
  const fetchImpl = options.fetchImpl ?? fetch;
  const indexFile = path.join(store.paths.covers, "index.json");
  const index = await readCoverIndex(indexFile);
  let updated = 0;
  let unchanged = 0;
  const failed: Array<{ seriesSlug: string; error: string }> = [];
  let next = 0;

  await Promise.all(Array.from({ length: Math.min(3, sources.length) }, async () => {
    while (next < sources.length) {
      const source = sources[next++]!;
      try {
        const pageResponse = await fetchImpl(source.pageUrl, { headers: { "user-agent": "Mozilla/5.0 (compatible; YarReader/1.0; cover metadata)" } });
        if (!pageResponse.ok) throw new Error(`Cover page returned HTTP ${pageResponse.status}`);
        const imageUrl = findOpenGraphImage(await pageResponse.text());
        if (!imageUrl || !/^https:\/\//i.test(imageUrl)) throw new Error("Cover page has no HTTPS og:image");
        const imageResponse = await fetchImpl(imageUrl, { headers: { "user-agent": "Mozilla/5.0 (compatible; YarReader/1.0; cover image)", referer: source.pageUrl } });
        if (!imageResponse.ok) throw new Error(`Cover image returned HTTP ${imageResponse.status}`);
        const contentType = imageResponse.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().startsWith("image/")) throw new Error(`Cover response is not an image: ${contentType || "unknown"}`);
        const input = Buffer.from(await imageResponse.arrayBuffer());
        if (input.length === 0 || input.length > 15 * 1024 * 1024) throw new Error(`Cover image size is invalid: ${input.length}`);
        const imageSha256 = createHash("sha256").update(input).digest("hex");
        const output = path.join(store.paths.covers, `${source.seriesSlug}.webp`);
        const prior = index.covers[source.seriesSlug];
        if (prior?.imageSha256 === imageSha256) {
          try {
            await readFile(output);
            unchanged += 1;
            continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        await atomicWriteFile(output, await renderPortraitCover(input));
        index.covers[source.seriesSlug] = { series: source.series, pageUrl: source.pageUrl, imageUrl, imageSha256, updatedAt: new Date().toISOString() };
        updated += 1;
      } catch (error) {
        failed.push({ seriesSlug: source.seriesSlug, error: (error as Error).message });
      }
    }
  }));

  await atomicWriteJson(indexFile, index);
  return { discovered: sources.length, updated, unchanged, failed };
}
