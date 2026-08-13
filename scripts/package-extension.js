import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(root, "extension");
const outputDir = join(root, "dist");
const output = join(outputDir, "echo-podcast-connector.zip");
mkdirSync(outputDir, { recursive: true });

const result = spawnSync("zip", ["-q", "-r", "-FS", output, ".", "-x", "*.DS_Store"], {
  cwd: extensionDir,
  stdio: "inherit"
});
if (result.status !== 0) process.exit(result.status || 1);
console.log(`Packaged browser connector: ${output}`);
