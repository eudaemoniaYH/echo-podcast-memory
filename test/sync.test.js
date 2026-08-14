import test from "node:test";
import assert from "node:assert/strict";
import { PodcastDatabase } from "../src/db.js";
import { SyncService } from "../src/sync.js";

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { "content-type": "application/json" }
});

const appleTime = (date) => Date.parse(date) / 1000 - 978_307_200;

test("Apple Podcasts bypasses Keychain, baselines history, then queues one new completion", async () => {
  const db = new PodcastDatabase(":memory:");
  let completed = false;
  let observedAt = appleTime("2026-08-01T00:00:00.000Z");
  const applePodcastsClient = {
    getHistory: () => ({
      available: true,
      schemaVersion: 1,
      episodes: [{
        external_id: "apple-episode-1",
        title: "值得回看的访谈",
        duration: 3600,
        playhead: completed ? 0 : 1200,
        has_been_played: Number(completed),
        play_count: 1,
        observed_at: observedAt,
        published_at: appleTime("2026-07-30T00:00:00.000Z"),
        description: "一段足够长的节目简介，用于生成高质量的文字回顾和知识沉淀。",
        podcast_external_id: "apple-show-1",
        podcast_title: "Apple 精华节目"
      }]
    })
  };
  const credentials = {
    get: async () => { throw new Error("Apple 不应读取钥匙串"); },
    set: async () => {}
  };
  try {
    const service = new SyncService({ db, credentials, applePodcastsClient, automaticSummariesEnabled: true });
    const first = await service.sync("apple-podcasts");
    assert.equal(first.importedCount, 1);
    assert.equal(first.automaticSummaryQueuedCount, 0);
    assert.equal(db.automaticSummaryStats().pending, 0);
    const completionBaseline = db.getMeta("apple_podcasts_completion_baselined_at");
    assert.ok(completionBaseline);

    completed = true;
    observedAt = appleTime(new Date(Date.parse(completionBaseline) + 60_000).toISOString());
    const second = await service.sync("apple-podcasts");
    const third = await service.sync("apple-podcasts");
    assert.equal(second.importedCount, 0);
    assert.equal(second.automaticSummaryQueuedCount, 1);
    assert.equal(third.automaticSummaryQueuedCount, 0);
    assert.equal(db.automaticSummaryStats().pending, 1);
    assert.equal(db.episodeDetail("apple-podcasts:episode:apple-episode-1").is_completed, 1);
    assert.equal(db.listeningTotal(
      "apple-podcasts", "lifetime", "visible-history-progress"
    ).listened_seconds, 3600);
  } finally {
    db.close();
  }
});

test("Apple Podcasts creates its watermark on an empty valid library before the first listen", async () => {
  const db = new PodcastDatabase(":memory:");
  let episodes = [];
  const applePodcastsClient = {
    getHistory: () => ({
      available: true,
      sourceCounts: { podcasts: 0, episodes: episodes.length, listened: episodes.length },
      episodes
    })
  };
  try {
    const service = new SyncService({
      db,
      credentials: { get: async () => { throw new Error("不应读取钥匙串"); }, set: async () => {} },
      applePodcastsClient,
      automaticSummariesEnabled: true
    });
    const empty = await service.sync("apple-podcasts");
    const baseline = db.getMeta("apple_podcasts_completion_baselined_at");
    assert.equal(empty.sourceEpisodeCount, 0);
    assert.ok(baseline);

    const completedAt = new Date(Date.parse(baseline) + 60_000);
    episodes = [{
      external_id: "first-new-listen",
      title: "接入后的第一期",
      duration: 2400,
      playhead: 0,
      has_been_played: 1,
      play_count: 1,
      playback_observed_at: appleTime(completedAt.toISOString()),
      completion_observed_at: appleTime(completedAt.toISOString()),
      description: "这是接入 Apple Podcasts 之后听完的第一期，应该正常进入自动快速回顾队列。",
      podcast_external_id: "first-show",
      podcast_title: "第一档节目"
    }];
    const firstListen = await service.sync("apple-podcasts");
    assert.equal(firstListen.automaticSummaryQueuedCount, 1);
    assert.equal(db.automaticSummaryStats().pending, 1);
  } finally {
    db.close();
  }
});

