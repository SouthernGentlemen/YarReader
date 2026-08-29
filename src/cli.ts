#!/usr/bin/env node
import { Command } from "commander";
import { archive } from "./archive.js";
import { CatalogStore } from "./catalog.js";
import { classify, review } from "./classification.js";
import { exportLibrary, validateActiveExport, validateExport } from "./export.js";
import { normalize, reconcileNormalizationPageCounts } from "./normalization.js";
import { resolvePaths, initializePaths } from "./paths.js";
import { build, update } from "./pipeline.js";
import { scan } from "./scanner.js";

const program = new Command();
program.name("yar").description("YarReader ingestion pipeline and portable reader builder").version("1.0.0");
program.option("--workspace <path>", "runtime workspace (default: ~/Documents/media)");

function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

async function context(initialize = false) {
  const paths = await resolvePaths(program.opts<{ workspace?: string }>().workspace);
  if (initialize) await initializePaths(paths);
  const store = new CatalogStore(paths);
  if (initialize) await store.initialize();
  return { paths, store };
}

program.command("paths").description("print the single resolved path authority").action(async () => output((await context()).paths));
program.command("init").description("initialize runtime directories and an empty catalog").action(async () => {
  const { paths, store } = await context(true); output({ paths, catalog: await store.load() });
});
program.command("scan").option("--stable-seconds <n>", "unchanged observation window", "10").option("--refresh", "reinspect unchanged inbox sources and rebuild classification inputs").action(async (options) => {
  const { store } = await context(true); output(await scan(store, Number(options.stableSeconds), Boolean(options.refresh)));
});
program.command("classify").option("--threshold <n>", "automatic acceptance threshold", "0.82").action(async (options) => {
  const { store } = await context(true); output(await classify(store, { threshold: Number(options.threshold) }));
});
program.command("review")
  .option("--accept-all", "accept pending sequenced proposals")
  .option("--accept <selector>", "accept source-sha256:unit-key")
  .option("--reject <selector>", "reject source-sha256:unit-key")
  .option("--correct <json>", "JSON with selector and complete proposal")
  .option("--retype <json>", "JSON with seriesSlug, optional fromUnitType, and unitType")
  .option("--select-release <json>", "JSON with unitId, sourceId, and unitKey")
  .action(async (options) => {
    const { store } = await context(true);
    const correction = options.correct ? JSON.parse(options.correct) as { selector: string; proposal: unknown } : undefined;
    const retype = options.retype ? JSON.parse(options.retype) as { seriesSlug: string; fromUnitType?: "issue" | "chapter" | "volume" | "annual" | "special" | "book" | "unknown"; unitType: "issue" | "chapter" | "volume" | "annual" | "special" | "book" | "unknown" } : undefined;
    const selectRelease = options.selectRelease ? JSON.parse(options.selectRelease) as { unitId: string; sourceId: string; unitKey: string } : undefined;
    output(await review(store, {
      ...(options.acceptAll ? { acceptAll: true } : {}),
      ...(options.accept ? { accept: String(options.accept) } : {}),
      ...(options.reject ? { reject: String(options.reject) } : {}),
      ...(correction ? { correction } : {}),
      ...(retype ? { retype } : {}),
      ...(selectRelease ? { selectRelease } : {})
    }));
  });
program.command("normalize")
  .option("--reconcile-only", "copy verified normalization counts into inspection metadata without rebuilding")
  .option("--failed-only", "retry only releases whose last normalization attempt failed")
  .option("--unverified-only", "process releases without a verified normalization record")
  .action(async (options) => {
  const { store } = await context(true); output(options.reconcileOnly ? await reconcileNormalizationPageCounts(store) : await normalize(store, { failedOnly: Boolean(options.failedOnly), unverifiedOnly: Boolean(options.unverifiedOnly) }));
});
program.command("archive").action(async () => { const { store } = await context(true); output(await archive(store)); });
program.command("export").action(async () => { const { store } = await context(true); output(await exportLibrary(store)); });
program.command("validate").argument("[path]").action(async (target?: string) => {
  const { store } = await context(true); output(target ? await validateExport(target) : await validateActiveExport(store));
});
program.command("build").action(async () => { const { store } = await context(true); output(await build(store)); });
program.command("update").option("--stable-seconds <n>", "unchanged observation window", "10").action(async (options) => {
  const { store } = await context(true); output(await update(store, Number(options.stableSeconds)));
});
program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`yar: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
