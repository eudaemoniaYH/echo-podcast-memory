import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PodcastDatabase } from "../src/db.js";

const projectRoot = join(import.meta.dirname, "..");

const freePort = async () => await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const port = probe.address().port;
    probe.close((error) => error ? reject(error) : resolve(port));
  });
});

const startServer = async (dataDir, extraEnv = {}) => {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      PODCAST_MEMORY_DATA: dataDir,
      PODCAST_MEMORY_PUBLIC_ORIGIN: "",
      PODCAST_MEMORY_TRUST_PROXY: "0",
      AUTO_SUMMARY_ENABLED: "0",
      ENABLE_AI_SUMMARY: "0",
      ...extraEnv
    },
    stdio: "ignore"
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return { child, port };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  child.kill("SIGKILL");
  throw new Error("server did not become ready");
};

const stopServer = async (child) => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
};

test("normal loopback APIs require the private local session cookie", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "echo-server-auth-"));
  let running;
  try {
    const disk = new PodcastDatabase(join(dataDir, "podcast-memory.sqlite"));
    const internalId = disk.upsertEpisode({
      platform: "apple-podcasts",
      externalId: "enclosure:https://private.example/audio.mp3?token=PRIVATE_SENTINEL",
      title: "私有 Feed 单集",
      durationSeconds: 300,
      topic: "其他",
      audioUrl: "https://private.example/audio.mp3?token=PRIVATE_SENTINEL",
      imageUrl: "https://private.example/cover.jpg?token=PRIVATE_SENTINEL",
      podcast: {
        externalId: "feed:https://private.example/feed.xml?token=PRIVATE_SENTINEL",
        title: "私有 Feed"
      },
      raw: { feedUrl: "https://private.example/feed.xml?token=PRIVATE_SENTINEL" }
    });
    disk.addPlaybackSample({
      platform: "apple-podcasts",
      episodeId: internalId,
      progressSeconds: 120,
      observedAt: "2026-08-14T00:00:00.000Z",
      source: "test",
      isEstimated: true
    });
    disk.close();

    running = await startServer(dataDir);
    const base = `http://127.0.0.1:${running.port}`;
    assert.equal((await fetch(`${base}/api/dashboard`)).status, 401);

    const accessToken = readFileSync(join(dataDir, "local-access-token"), "utf8").trim();
    const bootstrap = await fetch(`${base}/api/local-session`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ accessToken })
    });
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get("set-cookie").split(";")[0];
    const dashboard = await fetch(`${base}/api/dashboard`, { headers: { cookie } });
    assert.equal(dashboard.status, 200);
    const dashboardText = await dashboard.text();
    assert.doesNotMatch(dashboardText, /PRIVATE_SENTINEL|private\.example/);

    const listResponse = await fetch(`${base}/api/episodes?limit=1`, { headers: { cookie } });
    const listText = await listResponse.text();
    assert.doesNotMatch(listText, /PRIVATE_SENTINEL|private\.example/);
    const list = JSON.parse(listText);
    assert.match(list.episodes[0].id, /^ep_[0-9a-f-]{36}$/);
    const detail = await fetch(`${base}/api/episodes/${encodeURIComponent(list.episodes[0].id)}`, {
      headers: { cookie }
    });
    const detailText = await detail.text();
    assert.doesNotMatch(detailText, /PRIVATE_SENTINEL|private\.example/);
    const detailPayload = JSON.parse(detailText);
    assert.equal(Object.hasOwn(detailPayload.episode, "audio_url"), false);
    assert.equal(Object.hasOwn(detailPayload.episode, "metadata_json"), false);
    assert.equal(typeof detailPayload.episode.has_audio, "boolean");
  } finally {
    if (running) await stopServer(running.child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("showcase mode always uses synthetic in-memory data", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "echo-showcase-boundary-"));
  let running;
  try {
    const disk = new PodcastDatabase(join(dataDir, "podcast-memory.sqlite"));
    disk.upsertEpisode({
      platform: "gcores",
      externalId: "private-sentinel",
      title: "PRIVATE_SENTINEL_MUST_NOT_BE_SERVED",
      durationSeconds: 60,
      topic: "其他",
      podcast: { externalId: "private", title: "Private" },
      raw: {}
    });
    disk.close();

    running = await startServer(dataDir, { PODCAST_MEMORY_SHOWCASE: "1" });
    const base = `http://127.0.0.1:${running.port}`;
    const list = await fetch(`${base}/api/episodes?limit=100`).then((response) => response.json());
    assert.equal(list.episodes.some((episode) => episode.title.includes("PRIVATE_SENTINEL")), false);
    assert.equal((await fetch(`${base}/api/sync/gcores`, { method: "POST" })).status, 403);
  } finally {
    if (running) await stopServer(running.child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("deep audio requires per-use confirmation and protected media stays blocked by default", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "echo-deep-audio-boundary-"));
  let running;
  try {
    const disk = new PodcastDatabase(join(dataDir, "podcast-memory.sqlite"));
    disk.upsertEpisode({
      platform: "gcores",
      externalId: "protected-test-radio",
      title: "受保护音频边界测试",
      durationSeconds: 1800,
      description: "这是一段足够长的合成节目简介，只用于确认受保护音频不会在缺少明确许可时离开本机。",
      topic: "其他",
      audioUrl: null,
      podcast: { externalId: "gcores-radio", title: "合成测试节目" },
      raw: { mediaType: "protected_audio" }
    });
    disk.close();

    running = await startServer(dataDir, {
      ENABLE_AI_SUMMARY: "1",
      ENABLE_API_TRANSCRIPTION: "1",
      OPENAI_API_KEY: "sk-synthetic-test-key-never-sent",
      ALLOW_PROTECTED_AUDIO_TRANSCRIPTION: "0"
    });
    const base = `http://127.0.0.1:${running.port}`;
    const accessToken = readFileSync(join(dataDir, "local-access-token"), "utf8").trim();
    const bootstrap = await fetch(`${base}/api/local-session`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ accessToken })
    });
    const cookie = bootstrap.headers.get("set-cookie").split(";")[0];
    const list = await fetch(`${base}/api/episodes?limit=10`, { headers: { cookie } }).then((response) => response.json());
    const publicId = list.episodes.find((episode) => episode.title === "受保护音频边界测试").id;

    const withoutConfirmation = await fetch(`${base}/api/summarize/${encodeURIComponent(publicId)}`, {
      method: "POST",
      headers: { cookie, origin: base, "content-type": "application/json" },
      body: JSON.stringify({ mode: "deep" })
    });
    assert.equal(withoutConfirmation.status, 400);

    const accepted = await fetch(`${base}/api/summarize/${encodeURIComponent(publicId)}`, {
      method: "POST",
      headers: { cookie, origin: base, "content-type": "application/json" },
      body: JSON.stringify({ mode: "deep", cloudAudioConfirmed: true })
    });
    assert.equal(accepted.status, 202);
    const { job } = await accepted.json();
    let finalJob = job;
    for (let attempt = 0; attempt < 30 && ["queued", "running"].includes(finalJob.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finalJob = await fetch(`${base}/api/summary-jobs/${encodeURIComponent(job.id)}`, {
        headers: { cookie }
      }).then((response) => response.json()).then((payload) => payload.job);
    }
    assert.equal(finalJob.status, "failed");
    assert.match(finalJob.error, /受保护音频默认不允许上传/);
  } finally {
    if (running) await stopServer(running.child);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
