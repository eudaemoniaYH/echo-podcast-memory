import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KeychainCredentialStore } from "./credentials.js";
import { AIService } from "./ai.js";
import { GcoresClient } from "./connectors/gcores.js";
import { PodcastDatabase } from "./db.js";
import { seedDemo } from "./demo.js";
import { SyncService } from "./sync.js";
import { createPairingManager, createRequestAccessPolicy } from "./http-security.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.PODCAST_MEMORY_DATA || join(root, ".data");
const port = Number(process.env.PORT || 8787);
const syncIntervalMinutes = Math.min(Math.max(Number(process.env.SYNC_INTERVAL_MINUTES || 10), 2), 120);
const syncIntervalMs = syncIntervalMinutes * 60 * 1000;
const showcaseMode = process.env.PODCAST_MEMORY_SHOWCASE === "1";
const automaticSummariesEnabled = !showcaseMode && process.env.AUTO_SUMMARY_ENABLED !== "0";
const accessPolicy = createRequestAccessPolicy({
  port,
  publicOrigin: process.env.PODCAST_MEMORY_PUBLIC_ORIGIN || "",
  trustProxy: process.env.PODCAST_MEMORY_TRUST_PROXY === "1",
  tailscaleLogin: process.env.PODCAST_MEMORY_TAILSCALE_LOGIN || "",
  extensionOrigin: process.env.PODCAST_MEMORY_EXTENSION_ORIGIN
});

const db = new PodcastDatabase(join(dataDir, "podcast-memory.sqlite"));
if (automaticSummariesEnabled && !db.getMeta("auto_summary_enabled_at")) {
  db.setMeta("auto_summary_enabled_at", new Date().toISOString());
}
const credentialStore = new KeychainCredentialStore();
const syncService = new SyncService({ db, credentials: credentialStore });
const aiService = new AIService({ credentials: credentialStore });
const runningSummaryJobs = new Map();
const runningSummaryTasks = new Set();
const pendingSummaryTasks = [];
let activeSummaryTask = null;
let automaticSummaryScheduledForCycle = false;
let shuttingDown = false;
const automationState = {
  serverStartedAt: new Date().toISOString(),
  intervalMinutes: syncIntervalMinutes,
  running: false,
  trigger: null,
  lastStartedAt: null,
  lastCompletedAt: null,
  nextSyncAt: null,
  platforms: {},
  automaticSummary: {
    enabled: automaticSummariesEnabled,
    enabledAt: db.getMeta("auto_summary_enabled_at"),
    status: automaticSummariesEnabled ? "waiting" : "disabled",
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null
  }
};
let syncCyclePromise = null;
const platformSyncPromises = new Map();
seedDemo(db);
const pairingManager = showcaseMode ? null : createPairingManager({ dataDir });

const sendJson = (response, status, payload, origin = null) => {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  };
  if (accessPolicy.isExtensionOrigin(origin)) headers["access-control-allow-origin"] = origin;
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
};

const readBody = async (request) => {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 65_536) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
};

const trustedMutationOrigin = (origin, access) => !showcaseMode &&
  accessPolicy.trustedPageOrigin(origin, access);

const syncPlatform = (platform, trigger) => {
  const existing = platformSyncPromises.get(platform);
  if (existing) return existing;
  const startedAt = new Date().toISOString();
  automationState.platforms[platform] = { status: "running", trigger, startedAt };
  const promise = (async () => {
    try {
      const result = await syncService.sync(platform);
      automationState.platforms[platform] = {
        status: result.skipped ? "skipped" : "success",
        trigger,
        startedAt,
        completedAt: new Date().toISOString(),
        importedCount: Number(result.importedCount || 0),
        automaticSummaryQueuedCount: Number(result.automaticSummaryQueuedCount || 0),
        reason: result.reason || null
      };
      return result;
    } catch (error) {
      automationState.platforms[platform] = {
        status: "failed",
        trigger,
        startedAt,
        completedAt: new Date().toISOString(),
        error: error.message || String(error)
      };
      throw error;
    }
  })().finally(() => platformSyncPromises.delete(platform));
  platformSyncPromises.set(platform, promise);
  return promise;
};

