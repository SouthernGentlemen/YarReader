import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import yazl from "yazl";
import { fsyncDirectory, fsyncFile, listTree, safeJoin, sha256File } from "./fs.js";

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  directory: boolean;
}

function validateZipName(name: string): string {
  const normalized = name.normalize("NFC");
  if (normalized.includes("\\") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Unsafe ZIP entry name: ${name}`);
  }
  const pieces = normalized.split("/");
  if (pieces.some((piece) => piece === ".." || piece === "" && pieces.length > 1 && piece !== pieces.at(-1))) {
    if (!normalized.endsWith("/")) throw new Error(`Unsafe ZIP entry name: ${name}`);
  }
  return normalized;
}

function openZip(file: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error(`Unable to open ZIP: ${file}`));
      else resolve(zip);
    });
  });
}

function entryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error(`Unable to read ZIP entry ${entry.fileName}`));
      else resolve(stream);
    });
  });
}

export async function listZip(file: string): Promise<ZipEntryInfo[]> {
  const zip = await openZip(file);
  return new Promise((resolve, reject) => {
    const entries: ZipEntryInfo[] = [];
    zip.on("entry", (entry: Entry) => {
      try {
        const name = validateZipName(entry.fileName);
        entries.push({
          name,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
          directory: name.endsWith("/")
        });
        zip.readEntry();
      } catch (error) {
        zip.close();
        reject(error);
      }
    });
    zip.once("end", () => resolve(entries));
    zip.once("error", reject);
    zip.readEntry();
  });
}

export async function readZipEntry(file: string, wanted: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer | undefined> {
  const zip = await openZip(file);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value?: Buffer): void => {
      if (settled) return;
      settled = true;
      zip.close();
      resolve(value);
    };
    zip.on("entry", async (entry: Entry) => {
      try {
        const name = validateZipName(entry.fileName);
        if (name !== wanted) { zip.readEntry(); return; }
        if (entry.uncompressedSize > maxBytes) throw new Error(`ZIP metadata entry exceeds ${maxBytes} bytes: ${wanted}`);
        const stream = await entryStream(zip, entry);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of stream as NodeJS.ReadableStream & AsyncIterable<Buffer>) {
          const buffer = Buffer.from(chunk);
          size += buffer.length;
          if (size > maxBytes) throw new Error(`ZIP entry exceeds ${maxBytes} bytes: ${wanted}`);
          chunks.push(buffer);
        }
        finish(Buffer.concat(chunks));
      } catch (error) {
        settled = true;
        zip.close();
        reject(error);
      }
    });
    zip.once("end", () => finish());
    zip.once("error", (error) => { if (!settled) reject(error); });
    zip.readEntry();
  });
}

export async function sha256ZipEntry(file: string, wanted: string): Promise<string | undefined> {
  const zip = await openZip(file);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value?: string): void => {
      if (settled) return;
      settled = true;
      zip.close();
      resolve(value);
    };
    zip.on("entry", async (entry: Entry) => {
      try {
        const name = validateZipName(entry.fileName);
        if (name !== wanted) { zip.readEntry(); return; }
        const hash = (await import("node:crypto")).createHash("sha256");
        const stream = await entryStream(zip, entry);
        for await (const chunk of stream as NodeJS.ReadableStream & AsyncIterable<Buffer>) hash.update(chunk);
        finish(hash.digest("hex"));
      } catch (error) { settled = true; zip.close(); reject(error); }
    });
    zip.once("end", () => finish());
    zip.once("error", reject);
    zip.readEntry();
  });
}

export async function extractZipEntries(file: string, entries: ReadonlyMap<string, string>): Promise<void> {
  if (entries.size === 0) return;
  const remaining = new Map(entries);
  const zip = await openZip(file);
  await new Promise<void>((resolve, reject) => {
    zip.on("entry", async (entry: Entry) => {
      try {
        const name = validateZipName(entry.fileName);
        const destination = remaining.get(name);
        if (!destination) { zip.readEntry(); return; }
        await mkdir(path.dirname(destination), { recursive: true });
        const stream = await entryStream(zip, entry);
        await pipeline(stream, createWriteStream(destination, { flags: "wx" }));
        remaining.delete(name);
        zip.readEntry();
      } catch (error) {
        zip.close();
        reject(error);
      }
    });
    zip.once("end", () => {
      if (remaining.size > 0) reject(new Error(`Missing ZIP entries: ${[...remaining.keys()].join(", ")}`));
      else resolve();
    });
    zip.once("error", reject);
    zip.readEntry();
  });
}

export interface BundleResult { path: string; sha256: string; entries: string[] }

export async function createStoredBundle(sourceDirectory: string, destination: string): Promise<BundleResult> {
  const entries = await listTree(sourceDirectory);
  if (entries.length === 0) throw new Error(`Cannot bundle empty directory: ${sourceDirectory}`);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.building-${process.pid}`;
  const zip = new yazl.ZipFile();
  const epoch = new Date("1980-01-01T00:00:00.000Z");
  for (const relative of entries) {
    const absolute = safeJoin(sourceDirectory, ...relative.split("/"));
    zip.addFile(absolute, relative, { compress: false, mtime: epoch, mode: 0o100644 });
  }
  zip.end({ forceZip64Format: false, comment: "" });
  await pipeline(zip.outputStream, createWriteStream(temporary, { flags: "wx" }));
  await fsyncFile(temporary);
  const listed = await listZip(temporary);
  const actualNames = listed.filter((entry) => !entry.directory).map((entry) => entry.name);
  if (JSON.stringify(actualNames) !== JSON.stringify(entries)) throw new Error("Bundle verification failed: entry list changed");
  await rename(temporary, destination);
  await fsyncDirectory(path.dirname(destination));
  return { path: destination, sha256: await sha256File(destination), entries };
}

export async function createBundleFromFiles(files: Array<{ source: string; name: string }>, destination: string, extra?: Array<{ name: string; data: Buffer }>): Promise<BundleResult> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.building-${process.pid}`;
  const zip = new yazl.ZipFile();
  const epoch = new Date("1980-01-01T00:00:00.000Z");
  for (const item of files) {
    validateZipName(item.name);
    zip.addFile(item.source, item.name, { compress: false, mtime: epoch, mode: 0o100644 });
  }
  for (const item of extra ?? []) {
    validateZipName(item.name);
    zip.addBuffer(item.data, item.name, { compress: true, mtime: epoch, mode: 0o100644 });
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(temporary, { flags: "wx" }));
  await fsyncFile(temporary);
  const entries = (await listZip(temporary)).filter((entry) => !entry.directory).map((entry) => entry.name);
  await verifyZip(temporary);
  await rename(temporary, destination);
  await fsyncDirectory(path.dirname(destination));
  return { path: destination, sha256: await sha256File(destination), entries };
}

export async function verifyZip(file: string): Promise<void> {
  const entries = await listZip(file);
  if (entries.filter((entry) => !entry.directory).length === 0) throw new Error(`ZIP contains no files: ${file}`);
  const zip = await openZip(file);
  await new Promise<void>((resolve, reject) => {
    zip.on("entry", async (entry: Entry) => {
      try {
        validateZipName(entry.fileName);
        if (entry.fileName.endsWith("/")) { zip.readEntry(); return; }
        const stream = await entryStream(zip, entry);
        for await (const _chunk of stream as NodeJS.ReadableStream & AsyncIterable<Buffer>) { /* Drain to force decompression and CRC validation. */ }
        zip.readEntry();
      } catch (error) { zip.close(); reject(error); }
    });
    zip.once("end", () => resolve());
    zip.once("error", reject);
    zip.readEntry();
  });
  const handle = await open(file, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  await stat(file);
}