test("Apple Podcasts does not backfill an unobserved completion from before automatic summaries were enabled", async () => {
  const db = new PodcastDatabase(":memory:");
  db.setMeta("apple_podcasts_completion_baselined_at", "2026-07-01T00:00:00.000Z");
  db.setMeta("auto_summary_enabled_at", "2026-08-01T00:00:00.000Z");
  const applePodcastsClient = {
    getHistory: () => ({
      available: true,
      episodes: [{
        external_id: "old-unobserved-completion",
        title: "启用前已完成",
        duration: 1800,
        playhead: 0,
        has_been_played: 1,
        play_count: 1,
        playback_observed_at: appleTime("2026-07-15T00:00:00.000Z"),
        completion_observed_at: appleTime("2026-07-15T00:00:00.000Z"),
        description: "这条完成记录在自动回顾启用前发生，即使此前未被观察，也不应被补入队列。",
        podcast_external_id: "old-show",
        podcast_title: "旧记录"
      }]
    })
  };
  try {
    const service = new SyncService({
      db,
      credentials: { get: async () => null, set: async () => {} },
      applePodcastsClient,
      automaticSummariesEnabled: true
    });
    const result = await service.sync("apple-podcasts");
    assert.equal(result.automaticSummaryQueuedCount, 0);
    assert.equal(db.automaticSummaryStats().pending, 0);
    assert.equal(db.episodeDetail("apple-podcasts:episode:old-unobserved-completion").is_completed, 1);
  } finally {
    db.close();
  }
});

test("Apple Podcasts manual played state does not queue until a later real completion", async () => {
  const db = new PodcastDatabase(":memory:");
  let stage = 0;
  const baselineDate = new Date(Date.now() + 60_000);
  const rows = () => [{
    external_id: "manual-then-real",
    title: "先手动标记后真正听完",
    duration: 3000,
    playhead: stage === 0 ? 500 : stage === 1 ? 0 : 3000,
    has_been_played: Number(stage > 0),
    play_state_manually_set: Number(stage > 0),
    manual_marked_at: stage > 0 ? appleTime(baselineDate.toISOString()) : null,
    playback_observed_at: appleTime(
      new Date(baselineDate.getTime() + (stage === 2 ? 120_000 : 0)).toISOString()
    ),
    completion_observed_at: appleTime(
      new Date(baselineDate.getTime() + stage * 60_000).toISOString()
    ),
    description: "用于确认仅手动标记不会触发总结，而随后真正听完仍会正常触发。",
    podcast_external_id: "manual-show",
    podcast_title: "手动状态测试"
  }];
  try {
    const service = new SyncService({
      db,
      credentials: { get: async () => null, set: async () => {} },
      applePodcastsClient: { getHistory: () => ({ available: true, episodes: rows() }) },
      automaticSummariesEnabled: true
    });
    await service.sync("apple-podcasts");
    stage = 1;
    const manual = await service.sync("apple-podcasts");
    assert.equal(manual.automaticSummaryQueuedCount, 0);
    stage = 2;
    const real = await service.sync("apple-podcasts");
    assert.equal(real.automaticSummaryQueuedCount, 1);
  } finally {
    db.close();
  }
});

test("unknown sync platforms fail explicitly instead of falling through to Gcores", async () => {
  const db = new PodcastDatabase(":memory:");
  try {
    const service = new SyncService({
      db,
      credentials: { get: async () => ({ token: "must-not-be-used" }), set: async () => {} }
    });
    await assert.rejects(() => service.sync("mystery"), /不支持的播客平台/);
  } finally {
    db.close();
  }
});

