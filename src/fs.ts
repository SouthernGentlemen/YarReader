import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export const PARTIAL_SUFFIXES = [".part", ".crdownload", ".download", ".!qb", ".tmp", ".partial"];

export function isPartialName(name: string): boolean {
  const lower = name.toLowerCase();
  return PARTIAL_SUFFIXES.some((suffix) => lower.endsWith(suffix)) || lower.startsWith(".~") || lower === ".ds_store";
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash as unknown as NodeJS.WritableStream);
  return hash.digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function listTree(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }));
    for (const entry of entries) {
      if (isPartialName(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Symbolic links are not accepted as media inputs: ${absolute}`);
      if (info.isDirectory()) await walk(absolute);
      else if (info.isFile()) output.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return output;
}

export async function treeContainsPartial(root: string): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (isPartialName(entry.name)) return true;
    if (entry.isDirectory() && await treeContainsPartial(path.join(root, entry.name))) return true;
  }
  return false;
}

export async function hashDirectory(root: string): Promise<{ sha256: string; size: number; files: string[] }> {
  const files = await listTree(root);
  const hash = createHash("sha256");
  let size = 0;
  for (const relative of files) {
    const absolute = path.join(root, ...relative.split("/"));
    const info = await stat(absolute);
    size += info.size;
    hash.update("file\0");
    hash.update(relative.normalize("NFC"));
    hash.update("\0");
    hash.update(String(info.size));
    hash.update("\0");
    for await (const chunk of createReadStream(absolute)) hash.update(chunk);
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), size, files };
}

export async function fsyncFile(file: string): Promise<void> {
  const handle = await open(file, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function atomicWriteFile(file: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  await writeFile(temporary, data);
  await fsyncFile(temporary);
  await rename(temporary, file);
  await fsyncDirectory(path.dirname(file));
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

export async function copyFileVerified(source: string, destination: string, expectedHash?: string): Promise<string> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.incoming-${process.pid}`;
  await pipeline(createReadStream(source), createWriteStream(temporary, { flags: "wx" }));
  await fsyncFile(temporary);
  const actual = await sha256File(temporary);
  if (expectedHash && actual !== expectedHash) {
    await unlink(temporary).catch(() => undefined);
    throw new Error(`Hash mismatch while copying ${source}`);
  }
  await rename(temporary, destination);
  await fsyncDirectory(path.dirname(destination));
  return actual;
}

export async function nearestRealPath(target: string): Promise<string> {
  let cursor = path.resolve(target);
  const suffix: string[] = [];
  while (true) {
    try {
      const resolved = await realpath(cursor);
      return path.join(resolved, ...suffix.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function assertNoSymlinkComponents(root: string, target: string): Promise<void> {
  if (!isWithin(path.resolve(root), path.resolve(target))) throw new Error(`Path escapes root: ${target}`);
  const relative = path.relative(path.resolve(root), path.resolve(target));
  let cursor = path.resolve(root);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error(`Symbolic link traversal is forbidden: ${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export function safeJoin(root: string, ...segments: string[]): string {
  const candidate = path.resolve(root, ...segments);
  if (!isWithin(path.resolve(root), candidate)) throw new Error(`Unsafe path outside ${root}: ${segments.join("/")}`);
  return candidate;
}
