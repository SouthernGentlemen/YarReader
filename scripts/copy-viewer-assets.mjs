/* Copy the viewer stylesheets next to the compiled viewer scripts. */
import { cp, mkdir, readdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "src", "viewer");
const to = path.join(root, "dist", "viewer");

await mkdir(to, { recursive: true });
for (const name of await readdir(from)) {
  if (name.endsWith(".css")) await cp(path.join(from, name), path.join(to, name));
}