const seedAccountForIncrementalXiaoyuzhou = (db) => {
  db.setMeta("xiaoyuzhou_history_backfilled_at", "2026-07-01T00:00:00.000Z");
  db.setMeta("xiaoyuzhou_mileage_synced_at", new Date().toISOString());
  db.setAccount("xiaoyuzhou", { connected: 1, lastSyncAt: "2026-07-01T00:00:00.000Z" });
};

const xiaoyuzhouFetch = (calls, { isFinished = false, progressSeconds = null } = {}) => {
  let pageInRun = 0;
  return async (url, options = {}) => {
    if (url.endsWith("/v1/profile/get")) return jsonResponse({ data: { uid: "user-1", nickname: "测试用户" } });
    if (url.endsWith("/v1/episode-played/list-history")) {
      const body = JSON.parse(options.body);
      if (!body.loadMoreKey) pageInRun = 0;
      pageInRun += 1;
      calls.history += 1;
      return jsonResponse({
        data: [{ episode: {
          eid: `episode-${pageInRun}`,
          title: `第 ${pageInRun} 期`,
          duration: 3600,
          isFinished,
          podcast: { pid: "podcast-1", title: "测试播客" }
        } }],
        loadMoreKey: `cursor-${pageInRun}`
      });
    }
    if (url.endsWith("/v1/playback-progress/list")) {
      const body = JSON.parse(options.body);
      return jsonResponse({ data: body.eids.map((eid, index) => ({
        eid,
        progress: progressSeconds ?? 300 + index,
        playedAt: 1784419200 + index
      })) });
    }
    if (url.includes("/v1/monthly-wrapped/get?")) return jsonResponse({ data: { playedSeconds: 0 } });
    throw new Error(`Unexpected Xiaoyuzhou request: ${url}`);
  };
};

test("Xiaoyuzhou incremental history defaults to three pages after backfill", async () => {
  const previous = process.env.XIAOYUZHOU_INCREMENTAL_HISTORY_PAGES;
  delete process.env.XIAOYUZHOU_INCREMENTAL_HISTORY_PAGES;
  const db = new PodcastDatabase(":memory:");
  try {
    seedAccountForIncrementalXiaoyuzhou(db);
    const calls = { history: 0 };
    const service = new SyncService({
      db,
      credentials: { set: async () => {} },
      fetchFn: xiaoyuzhouFetch(calls)
    });
    const result = await service.syncXiaoyuzhou({ accessToken: "access", refreshToken: "refresh" });
    assert.equal(calls.history, 3);
    assert.equal(result.importedCount, 3);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM playback_samples").get().count, 3);
  } finally {
    db.close();
    if (previous === undefined) delete process.env.XIAOYUZHOU_INCREMENTAL_HISTORY_PAGES;
    else process.env.XIAOYUZHOU_INCREMENTAL_HISTORY_PAGES = previous;
  }
});

test("Xiaoyuzhou finished flag queues once even when platform progress resets to zero", async () => {
  const db = new PodcastDatabase(":memory:");
  try {
    seedAccountForIncrementalXiaoyuzhou(db);
    db.setMeta("auto_summary_enabled_at", "2026-07-01T00:00:00.000Z");
    const calls = { history: 0 };
    const service = new SyncService({
      db,
      credentials: { set: async () => {} },
      fetchFn: xiaoyuzhouFetch(calls, { isFinished: true, progressSeconds: 0 }),
      automaticSummariesEnabled: true
    });
    const first = await service.syncXiaoyuzhou({ accessToken: "access", refreshToken: "refresh" });
    const second = await service.syncXiaoyuzhou({ accessToken: "access", refreshToken: "refresh" });
    assert.equal(first.automaticSummaryQueuedCount, 3);
    assert.equal(second.automaticSummaryQueuedCount, 0);
    assert.equal(db.automaticSummaryStats().pending, 3);
    assert.equal(db.episodeDetail("xiaoyuzhou:episode:episode-1").is_completed, 1);
    assert.equal(db.episodeDetail("xiaoyuzhou:episode:episode-1").progress_seconds, 0);
  } finally {
    db.close();
  }
});

