import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_EXTENSION_ORIGIN,
  createPairingManager,
  createRequestAccessPolicy
} from "../src/http-security.js";

const request = (headers, encrypted = false) => ({ headers, socket: { encrypted } });

test("request policy rejects DNS rebinding hosts and untrusted forwarded headers", () => {
  const policy = createRequestAccessPolicy({ port: 8787 });
  assert.equal(policy.classify(request({ host: "127.0.0.1:8787" })).kind, "local");
  assert.equal(policy.classify(request({ host: "localhost:8787" })).kind, "local");
  assert.equal(policy.classify(request({ host: "attacker.example" })).allowed, false);
  assert.equal(policy.classify(request({
    host: "127.0.0.1:8787",
    "x-forwarded-host": "private.example.ts.net",
    "x-forwarded-proto": "https",
    "tailscale-user-login": "owner@example.com"
  })).allowed, false);
});

test("request policy accepts only the configured Tailscale origin and login", () => {
  const policy = createRequestAccessPolicy({
    port: 8787,
    publicOrigin: "https://mac.example.ts.net",
    trustProxy: true,
    tailscaleLogin: "owner@example.com"
  });
  const allowed = policy.classify(request({
    host: "127.0.0.1:8787",
    "x-forwarded-host": "mac.example.ts.net",
    "x-forwarded-proto": "https",
    "tailscale-user-login": "owner@example.com"
  }));
  assert.equal(allowed.kind, "tailscale");
  assert.equal(policy.trustedPageOrigin("https://mac.example.ts.net", allowed), true);
  assert.equal(policy.classify(request({
    host: "127.0.0.1:8787",
    "x-forwarded-host": "other.example.ts.net",
    "x-forwarded-proto": "https",
    "tailscale-user-login": "owner@example.com"
  })).allowed, false);
  assert.equal(policy.classify(request({
    host: "127.0.0.1:8787",
    "x-forwarded-host": "mac.example.ts.net",
    "x-forwarded-proto": "https",
    "tailscale-user-login": "friend@example.com"
  })).allowed, false);
});

test("request policy accepts exactly one reviewed extension origin", () => {
  const policy = createRequestAccessPolicy({ port: 8787 });
  assert.equal(policy.isExtensionOrigin(DEFAULT_EXTENSION_ORIGIN), true);
  assert.equal(policy.isExtensionOrigin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), false);
  assert.equal(policy.isExtensionOrigin(`${DEFAULT_EXTENSION_ORIGIN}.attacker.example`), false);
});

test("pairing codes are private, short lived, one time, and rate limited", () => {
  const directory = mkdtempSync(join(tmpdir(), "echo-pairing-test-"));
  let time = Date.parse("2026-08-13T12:00:00Z");
  let seed = 0;
  const manager = createPairingManager({
    dataDir: directory,
    ttlMs: 600_000,
    maxFailures: 2,
    now: () => time,
    randomBytesFn: () => Buffer.alloc(6, ++seed)
  });
  try {
    const first = manager.snapshot();
    assert.equal(first.pairingCode.length, 12);
    assert.equal(readFileSync(join(directory, "pairing-code"), "utf8"), first.pairingCode);
    assert.equal(statSync(join(directory, "pairing-code")).mode & 0o777, 0o600);
    assert.equal(manager.consume(first.pairingCode).ok, true);
    manager.rotate();
    assert.notEqual(manager.snapshot().pairingCode, first.pairingCode);
    assert.equal(manager.consume(first.pairingCode).ok, false);
    assert.equal(manager.consume("BAD-CODE").reason, "rate-limited");
    time += 600_001;
    const afterExpiry = manager.snapshot();
    assert.notEqual(afterExpiry.pairingCode, first.pairingCode);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
