import { execFileSync } from "node:child_process";

const raw = execFileSync("git", ["log", "--reverse", "--format=%H%x1f%s%x1f%b%x1e"], { encoding: "utf8" });
const records = raw.split("\x1e").map((record) => record.trim()).filter(Boolean);
if (process.env.GITHUB_EVENT_NAME === "pull_request") {
  const subject = records.at(-1)?.split("\x1f")[1] ?? "";
  if (/^Merge [0-9a-f]+ into [0-9a-f]+$/.test(subject)) records.pop();
}
const titlePattern = /^\[YR-(\d{3,})\] \[(INIT|FEAT|FIX|SEC|REFACTOR|TEST|PERF|DOCS|BUILD|CI|REVERT|CHORE)\] .+/;
const requiredSections = ["Change", "Reason", "Impact", "Risk", "Controls", "Validation", "Evidence", "Source", "Release"];
const seen = new Set();
const failures = [];

records.forEach((record, index) => {
  const [sha = "", subject = "", body = ""] = record.split("\x1f");
  const match = titlePattern.exec(subject);
  if (!match) {
    failures.push(`${sha.slice(0, 12)} has an invalid controlled title: ${subject}`);
    return;
  }
  const id = `YR-${match[1]}`;
  const expected = `YR-${String(index + 1).padStart(3, "0")}`;
  if (id !== expected) failures.push(`${sha.slice(0, 12)} uses ${id}; expected ${expected}`);
  if (seen.has(id)) failures.push(`${id} is duplicated`);
  seen.add(id);
  for (const section of requiredSections) {
    if (!new RegExp(`(?:^|\\n)${section}:`, "m").test(body)) failures.push(`${id} is missing ${section}:`);
  }
  if (!/(?:^|\n)Risk:\s*(?:\n\s*)?(?:Low|Medium|High)\b/m.test(body)) failures.push(`${id} has no Low, Medium, or High risk`);
  if (!/(?:^|\n)Release:\s*(?:\n\s*)?v\d+\.\d+\.\d+\b/m.test(body)) failures.push(`${id} has no semantic release`);
  if (!/(?:^|\n)Source:\s*(?:\n\s*)?YarReader [0-9a-f]{7,40} \(\d{4}-\d{2}-\d{2}\)/m.test(body)) failures.push(`${id} has invalid source provenance`);
});

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Validated ${records.length} sequential controlled changes.\n`);
}
