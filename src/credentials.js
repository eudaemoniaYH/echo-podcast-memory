import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVICE_PREFIX = "com.podcast-memory";

export class KeychainCredentialStore {
  constructor({ account = "default" } = {}) {
    this.account = account;
  }

  service(platform) {
    if (!/^[a-z0-9-]+$/.test(platform)) {
      throw new Error("Invalid credential platform");
    }
    return `${SERVICE_PREFIX}.${platform}`;
  }

  async get(platform) {
    try {
      const { stdout } = await execFileAsync("security", [
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
    await execFileAsync("security", [
      "add-generic-password",
      "-a",
      this.account,
      "-s",
      this.service(platform),
      "-w",
      value,
      "-U"
    ]);
  }

  async delete(platform) {
    try {
      await execFileAsync("security", [
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