const runSyncCycle = (trigger = "schedule") => {
  if (syncCyclePromise) return syncCyclePromise;
  automationState.running = true;
  automationState.trigger = trigger;
  automationState.lastStartedAt = new Date().toISOString();
  syncCyclePromise = (async () => {
    for (const platform of ["xiaoyuzhou", "gcores", "apple-podcasts"]) {
      if (platform !== "apple-podcasts" && !db.account(platform)?.connected) continue;
      try { await syncPlatform(platform, trigger); } catch {}
    }
    try { await scheduleOneAutomaticSummary(); } catch (error) {
      automationState.automaticSummary.status = "failed";
      automationState.automaticSummary.lastError = error.message || String(error);
    }
  })().finally(() => {
    automationState.running = false;
    automationState.trigger = null;
    automationState.lastCompletedAt = new Date().toISOString();
    automationState.nextSyncAt = new Date(Date.now() + syncIntervalMs).toISOString();
    syncCyclePromise = null;
  });
  return syncCyclePromise;
};

const runSummaryJob = async (jobId, episodeId, mode) => {
  db.updateSummaryJob(jobId, { status: "running", completedSteps: 0, totalSteps: mode === "deep" ? 0 : 1, error: null });
  try {
    const episode = db.episodeDetail(episodeId);
    if (!episode) throw new Error("没有找到这期节目");
    let sourceText = episode.description || "";
    let sourceKind = "shownotes";
    if (mode === "deep") {
      if (!(await aiService.status()).transcriptionConfigured) {
        throw new Error("整期音频转写没有启用；快速回顾已可通过 ChatGPT 订阅使用");
      }
      let transcript = db.transcript(episodeId);
      if (!transcript) {
        let episodeMetadata = {};
        try { episodeMetadata = JSON.parse(episode.metadata_json || "{}"); } catch {}
        const needsProtectedAudio = episode.platform === "gcores" &&
          (episodeMetadata.mediaType === "protected_audio" || !episode.audio_url);
        if (needsProtectedAudio) {
          const gcoresCredentials = await credentialStore.get("gcores");
          if (!gcoresCredentials) throw new Error("请重新连接机核账号后再读取这期音频");
          const gcores = new GcoresClient({ credentials: gcoresCredentials });
          episode.audio_url = await gcores.getProtectedAudioUrl(episode.external_id);
        }
        if (!episode.audio_url) throw new Error("这期节目暂时没有可读取的音频地址");
        const result = await aiService.transcribeAudio({
          episode,
          onTranscript: ({ completed, total }) => db.updateSummaryJob(jobId, {
            status: "running", completedSteps: completed, totalSteps: total + 1
          })
        });
        db.saveTranscript(episodeId, { text: result.text, sourceKind: "audio", model: result.model });
        transcript = db.transcript(episodeId);
      }
      sourceText = transcript.transcript;
      sourceKind = "transcript";
      const current = db.summaryJob(jobId);
      db.updateSummaryJob(jobId, {
        completedSteps: current?.total_steps ? current.total_steps - 1 : 1,
        totalSteps: current?.total_steps || 2
      });
    }
    const summary = await aiService.createSummary({ episode, sourceText, sourceKind });
    db.saveGeneratedSummary(episodeId, summary);
    const current = db.summaryJob(jobId);
    db.updateSummaryJob(jobId, {
      status: "completed",
      completedSteps: Math.max(current?.total_steps || 1, 1),
      totalSteps: Math.max(current?.total_steps || 1, 1),
      error: null
    });
    return { success: true };
  } catch (error) {
    const message = error.message || String(error);
    db.updateSummaryJob(jobId, { status: "failed", error: message });
    return { success: false, error: message };
  }
};

