import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifestUrl = new URL("../extension/manifest.json", import.meta.url);
const expectedExtensionId = "jkdldllomdgfgheailkjdihphlmegfnc";

test("browser connector requests only the cookie API permission", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

  assert.deepEqual(manifest.permissions, ["cookies"]);
  assert.equal(manifest.permissions.includes("tabs"), false);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(typeof manifest.key, "string");
  assert.ok(manifest.key.length > 300);
});

test("browser connector keeps the reviewed extension identity", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
  const extensionId = [...digest]
    .map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`)
    .join("");

  assert.equal(extensionId, expectedExtensionId);
});

test("connector UI expects a 12-character short-lived pairing code", async () => {
  const [popupHtml, popupScript] = await Promise.all([
    readFile(new URL("../extension/popup.html", import.meta.url), "utf8"),
    readFile(new URL("../extension/popup.js", import.meta.url), "utf8")
  ]);

  assert.match(popupHtml, /maxlength="12"/);
  assert.match(popupScript, /pairingCode\.length !== 12/);
});

test("browser connector host access stays limited to its two platforms and loopback server", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

  assert.deepEqual(manifest.host_permissions, [
    "https://podcaster.xiaoyuzhoufm.com/*",
    "https://www.gcores.com/*",
    "http://127.0.0.1:8787/*"
  ]);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
});
