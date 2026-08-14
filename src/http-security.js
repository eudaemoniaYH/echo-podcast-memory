import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_EXTENSION_ORIGIN = "chrome-extension://jkdldllomdgfgheailkjdihphlmegfnc";

const singleHeader = (value) => {
  const text = Array.isArray(value) ? value.join(",") : String(value || "").trim();
  return text && !text.includes(",") && !/[\s/\\]/.test(text) ? text : null;
};

const normalizeOrigin = (value) => {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    const extensionOrigin = url.protocol === "chrome-extension:";
    const rootPath = url.pathname === "/" || (extensionOrigin && url.pathname === "");
    if ((!url.hostname && !extensionOrigin) || url.username || url.password || !rootPath || url.search || url.hash) return null;
    if (extensionOrigin && !/^[a-p]{32}$/.test(url.hostname)) return null;
    return extensionOrigin ? `chrome-extension://${url.hostname}` : url.origin;
  } catch {
    return null;
  }
};

const normalizedHost = (value) => {
  const host = singleHeader(value);
  if (!host) return null;
  try {
    return new URL(`http://${host}`).host;
  } catch {
    return null;
  }
};

const originHost = (hostname, port) => new URL(`http://${hostname}:${port}`).host;

export const createRequestAccessPolicy = ({
  port,
  publicOrigin = "",
  trustProxy = false,
  tailscaleLogin = "",
  extensionOrigin = DEFAULT_EXTENSION_ORIGIN
}) => {
  const localHosts = new Set([
    originHost("127.0.0.1", port),
    originHost("localhost", port),
    originHost("[::1]", port)
  ]);
  const configuredPublicOrigin = normalizeOrigin(publicOrigin);
  const configuredPublicHost = configuredPublicOrigin ? new URL(configuredPublicOrigin).host : null;
  const configuredExtensionOrigin = normalizeOrigin(extensionOrigin);
  if (!configuredExtensionOrigin?.startsWith("chrome-extension://")) {
    throw new Error("PODCAST_MEMORY_EXTENSION_ORIGIN must be one exact chrome-extension origin");
  }
  if (publicOrigin && (!configuredPublicOrigin || !configuredPublicOrigin.startsWith("https://"))) {
    throw new Error("PODCAST_MEMORY_PUBLIC_ORIGIN must be one exact HTTPS origin");
  }

  const classify = (request) => {
    const rawHost = normalizedHost(request.headers.host);
    if (!rawHost) return { allowed: false, reason: "invalid-host" };

    const forwardedHost = trustProxy ? normalizedHost(request.headers["x-forwarded-host"]) : null;
    const forwardedProtocol = trustProxy ? singleHeader(request.headers["x-forwarded-proto"]) : null;
    const effectiveHost = forwardedHost || rawHost;
    const effectiveProtocol = forwardedProtocol || (request.socket?.encrypted ? "https" : "http");
    if (!new Set(["http", "https"]).has(effectiveProtocol)) {
      return { allowed: false, reason: "invalid-protocol" };
    }
    const effectiveOrigin = `${effectiveProtocol}://${effectiveHost}`;
    const tailscaleHeader = String(request.headers["tailscale-user-login"] || "").trim();

    if (localHosts.has(effectiveHost) && effectiveProtocol === "http") {
      if (tailscaleHeader || (trustProxy && (request.headers["x-forwarded-host"] || request.headers["x-forwarded-proto"]))) {
        return { allowed: false, reason: "unexpected-proxy-headers" };
      }
      return { allowed: true, kind: "local", origin: effectiveOrigin, host: effectiveHost };
    }

    if (configuredPublicOrigin && trustProxy && effectiveHost === configuredPublicHost &&
        effectiveOrigin === configuredPublicOrigin) {
      const login = tailscaleHeader;
      if (!tailscaleLogin || login !== tailscaleLogin) {
        return { allowed: false, reason: "untrusted-tailnet-user" };
      }
      return { allowed: true, kind: "tailscale", origin: effectiveOrigin, host: effectiveHost, login };
    }

    return { allowed: false, reason: "untrusted-host" };
  };

  const trustedPageOrigin = (origin, access) => {
    if (!access?.allowed || typeof origin !== "string") return false;
    return normalizeOrigin(origin) === access.origin;
  };

  return {
    classify,
    extensionOrigin: configuredExtensionOrigin,
    isExtensionOrigin: (origin) => normalizeOrigin(origin) === configuredExtensionOrigin,
    isLocal: (access) => access?.allowed && access.kind === "local",
    trustedPageOrigin
  };
};