const drainSummaryTasks = () => {
  if (activeSummaryTask || shuttingDown) return;
  const item = pendingSummaryTasks.shift();
  if (!item) return;
  if (item.origin === "auto") {
    automationState.automaticSummary.status = "running";
    automationState.automaticSummary.lastStartedAt = new Date().toISOString();
    automationState.automaticSummary.lastError = null;
  }
  const task = runSummaryJob(item.jobId, item.episodeId, item.mode);
  activeSummaryTask = task;
  runningSummaryTasks.add(task);
  void task.then((result) => {
    if (item.origin === "auto") {
      db.finishAutomaticSummary(item.episodeId, result);
      automationState.automaticSummary.status = result.success ? "waiting" : "failed";
      automationState.automaticSummary.lastCompletedAt = new Date().toISOString();
      automationState.automaticSummary.lastError = result.error || null;
    }
  }).finally(() => {
    runningSummaryTasks.delete(task);
    runningSummaryJobs.delete(item.episodeId);
    activeSummaryTask = null;
    drainSummaryTasks();
  });
};

const enqueueSummaryTask = ({ episodeId, mode = "notes", origin = "manual" }) => {
  const existingId = runningSummaryJobs.get(episodeId);
  if (existingId) return db.summaryJob(existingId);
  if (runningSummaryJobs.size >= 4) throw new Error("文字回顾队列已有四个任务，请稍后再试");
  const jobId = randomUUID();
  const job = db.createSummaryJob({ id: jobId, episodeId, mode, origin });
  if (origin === "auto" && !db.claimAutomaticSummary(episodeId, jobId)) {
    db.updateSummaryJob(jobId, { status: "failed", error: "自动任务已被其他同步处理" });
    return null;
  }
  runningSummaryJobs.set(episodeId, jobId);
  pendingSummaryTasks.push({ jobId, episodeId, mode, origin });
  drainSummaryTasks();
  return job;
};

const scheduleOneAutomaticSummary = async () => {
  if (!automaticSummariesEnabled || shuttingDown) return null;
  if (pendingSummaryTasks.some((item) => item.origin === "auto") ||
      (activeSummaryTask && [...runningSummaryJobs.values()].some((id) => db.summaryJob(id)?.origin === "auto"))) {
    return null;
  }
  const status = await aiService.status();
  if (!status.configured) {
    automationState.automaticSummary.status = "needs-login";
    automationState.automaticSummary.lastError = status.message;
    return null;
  }
  const candidate = db.nextAutomaticSummary();
  if (!candidate) {
    automationState.automaticSummary.status = "waiting";
    return null;
  }
  const job = enqueueSummaryTask({ episodeId: candidate.episode_id, mode: "notes", origin: "auto" });
  if (job) automationState.automaticSummary.status = "queued";
  return job;
};

const handleConnect = async (platform, request, response, origin) => {
  if (!accessPolicy.isExtensionOrigin(origin)) {
    return sendJson(response, 403, { error: "账号绑定只能由本地浏览器连接器发起" }, origin);
  }
  const body = await readBody(request);
  const credentials = platform === "xiaoyuzhou"
    ? { accessToken: body.accessToken, refreshToken: body.refreshToken, deviceId: body.deviceId }
    : { token: body.token };
  if (Object.values(credentials).filter(Boolean).length < (platform === "xiaoyuzhou" ? 2 : 1)) {
    return sendJson(response, 400, { error: "未找到完整登录会话，请先在平台网页登录" }, origin);
  }
  const pairingResult = pairingManager.consume(body.pairingCode);
  if (!pairingResult.ok) {
    return sendJson(response, pairingResult.reason === "rate-limited" ? 429 : 403, {
      error: pairingResult.reason === "rate-limited" ? "配对尝试过多，请等待新配对码" : "配对码不正确或已过期"
    }, origin);
  }
  const previousCredentials = await credentialStore.get(platform);
  try {
    await credentialStore.set(platform, credentials);
    const result = await syncPlatform(platform, "connect");
    pairingManager.rotate();
    db.clearDemo();
    void scheduleOneAutomaticSummary();
    sendJson(response, 200, { ok: true, importedCount: result.importedCount }, origin);
  } catch {
    pairingManager.invalidate();
    if (previousCredentials) await credentialStore.set(platform, previousCredentials);
    else await credentialStore.delete(platform);
    sendJson(response, 422, { error: "平台会话验证失败，请重新登录后再试" }, origin);
  }
};

const staticFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"],
  ["/manifest.webmanifest", "manifest.webmanifest"],
  ["/sw.js", "sw.js"],
  ["/icons/echo.svg", "icons/echo.svg"],
  ["/icons/echo-180.png", "icons/echo-180.png"],
  ["/icons/echo-192.png", "icons/echo-192.png"],
  ["/icons/echo-512.png", "icons/echo-512.png"]
]);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

const server = createServer(async (request, response) => {
  const origin = request.headers.origin || null;
  try {
    const access = accessPolicy.classify(request);
    if (!access.allowed) return sendJson(response, 421, { error: "Untrusted request host" });
    const url = new URL(request.url, access.origin);
    if (request.method === "OPTIONS") {
      if (!accessPolicy.isLocal(access) || !accessPolicy.isExtensionOrigin(origin)) {
        return sendJson(response, 403, { error: "Forbidden" });
      }
      response.writeHead(204, {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600"
      });
      return response.end();
    }
    if (showcaseMode && request.method !== "GET" && request.method !== "HEAD") {
      return sendJson(response, 403, { error: "只读展示模式不接受修改请求" });
    }
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      return sendJson(response, 200, { ...db.dashboard(), showcaseMode });
    }
    if (request.method === "GET" && url.pathname === "/api/automation") {
      return sendJson(response, 200, {
        ...automationState,
        showcaseMode,
        automaticSummary: {
          ...automationState.automaticSummary,
          queue: db.automaticSummaryStats()
        },
        secureAccess: access.origin.startsWith("https://"),
        host: access.host
      });
    }
    if (request.method === "GET" && url.pathname === "/api/episodes") {
      return sendJson(response, 200, {
        episodes: db.listEpisodes({
          query: url.searchParams.get("q") || "",
          topic: url.searchParams.get("topic") || "",
          platform: url.searchParams.get("platform") || "",
          summarizedOnly: url.searchParams.get("summarized") === "1",
          limit: url.searchParams.get("limit") || 50,
          offset: url.searchParams.get("offset") || 0
        })
      });
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/episodes/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/episodes/".length));
      const episode = db.episodeDetail(id);
      return episode ? sendJson(response, 200, { episode }) : sendJson(response, 404, { error: "没有找到这期节目" });
    }
    if (request.method === "GET" && url.pathname === "/api/ai/status") {
      if (showcaseMode) {
        return sendJson(response, 200, {
          showcaseMode: true,
          configured: false,
          transcriptionConfigured: false,
          message: "只读展示模式未连接 AI"
        });
      }
      const status = await aiService.status({ force: url.searchParams.get("refresh") === "1" });
      return sendJson(response, 200, {
        ...status,
        automaticSummary: {
          ...automationState.automaticSummary,
          queue: db.automaticSummaryStats()
        }
      });
    }
    if (request.method === "POST" && url.pathname === "/api/ai/configure") {
      if (!trustedMutationOrigin(origin, access)) return sendJson(response, 403, { error: "只能从受信任的回声页面设置 API Key" });
      const body = await readBody(request);
      return sendJson(response, 200, await aiService.configure(body.apiKey));
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/summary-jobs/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/summary-jobs/".length));
      const job = db.summaryJob(id);
      return job ? sendJson(response, 200, { job }) : sendJson(response, 404, { error: "没有找到这个总结任务" });
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/summarize/")) {
      if (!trustedMutationOrigin(origin, access)) return sendJson(response, 403, { error: "只能从受信任的回声页面生成文字回顾" });
      const aiStatus = await aiService.status();
      if (!aiStatus.configured) return sendJson(response, 422, { error: `${aiStatus.message}；请在 Mac 上使用 ChatGPT 登录 Codex` });
      const episodeId = decodeURIComponent(url.pathname.slice("/api/summarize/".length));
      if (!db.episodeDetail(episodeId)) return sendJson(response, 404, { error: "没有找到这期节目" });
      const body = await readBody(request);
      const mode = body.mode === "deep" ? "deep" : "notes";
      if (mode === "deep" && !aiStatus.transcriptionConfigured) {
        return sendJson(response, 422, { error: "整期音频转写尚未启用；快速回顾已使用 ChatGPT 订阅" });
      }
      const runningId = runningSummaryJobs.get(episodeId);
      if (runningId) return sendJson(response, 202, { job: db.summaryJob(runningId) });
      const job = enqueueSummaryTask({ episodeId, mode, origin: "manual" });
      return sendJson(response, 202, { job });
    }
    if (request.method === "GET" && url.pathname === "/api/pairing-code") {
      if (!accessPolicy.isLocal(access) || showcaseMode) return sendJson(response, 404, { error: "Not found" });
      return sendJson(response, 200, pairingManager.snapshot());
    }
    if (request.method === "GET" && url.pathname === "/api/setup") {
      if (!accessPolicy.isLocal(access)) return sendJson(response, 200, { pairingCode: null, showcaseMode });
      return sendJson(response, 200, {
        ...(showcaseMode ? { pairingCode: null } : pairingManager.snapshot()),
        showcaseMode
      });
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/connect/")) {
      if (!accessPolicy.isLocal(access)) return sendJson(response, 403, { error: "账号绑定只能在本机完成" }, origin);
      const platform = url.pathname.split("/").pop();
      if (!["xiaoyuzhou", "gcores"].includes(platform)) return sendJson(response, 404, { error: "Unknown platform" }, origin);
      return await handleConnect(platform, request, response, origin);
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/sync/")) {
      if (!trustedMutationOrigin(origin, access)) return sendJson(response, 403, { error: "只能从受信任的回声页面同步" });
      const platform = url.pathname.split("/").pop();
      if (!["xiaoyuzhou", "gcores", "apple-podcasts"].includes(platform)) {
        return sendJson(response, 404, { error: "Unknown platform" });
      }
      const result = await syncPlatform(platform, "manual");
      void scheduleOneAutomaticSummary();
      return sendJson(response, 200, { ok: true, ...result });
    }
    const filename = staticFiles.get(url.pathname);
    if ((request.method === "GET" || request.method === "HEAD") && filename) {
      const filePath = join(root, "public", filename);
      response.writeHead(200, {
        "content-type": contentTypes[extname(filePath)],
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: https:; connect-src 'self'",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        ...(url.pathname === "/sw.js" ? { "service-worker-allowed": "/" } : {})
      });
      return response.end(request.method === "HEAD" ? undefined : readFileSync(filePath));
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error("Request failed", error instanceof Error ? error.message : String(error));
    sendJson(response, 500, { error: "Internal error" }, origin);
  }
});