test("Xiaoyuzhou incremental page count is configurable and repeat scans import no old episodes", async () => {
  const previous = process.env.XIAOYUZHOU_INCREMENTAL_HISTORY_PAGES;
  process.env.XIAOYUZHOU_INCREMENTAL_HISTORY_PAGES = "2";
  const db = new PodcastDatabase(":memory:");
  try {
    seedAccountForIncrementalXiaoyuzhou(db);
    const calls = { history: 0 };
    const service = new SyncService({
      db,
      credentials: { set: async () => {} },
      fetchFn: xiaoyuzhouFetch(calls)
    });
    const first = await service.syncXiaoyuzhou({ accessToken: "access", refreshToken: "refresh" });
    const second = await service.syncXiaoyuzhou({ accessToken: "access", refreshToken: "refresh" });
    assert.equal(calls.history, 4);
    assert.equal(first.importedCount, 2);
    assert.equal(second.importedCount, 0);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM episodes").get().count, 2);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM playback_samples").get().count, 2);
  } finally {
    db.close();
    if (previous === undefined) delete process.env.XIAOYUZHOU_INCREMENTAL_HISTORY_PAGES;
    else process.env.XIAOYUZHOU_INCREMENTAL_HISTORY_PAGES = previous;
  }
});

const existingGcoresEpisode = {
  platform: "gcores",
  externalId: "1",
  title: "已保存的完整标题",
  durationSeconds: 3600,
  publishedAt: "2026-07-01T00:00:00.000Z",
  description: "已保存的节目简介",
  audioUrl: "https://alioss.gcores.com/uploads/audio/existing.mp3",
  imageUrl: null,
  podcast: { externalId: "gcores-radio", title: "机核电台", author: "机核" },
  topic: "游戏",
  raw: {}
};

test("Gcores refreshes progress for all history rows but fetches metadata only for new episodes", async () => {
  const db = new PodcastDatabase(":memory:");
  try {
    const existingId = db.upsertEpisode(existingGcoresEpisode);
    let round = 0;
    const metadataRequests = [];
    const service = new SyncService({
      db,
      credentials: { set: async () => {} },
      fetchFn: async (url) => {
        if (url.endsWith("/history")) {
          round += 1;
          const day = String(round).padStart(2, "0");
          return jsonResponse({ data: { attributes: { playlist: [
            { id: "1", type: "radios", progress: 100 + round * 50, timestamp: `2026-07-${day}T01:00:00.000Z` },
            { id: "2", type: "radios", progress: 300 + round * 50, timestamp: `2026-07-${day}T02:00:00.000Z` },
            { id: "article-1", type: "articles", progress: 999, timestamp: `2026-07-${day}T03:00:00.000Z` }
          ] } } });
        }
        if (url.includes("/radios?")) {
          const parsed = new URL(url);
          metadataRequests.push(parsed.searchParams.get("filter[id]"));
          return jsonResponse({
            data: [{ id: "2", type: "radios", attributes: {
              title: "新节目", duration: 4200, desc: "新节目简介", "published-at": "2026-07-02T00:00:00.000Z"
            } }],
            included: []
          });
        }
        throw new Error(`Unexpected Gcores request: ${url}`);
      }
    });

    const first = await service.syncGcores({ token: "token" });
    const second = await service.syncGcores({ token: "token" });

    assert.equal(first.importedCount, 1);
    assert.equal(second.importedCount, 0);
    assert.deepEqual(metadataRequests, ["2"]);
    assert.equal(db.episodeDetail(existingId).title, "已保存的完整标题");
    assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM episodes").get().count, 2);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM playback_samples").get().count, 4);
    assert.equal(db.episodeDetail(existingId).progress_seconds, 200);
    assert.equal(db.visibleProgressTotal("gcores"), 600);
  } finally {
    db.close();
  }
});

