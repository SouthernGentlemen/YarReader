import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { CatalogSchema, emptyCatalog, type Catalog } from "./domain.js";
import { atomicWriteJson, readJson } from "./fs.js";
import type { YarPaths } from "./paths.js";

export class CatalogStore {
  readonly paths: YarPaths;
  constructor(paths: YarPaths) { this.paths = paths; }

  async exists(): Promise<boolean> {
    try { await access(this.paths.catalog, constants.F_OK); return true; } catch { return false; }
  }

  async load(): Promise<Catalog> {
    if (!(await this.exists())) return emptyCatalog();
    return CatalogSchema.parse(await readJson(this.paths.catalog));
  }

  async save(catalog: Catalog): Promise<void> {
    const next = CatalogSchema.parse({ ...catalog, revision: catalog.revision + 1 });
    await atomicWriteJson(this.paths.catalog, next);
    catalog.revision = next.revision;
  }

  async initialize(): Promise<Catalog> {
    if (await this.exists()) return this.load();
    const catalog = emptyCatalog();
    await this.save(catalog);
    return catalog;
  }
}
