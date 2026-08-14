import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PodcastDatabase } from "../src/db.js";

const episode = {
  platform: "gcores", externalId: "1", title: "测试节目", durationSeconds: 3600,
  publishedAt: "2026-07-01T00:00:00.000Z", description: "", audioUrl: null, imageUrl: null,
  podcast: { externalId: "gcores-radio", title: "机核电台", author: "机核" }, topic: "游戏", raw: {}
};

const permissionMode = (path) => statSync(path).mode & 0o777;

test("database storage, SQLite sidecars, and backups remain private", () => {
  const directory = mkdtempSync(join(tmpdir(), "echo-podcast-memory-permissions-"));
  const databasePath = join(directory, "podcast-memory.sqlite");
  const backupDirectory = join(directory, "backups", "installer");
  const backupPath = join(backupDirectory, "podcast-memory-backup.sqlite");
  try {
    chmodSync(directory, 0o755);
    mkdirSync(backupDirectory, { recursive: true, mode: 0o755 });
    chmodSync(join(directory, "backups"), 0o755);
    chmodSync(backupDirectory, 0o755);
    writeFileSync(backupPath, "backup fixture", { mode: 0o644 });
    writeFileSync(databasePath, "", { mode: 0o644 });

    const db = new PodcastDatabase(databasePath);
    assert.equal(permissionMode(directory), 0o700);
    assert.equal(permissionMode(databasePath), 0o600);
    assert.equal(permissionMode(`${databasePath}-wal`), 0o600);
    assert.equal(permissionMode(`${databasePath}-shm`), 0o600);
    assert.equal(permissionMode(join(directory, "backups")), 0o700);
    assert.equal(permissionMode(backupDirectory), 0o700);
    assert.equal(permissionMode(backupPath), 0o600);
    db.close();
    assert.equal(permissionMode(databasePath), 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("in-memory databases do not require filesystem permission setup", () => {
  const db = new PodcastDatabase(":memory:");
  assert.equal(db.account("apple-podcasts").connected, 0);
  db.close();
});

test("playback samples are idempotent and estimated delta is wall-clock capped", () => {
  const db = new PodcastDatabase(":memory:");
  const episodeId = db.upsertEpisode(episode);
  db.addPlaybackSample({ platform: "gcores", episodeId, progressSeconds: 100, observedAt: "2026-07-01T00:00:00.000Z", source: "test", isEstimated: true });
  const delta = db.addPlaybackSample({ platform: "gcores", episodeId, progressSeconds: 400, observedAt: "2026-07-01T00:02:00.000Z", source: "test", isEstimated: true });
  assert.equal(delta, 120);
  assert.equal(db.dashboard().stats.estimatedSeconds, 120);
  db.close();
});

test("platform totals remain separate from estimated progress", () => {
  const db = new PodcastDatabase(":memory:");
  db.upsertListeningTotal({ platform: "xiaoyuzhou", period: "2026-07", listenedSeconds: 3600, isEstimated: false, source: "monthly" });
  const stats = db.dashboard().stats;
  assert.equal(stats.exactSeconds, 3600);
  assert.equal(stats.estimatedSeconds, 0);
  db.close();
});

test("lifetime totals replace monthly detail instead of double counting", () => {
  const db = new PodcastDatabase(":memory:");
  db.upsertListeningTotal({ platform: "xiaoyuzhou", period: "2026-06", listenedSeconds: 3600, isEstimated: false, source: "monthly" });
  db.upsertListeningTotal({ platform: "xiaoyuzhou", period: "lifetime", listenedSeconds: 7200, isEstimated: false, source: "mileage" });
  assert.equal(db.dashboard().stats.exactSeconds, 7200);
  db.close();
});

test("estimated lifetime totals replace progress deltas", () => {
  const db = new PodcastDatabase(":memory:");
  const episodeId = db.upsertEpisode(episode);
  db.addPlaybackSample({ platform: "gcores", episodeId, progressSeconds: 100, observedAt: "2026-07-01T00:00:00.000Z", source: "test", isEstimated: true });
  db.addPlaybackSample({ platform: "gcores", episodeId, progressSeconds: 400, observedAt: "2026-07-01T00:05:00.000Z", source: "test", isEstimated: true });
  db.upsertListeningTotal({ platform: "gcores", period: "lifetime", listenedSeconds: 1000, isEstimated: true, source: "visible-history" });
  assert.equal(db.dashboard().stats.estimatedSeconds, 1000);
  db.close();
});

test("recent episodes use the progress from the same latest sample", () => {
  const db = new PodcastDatabase(":memory:");
  const firstId = db.upsertEpisode(episode);
  const secondId = db.upsertEpisode({ ...episode, externalId: "2", title: "更新的一期" });
  db.addPlaybackSample({ platform: "gcores", episodeId: firstId, progressSeconds: 900, observedAt: "2026-07-02T00:00:00.000Z", source: "test", isEstimated: true });
  db.addPlaybackSample({ platform: "gcores", episodeId: firstId, progressSeconds: 100, observedAt: "2026-07-03T00:00:00.000Z", source: "test", isEstimated: true });
  db.addPlaybackSample({ platform: "gcores", episodeId: secondId, progressSeconds: 500, observedAt: "2026-07-04T00:00:00.000Z", source: "test", isEstimated: true });
  const recent = db.dashboard().recent;
  assert.equal(recent[0].title, "更新的一期");
  assert.match(recent[0].id, /^ep_[0-9a-f-]{36}$/);
  assert.notEqual(recent[0].id, secondId);
  assert.equal(recent[1].progress_seconds, 100);
  assert.equal(recent[1].observed_at, "2026-07-03T00:00:00.000Z");
  db.close();
});

test("generated summaries become searchable structured episode memories", () => {
  const db = new PodcastDatabase(":memory:");
  const episodeId = db.upsertEpisode(episode);
  db.addPlaybackSample({ platform: "gcores", episodeId, progressSeconds: 600, observedAt: "2026-07-04T00:00:00.000Z", source: "test", isEstimated: true });
  db.saveGeneratedSummary(episodeId, {
    category: "社会与历史",
    summary: "这期解释了一段历史事件的来龙去脉。",
    key_points: ["事件的背景决定了后续走向。"],
    outline: [{ heading: "背景", detail: "先交代时代条件。" }],
    keywords: ["历史"],
    people: ["测试人物"],
    review_questions: ["背景如何影响结果？"],
    limitation: "仅依据节目简介。",
    sourceKind: "shownotes",
    model: "test-model"
  });
  const detail = db.episodeDetail(episodeId);
  assert.equal(detail.ai_category, "社会与历史");
  assert.deepEqual(detail.keyPoints, ["事件的背景决定了后续走向。"]);
  assert.equal(detail.outline[0].heading, "背景");
  assert.equal(db.listEpisodes({ query: "来龙去脉" }).length, 1);
  assert.equal(db.listEpisodes({ topic: "社会与历史" }).length, 1);
  assert.equal(db.dashboard().recent[0].ai_category, "社会与历史");
  db.close();
});

test("automatic summary queue starts only for completion transitions after enablement", () => {
  const db = new PodcastDatabase(":memory:");
  const episodeId = db.upsertEpisode(episode);
  const enabledAt = "2026-07-20T00:00:00.000Z";

  const historical = db.observeEpisodeCompletion({
    episodeId, platform: "gcores", completed: true,
    observedAt: "2026-07-19T23:00:00.000Z", enabledAt
  });
  assert.equal(historical.transition, true);
  assert.equal(historical.queued, false);

  db.observeEpisodeCompletion({
    episodeId, platform: "gcores", completed: false,
    observedAt: "2026-07-20T01:00:00.000Z", enabledAt
  });
  const newlyCompleted = db.observeEpisodeCompletion({
    episodeId, platform: "gcores", completed: true,
    observedAt: "2026-07-20T02:00:00.000Z", enabledAt
  });
  assert.equal(newlyCompleted.queued, true);
  assert.equal(db.nextAutomaticSummary().episode_id, episodeId);

  const duplicate = db.observeEpisodeCompletion({
    episodeId, platform: "gcores", completed: true,
    observedAt: "2026-07-20T03:00:00.000Z", enabledAt
  });
  assert.equal(duplicate.queued, false);
  assert.equal(db.automaticSummaryStats().pending, 1);
  db.close();
});

test("Xiaoyuzhou finished state can queue even when progress is zero", () => {
  const db = new PodcastDatabase(":memory:");
  const episodeId = db.upsertEpisode({ ...episode, platform: "xiaoyuzhou", externalId: "xy-1" });
  db.addPlaybackSample({
    platform: "xiaoyuzhou", episodeId, progressSeconds: 0,
    observedAt: "2026-07-20T02:00:00.000Z", source: "test", isEstimated: false
  });
  const result = db.observeEpisodeCompletion({
    episodeId, platform: "xiaoyuzhou", completed: true,
    observedAt: "2026-07-20T02:00:00.000Z", enabledAt: "2026-07-20T01:00:00.000Z"
  });
  assert.equal(result.queued, true);
  assert.equal(db.episodeDetail(episodeId).is_completed, 1);
  db.close();
});

test("existing summary prevents an automatic queue entry", () => {
  const db = new PodcastDatabase(":memory:");
  const episodeId = db.upsertEpisode(episode);
  db.addSummary(episodeId, "已经有回顾", []);
  const result = db.observeEpisodeCompletion({
    episodeId, platform: "gcores", completed: true,
    observedAt: "2026-07-20T02:00:00.000Z", enabledAt: "2026-07-20T01:00:00.000Z"
  });
  assert.equal(result.transition, true);
  assert.equal(result.queued, false);
  assert.equal(db.nextAutomaticSummary(), null);
  db.close();
});

test("migration seeds the automatically detected Apple Podcasts account", () => {
  const db = new PodcastDatabase(":memory:");
  assert.equal(db.account("apple-podcasts").connected, 0);
  db.close();
});

test("sparse metadata refreshes do not erase richer saved episode data", () => {
  const db = new PodcastDatabase(":memory:");
  const richEpisode = { ...episode, description: "完整节目简介" };
  const episodeId = db.upsertEpisode(richEpisode);
  db.upsertEpisode({
    ...richEpisode,
    title: "",
    durationSeconds: 0,
    description: "",
    podcast: { ...episode.podcast, author: "" }
  });
  const detail = db.episodeDetail(episodeId);
  assert.equal(detail.title, "测试节目");
  assert.equal(detail.duration_seconds, 3600);
  assert.equal(detail.description, "完整节目简介");
  assert.equal(detail.podcast_author, "机核");
  db.close();
});

test("Apple refreshes remove stored media URLs that may contain private feed credentials", () => {
  const db = new PodcastDatabase(":memory:");
  const apple = {
    ...episode,
    platform: "apple-podcasts",
    externalId: "apple-private",
    audioUrl: "https://private.example/audio.mp3?token=secret",
    imageUrl: "https://private.example/cover.jpg",
    podcast: { externalId: "apple-show", title: "Apple 私有节目", author: "" },
    raw: { source: "legacy", feedUrl: "https://private.example/feed?token=secret" }
  };
  const episodeId = db.upsertEpisode(apple);
  db.upsertEpisode({ ...apple, audioUrl: null, imageUrl: null, raw: { source: "mac-podcasts-library" } });
  const detail = db.episodeDetail(episodeId);
  assert.equal(detail.audio_url, null);
  assert.equal(detail.image_url, null);
  assert.deepEqual(JSON.parse(detail.metadata_json), { source: "mac-podcasts-library" });
  const storedPodcast = db.db.prepare("SELECT image_url, metadata_json FROM podcasts WHERE id=?").get("apple-podcasts:podcast:apple-show");
  assert.equal(storedPodcast.image_url, null);
  assert.deepEqual(JSON.parse(storedPodcast.metadata_json), {
    externalId: "apple-show",
    title: "Apple 私有节目",
    author: ""
  });
  db.close();
});

test("dashboard reports estimated lifetime totals by platform", () => {
  const db = new PodcastDatabase(":memory:");
  db.upsertListeningTotal({
    platform: "apple-podcasts",
    period: "lifetime",
    listenedSeconds: 5400,
    isEstimated: true,
    source: "visible-history-progress"
  });
  const stats = db.dashboard().stats;
  assert.equal(stats.estimatedSeconds, 5400);
  assert.deepEqual(stats.byPlatform["apple-podcasts"], {
    exactSeconds: 0,
    estimatedSeconds: 5400
  });
  db.close();
});
