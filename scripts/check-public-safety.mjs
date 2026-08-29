import { execFileSync } from "node:child_process";

const revisions = execFileSync("git", ["rev-list", "--all"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const forbiddenPath = /(^|\/)(node_modules|dist|coverage|source|archive|state|work|export)(\/|$)|(^|\/)(\.env(?:\..*)?|\.dev\.vars|id_rsa|[^/]+\.(?:pem|key|p12|pfx))$/i;
const forbiddenMedia = /\.(?:cbz|cbr|epub|pdf|png|jpe?g|gif|webp|avif|tiff?|bmp)$/i;
const privatePath = /\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/;
const privateKey = /BEGIN (?:RSA |OPENSSH |EC |PGP )?PRIVATE KEY/;
const assignedSecret = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|client[_-]?secret)\b\s*[:=]\s*["'][^"'\n]{8,}["']/i;
const credentialUrl = /https?:\/\/[^\s/:]+:[^\s/@]+@|[?&](?:token|api[_-]?key|password|secret)=[^\s&#]+/i;
const blobs = new Map();
const failures = [];

for (const revision of revisions) {
  const tree = execFileSync("git", ["ls-tree", "-r", "-l", revision], { encoding: "utf8" });
  for (const line of tree.split("\n").filter(Boolean)) {
    const match = /^\d+ blob ([0-9a-f]+)\s+(\d+)\t(.+)$/.exec(line);
    if (!match) continue;
    const [, object = "", sizeText = "0", file = ""] = match;
    const size = Number(sizeText);
    if (forbiddenPath.test(file)) failures.push(`${revision.slice(0, 12)} tracks forbidden runtime or credential path ${file}`);
    if (forbiddenMedia.test(file)) failures.push(`${revision.slice(0, 12)} tracks media asset ${file}`);
    if (size > 2 * 1024 * 1024) failures.push(`${revision.slice(0, 12)} tracks oversized blob ${file} (${size} bytes)`);
    if (!blobs.has(object)) blobs.set(object, file);
  }
}

for (const [object, file] of blobs) {
  const content = execFileSync("git", ["cat-file", "blob", object]);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  if (privatePath.test(text)) failures.push(`${object.slice(0, 12)} (${file}) contains an absolute personal path`);
  if (privateKey.test(text)) failures.push(`${object.slice(0, 12)} (${file}) contains private-key material`);
  if (assignedSecret.test(text)) failures.push(`${object.slice(0, 12)} (${file}) contains an assigned secret-like value`);
  if (credentialUrl.test(text)) failures.push(`${object.slice(0, 12)} (${file}) contains a credential-bearing URL`);
}

if (failures.length > 0) {
  process.stderr.write(`${[...new Set(failures)].join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Scanned ${revisions.length} revisions and ${blobs.size} unique blobs; no forbidden public-history material found.\n`);
}
