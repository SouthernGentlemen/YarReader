import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoSymlinkComponents, isWithin, nearestRealPath, safeJoin } from "./fs.js";

export interface YarPaths {
  project: string;
  workspace: string;
  source: string;
  archive: string;
  state: string;
  work: string;
  exportRoot: string;
  activeExport: string;
  catalog: string;
  curation: string;
}

export function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export async function resolvePaths(workspaceInput?: string): Promise<YarPaths> {
  const project = projectRoot();
  const workspace = path.resolve(workspaceInput ?? process.env.YAR_WORKSPACE ?? path.join(process.env.HOME ?? "", "Documents/media"));
  const paths: YarPaths = {
    project,
    workspace,
    source: safeJoin(workspace, "source"),
    archive: safeJoin(workspace, "archive"),
    state: safeJoin(workspace, "state"),
    work: safeJoin(workspace, "work"),
    exportRoot: safeJoin(workspace, "export"),
    activeExport: safeJoin(workspace, "export", "library-001"),
    catalog: safeJoin(workspace, "state", "catalog.json"),
    curation: safeJoin(workspace, "state", "series-curation.json")
  };
  const realProject = await nearestRealPath(project);
  const realWorkspace = await nearestRealPath(workspace);
  if (isWithin(realProject, realWorkspace) || isWithin(realWorkspace, realProject)) {
    throw new Error(`Runtime workspace and project must not overlap: ${workspace}`);
  }
  const roots = [paths.source, paths.archive, paths.state, paths.work, paths.exportRoot];
  for (let i = 0; i < roots.length; i += 1) {
    for (let j = i + 1; j < roots.length; j += 1) {
      if (isWithin(roots[i]!, roots[j]!) || isWithin(roots[j]!, roots[i]!)) throw new Error("Runtime roots overlap");
    }
  }
  return paths;
}

export async function initializePaths(paths: YarPaths): Promise<void> {
  await mkdir(paths.workspace, { recursive: true });
  const workspaceInfo = await lstat(paths.workspace);
  if (workspaceInfo.isSymbolicLink()) throw new Error(`Workspace may not be a symbolic link: ${paths.workspace}`);
  for (const root of [paths.source, paths.archive, paths.state, paths.work, paths.exportRoot]) {
    await assertNoSymlinkComponents(paths.workspace, root);
    await mkdir(root, { recursive: true });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe runtime root: ${root}`);
  }
}
