import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { KeychainCredentialStore } from "../src/credentials.js";

const spawnHarness = ({ exitCode = 0, stderr = "" } = {}) => {
  const calls = [];
  let stdinValue;
  const spawnFn = (command, args, options) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (value) => {
      stdinValue = value;
      queueMicrotask(() => {
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
        child.emit("close", exitCode);
      });
    };
    calls.push({ command, args, options });
    return child;
  };
  return { calls, spawnFn, stdinValue: () => stdinValue };
};

test("Keychain writes credentials through stdin instead of process arguments", async () => {
  const harness = spawnHarness();
  const store = new KeychainCredentialStore({
    account: "test-account",
    spawnFn: harness.spawnFn
  });
  const credentials = {
    apiKey: "sensitive-value-that-must-not-enter-argv",
    refreshToken: "another-sensitive-value"
  };

  await store.set("openai", credentials);

  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.calls[0], {
    command: "security",
    args: [
      "add-generic-password",
      "-a",
      "test-account",
      "-s",
      "com.podcast-memory.openai",
      "-U",
      "-w"
    ],
    options: { stdio: ["pipe", "ignore", "pipe"] }
  });
  assert.equal(harness.calls[0].args.at(-1), "-w");
  assert.equal(harness.calls[0].args.includes("-T"), false);
  assert.equal(harness.calls[0].args.some((value) => value.includes("sensitive-value")), false);
  assert.equal(harness.stdinValue(), `${JSON.stringify(credentials)}\n${JSON.stringify(credentials)}\n`);
});

test("Keychain write failures reject without moving the secret into argv", async () => {
  const harness = spawnHarness({ exitCode: 51, stderr: "synthetic keychain failure" });
  const store = new KeychainCredentialStore({ spawnFn: harness.spawnFn });

  await assert.rejects(
    store.set("openai", { apiKey: "stdin-only-secret" }),
    /exit code 51/
  );
  assert.equal(harness.calls[0].args.includes("stdin-only-secret"), false);
  assert.equal(
    harness.stdinValue(),
    `${JSON.stringify({ apiKey: "stdin-only-secret" })}\n${JSON.stringify({ apiKey: "stdin-only-secret" })}\n`
  );
});