const scheduler = showcaseMode ? null : setInterval(() => { void runSyncCycle("schedule"); }, syncIntervalMs);
scheduler?.unref();
let startupSync = null;

server.listen(port, "127.0.0.1", () => {
  console.log(`Podcast Memory is running at http://127.0.0.1:${port}`);
  console.log(`Automatic sync interval: ${syncIntervalMinutes} minutes`);
  console.log(`Automatic quick reviews: ${automaticSummariesEnabled ? "enabled" : "disabled"}`);
  automationState.nextSyncAt = new Date(Date.now() + 5_000).toISOString();
  if (!showcaseMode) {
    startupSync = setTimeout(() => { void runSyncCycle("startup"); }, 5_000);
    startupSync.unref();
  }
});

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (scheduler) clearInterval(scheduler);
  if (startupSync) clearTimeout(startupSync);
  syncService.cancelActive();
  aiService.cancelActive();
  const serverClosed = new Promise((resolve) => server.close(resolve));
  const activeTasks = [
    ...(syncCyclePromise ? [syncCyclePromise] : []),
    ...platformSyncPromises.values(),
    ...runningSummaryTasks
  ];
  let timeout = null;
  const gracePeriod = new Promise((resolve) => {
    timeout = setTimeout(resolve, 15_000);
    timeout.unref();
  });
  await Promise.race([Promise.allSettled(activeTasks), gracePeriod]);
  if (timeout) clearTimeout(timeout);
  await serverClosed;
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