export const createPairingManager = ({
  dataDir,
  ttlMs = 10 * 60 * 1000,
  maxFailures = 5,
  now = () => Date.now(),
  randomBytesFn = randomBytes
}) => {
  const pairingPath = join(dataDir, "pairing-code");
  let current = null;
  let failures = [];

  const rotate = () => {
    const code = randomBytesFn(6).toString("hex").toUpperCase();
    current = { code, expiresAt: now() + ttlMs };
    writeFileSync(pairingPath, code, { mode: 0o600 });
    chmodSync(pairingPath, 0o600);
    return current;
  };

  const invalidate = () => {
    current = null;
  };

  const active = () => {
    if (!current || now() >= current.expiresAt) rotate();
    return current;
  };

  const snapshot = () => {
    const value = active();
    return { pairingCode: value.code, pairingExpiresAt: new Date(value.expiresAt).toISOString() };
  };

  const consume = (candidate) => {
    failures = failures.filter((timestamp) => now() - timestamp < ttlMs);
    if (failures.length >= maxFailures) return { ok: false, reason: "rate-limited" };
    const value = active();
    const normalized = typeof candidate === "string" ? candidate.trim().toUpperCase() : "";
    const expected = createHash("sha256").update(value.code).digest();
    const actual = createHash("sha256").update(normalized).digest();
    if (normalized.length !== 12 || !timingSafeEqual(expected, actual)) {
      failures.push(now());
      if (failures.length >= maxFailures) rotate();
      return { ok: false, reason: failures.length >= maxFailures ? "rate-limited" : "invalid" };
    }
    failures = [];
    rotate();
    return { ok: true };
  };

  rotate();
  return { consume, invalidate, rotate, snapshot };
};

const secureEqual = (expected, candidate) => {
  const expectedDigest = createHash("sha256").update(String(expected || "")).digest();
  const candidateDigest = createHash("sha256").update(String(candidate || "")).digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
};

const cookieValue = (header, name) => String(header || "")
  .split(";")
  .map((part) => part.trim())
  .find((part) => part.startsWith(`${name}=`))
  ?.slice(name.length + 1) || "";

export const createLocalSessionManager = ({ dataDir, randomBytesFn = randomBytes }) => {
  const tokenPath = join(dataDir, "local-access-token");
  let accessToken = "";
  if (existsSync(tokenPath)) {
    const stored = readFileSync(tokenPath, "utf8").trim();
    if (/^[a-f0-9]{64}$/i.test(stored)) accessToken = stored.toLowerCase();
  }
  if (!accessToken) {
    accessToken = randomBytesFn(32).toString("hex");
    writeFileSync(tokenPath, `${accessToken}\n`, { mode: 0o600 });
  }
  chmodSync(tokenPath, 0o600);

  const authorize = (request, access) => {
    if (access?.kind === "tailscale") return true;
    if (access?.kind !== "local") return false;
    const candidate = cookieValue(request.headers.cookie, "echo_local_session");
    return candidate.length === 64 && secureEqual(accessToken, candidate);
  };

  const bootstrap = (candidate) => {
    if (typeof candidate !== "string" || candidate.length !== 64 || !secureEqual(accessToken, candidate)) {
      return null;
    }
    return `echo_local_session=${accessToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
  };

  return {
    authorize,
    bootstrap,
    localUrl: (port) => `http://127.0.0.1:${port}/#access=${accessToken}`,
    tokenPath
  };
};

export { normalizeOrigin };
