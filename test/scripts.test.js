import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Tailscale setup installs the authenticated server before enabling Serve", async () => {
  const script = await readFile(new URL("../scripts/setup-tailscale-serve.sh", import.meta.url), "utf8");
  assert.match(script, /SCRIPT_DIR="\$\{0:A:h\}"/);
  const install = script.indexOf('"${SCRIPT_DIR}/install-macos-agent.sh"');
  const serve = script.indexOf('"${TAILSCALE_BIN}" serve --bg');
  assert.ok(install > 0);
  assert.ok(serve > install);
  assert.match(script, /chmod 700 "\$\{ORIGIN_FILE:h\}"/);
});

test("macOS installer leaves AI and automatic review off by default", async () => {
  const script = await readFile(new URL("../scripts/install-macos-agent.sh", import.meta.url), "utf8");
  assert.match(script, /ENABLE_AI_SUMMARY_VALUE="\$\{ENABLE_AI_SUMMARY:-0\}"/);
  assert.match(script, /AUTO_SUMMARY_ENABLED_VALUE="\$\{AUTO_SUMMARY_ENABLED:-0\}"/);
  assert.match(script, /\/api\/health/);
  assert.doesNotMatch(script, /<key>PODCAST_MEMORY_CODEX_BIN<\/key>/);
});
