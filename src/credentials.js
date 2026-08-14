import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVICE_PREFIX = "com.podcast-memory";

export class KeychainCredentialStore {
  constructor({ account = "default", execFileFn = execFileAsync, spawnFn = spawn } = {}) {
    this.account = account;
    this.execFileFn = execFileFn;
    this.spawnFn = spawnFn;
  }

  service(platform) {
    if (!/^[a-z0-9-]+$/.test(platform)) {
      throw new Error("Invalid credential platform");
    }
    return `${SERVICE_PREFIX}.${platform}`;
  }

  async get(platform) {
    try {
      const { stdout } = await this.execFileFn("security", [
        "find-generic-password",
        "-a",
        this.account,
        "-s",
        this.service(platform),
        "-w"
      ]);
      return JSON.parse(stdout.trim());
    } catch (error) {
      if (error.code === 44 || error.code === 128 || /could not be found/i.test(error.stderr || "")) {
        return null;
      }
      throw new Error(`Unable to read ${platform} credentials from macOS Keychain`);
    }
  }

  async set(platform, credentials) {
    const value = JSON.stringify(credentials);
    await new Promise((resolve, reject) => {
      const child = this.spawnFn("security", [
        "add-generic-password",
        "-a",
        this.account,
        "-s",
        this.service(platform),
        "-U",
        "-w"
      ], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        callback();
      };
      child.stderr?.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-8_000);
      });
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) => finish(() => {
        if (code === 0) return resolve();
        const error = new Error(`security add-generic-password failed with exit code ${code}`);
        error.code = code;
        error.stderr = stderr;
        reject(error);
      }));
      child.stdin?.on("error", (error) => finish(() => reject(error)));
      child.stdin.end(`${value}\n${value}\n`);
    });
  }

  async delete(platform) {
    try {
      await this.execFileFn("security", [
        "delete-generic-password",
        "-a",
        this.account,
        "-s",
        this.service(platform)
      ]);
    } catch (error) {
      if (error.code !== 44 && error.code !== 128) throw error;
    }
  }
}

export class MemoryCredentialStore {
  constructor() {
    this.values = new Map();
  }

  async get(platform) {
    return this.values.get(platform) || null;
  }

  async set(platform, credentials) {
    this.values.set(platform, structuredClone(credentials));
  }

  async delete(platform) {
    this.values.delete(platform);
  }
}