test("completion state is tracked while automatic summaries stay disabled and are not backfilled later", async () => {
  const db = new PodcastDatabase(":memory:");
  try {
    seedAccountForIncrementalXiaoyuzhou(db);
    db.setMeta("auto_summary_enabled_at", "2026-07-01T00:00:00.000Z");
    const calls = { history: 0 };
    const service = new SyncService({
      db,
      credentials: { set: async () => {} },
      fetchFn: xiaoyuzhouFetch(calls, { isFinished: true, progressSeconds: 3600 })
    });
    const result = await service.syncXiaoyuzhou({ accessToken: "access", refreshToken: "refresh" });
    assert.equal(result.automaticSummaryQueuedCount, 0);
    assert.equal(db.automaticSummaryStats().pending, 0);
    assert.equal(db.episodeDetail("xiaoyuzhou:episode:episode-1").is_completed, 1);

    const enabledService = new SyncService({
      db,
      credentials: { set: async () => {} },
      fetchFn: xiaoyuzhouFetch({ history: 0 }, { isFinished: true, progressSeconds: 3600 }),
      automaticSummariesEnabled: true
    });
    const afterEnablement = await enabledService.syncXiaoyuzhou({ accessToken: "access", refreshToken: "refresh" });
    assert.equal(afterEnablement.automaticSummaryQueuedCount, 0);
    assert.equal(db.automaticSummaryStats().pending, 0);
  } finally {
    db.close();
  }
});

test("Gcores does not fabricate playback samples when history has no timestamp", async () => {
  const db = new PodcastDatabase(":memory:");
  try {
    db.upsertEpisode(existingGcoresEpisode);
    let metadataFetched = false;
    const service = new SyncService({
      db,
      credentials: { set: async () => {} },
      fetchFn: async (url) => {
        if (url.endsWith("/history")) {
          return jsonResponse({ playlist: [{ id: "1", type: "radios", progress: 900 }] });
        }
        metadataFetched = true;
        return jsonResponse({ data: [], included: [] });
      }
    });
    const result = await service.syncGcores({ token: "token" });
    assert.equal(result.importedCount, 0);
    assert.equal(metadataFetched, false);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM playback_samples").get().count, 0);
  } finally {
    db.close();
  }
});

test("Gcores queues only when progress crosses the inferred completion threshold", async () => {
  const db = new PodcastDatabase(":memory:");
  try {
    const episodeId = db.upsertEpisode(existingGcoresEpisode);
    db.setMeta("auto_summary_enabled_at", "2026-07-01T00:00:00.000Z");
    let round = 0;
    const service = new SyncService({
      db,
      credentials: { set: async () => {} },
      automaticSummariesEnabled: true,
      fetchFn: async (url) => {
        if (url.endsWith("/history")) {
          round += 1;
          return jsonResponse({ playlist: [{
            id: "1", type: "radios",
            progress: round === 1 ? 3500 : 3540,
            timestamp: round === 1 ? "2026-07-20T01:00:00.000Z" : "2026-07-20T02:00:00.000Z"
          }] });
        }
        throw new Error(`Unexpected Gcores request: ${url}`);
      }
    });
    const first = await service.syncGcores({ token: "token" });
    const second = await service.syncGcores({ token: "token" });
    const third = await service.syncGcores({ token: "token" });
    assert.equal(first.automaticSummaryQueuedCount, 0);
    assert.equal(second.automaticSummaryQueuedCount, 1);
    assert.equal(third.automaticSummaryQueuedCount, 0);
    assert.equal(db.automaticSummaryStats().pending, 1);
    assert.equal(db.nextAutomaticSummary().episode_id, episodeId);
  } finally {
    db.close();
  }
});
