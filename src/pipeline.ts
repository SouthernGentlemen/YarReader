import type { CatalogStore } from "./catalog.js";
import { archive } from "./archive.js";
import { classify } from "./classification.js";
import { exportLibrary, validateActiveExport } from "./export.js";
import { normalize } from "./normalization.js";
import { scan } from "./scanner.js";

export async function build(store: CatalogStore) {
  const normalization = await normalize(store);
  if (normalization.failed.length) throw new Error(`Normalization failed for ${normalization.failed.length} release(s)`);
  const exported = await exportLibrary(store);
  const validation = await validateActiveExport(store);
  return { normalization, exported, validation };
}

export async function update(store: CatalogStore, stableSeconds = 10) {
  const scanned = await scan(store, stableSeconds);
  const classified = await classify(store);
  const normalized = await normalize(store);
  const archived = await archive(store);
  if (normalized.failed.length || archived.failed.length) {
    return { scanned, classified, normalized, archived, exported: undefined, validation: undefined };
  }
  const exported = await exportLibrary(store);
  const validation = await validateActiveExport(store);
  return { scanned, classified, normalized, archived, exported, validation };
}
