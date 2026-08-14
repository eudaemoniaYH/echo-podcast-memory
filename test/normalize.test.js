import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTopic,
  normalizeApplePodcastsEpisode,
  normalizeAppleTimestamp,
  normalizeGcoresRadio,
  normalizeProgress,
  normalizeXiaoyuzhouEpisode
} from "../src/normalize.js";

test("classifies common Chinese podcast topics", () => {
  assert.equal(classifyTopic("大模型和 GPU 的未来"), "AI 与科技");
  assert.equal(classifyTopic("任天堂新游戏体验"), "游戏");
});

test("normalizes a Xiaoyuzhou episode", () => {
  const result = normalizeXiaoyuzhouEpisode({
    eid: "e1", title: "AI 新世界", duration: 3600, pubDate: 1_700_000_000,
    podcast: { pid: "p1", title: "测试播客" }
  });
  assert.equal(result.externalId, "e1");
  assert.equal(result.podcast.externalId, "p1");
  assert.equal(result.durationSeconds, 3600);
  assert.equal(result.topic, "AI 与科技");
});

test("normalizes Gcores duration expressed in milliseconds", () => {
  const result = normalizeGcoresRadio({ id: "9", title: "游戏设计", duration: 3_600_000 });
  assert.equal(result.durationSeconds, 3600);
  assert.equal(result.podcast.title, "机核电台");
});

test("normalizes Gcores Draft.js content and timeline text", () => {
  const result = normalizeGcoresRadio({
    id: "10",
    title: "一期节目",
    content: JSON.stringify({ blocks: [{ text: "正文第一段" }, { text: "正文第二段" }] }),
    timelines: [{ at: 65, title: "开场", content: "介绍嘉宾" }]
  });
  assert.match(result.description, /正文第一段\n正文第二段/);
  assert.match(result.description, /\[1:05\] 开场：介绍嘉宾/);
});

test("uses Xiaoyuzhou playedAt as the real playback time", () => {
  const result = normalizeProgress({
    eid: "e1",
    progress: 120,
    playedAt: "2026-07-18T10:13:06.014Z",
    timestamp: 1
  });
  assert.equal(result.observedAt, "2026-07-18T10:13:06.014Z");
});

test("does not invent a playback time when the platform omits it", () => {
  assert.equal(normalizeProgress({ eid: "e1", progress: 120 }).observedAt, null);
});

test("normalizes mixed Apple reference-date and Unix timestamps", () => {
  assert.equal(normalizeAppleTimestamp(804_556_800), "2026-07-01T00:00:00.000Z");
  assert.equal(normalizeAppleTimestamp(1_782_864_000), "2026-07-01T00:00:00.000Z");
});

test("normalizes Apple Podcasts show notes and explicit played state", () => {
  const result = normalizeApplePodcastsEpisode({
    external_id: "apple-1",
    title: "AI 与我们的生活",
    duration: 3600,
    playhead: 0,
    has_been_played: 1,
    observed_at: 804_556_800,
    published_at: 804_470_400,
    description: "<p>第一段 &amp; 重点</p><p>第二段</p>",
    podcast_external_id: "show-1",
    podcast_title: "精华节目",
    audio_url: "https://private.example/audio.mp3?token=secret",
    feed_url: "https://private.example/feed.xml?token=secret"
  });
  assert.equal(result.episode.platform, "apple-podcasts");
  assert.equal(result.episode.description, "第一段 & 重点\n\n第二段");
  assert.equal(result.episode.topic, "AI 与科技");
  assert.equal(result.episode.audioUrl, null);
  assert.deepEqual(result.episode.raw, { source: "mac-podcasts-library" });
  assert.equal(result.playback.completed, true);
  assert.equal(result.playback.automaticSummaryEligible, true);
  assert.equal(result.playback.observedAt, "2026-07-01T00:00:00.000Z");
});

test("Apple Podcasts does not infer completion from 99 percent progress", () => {
  const result = normalizeApplePodcastsEpisode({
    external_id: "apple-99",
    title: "还差一点听完",
    duration: 3600,
    playhead: 3590,
    has_been_played: 0,
    playback_observed_at: 804_556_800,
    completion_observed_at: 804_556_800,
    podcast_external_id: "show-1",
    podcast_title: "测试节目"
  });
  assert.equal(result.playback.completed, false);
  assert.equal(result.playback.automaticSummaryEligible, false);
  assert.equal(result.playback.estimatedListenedSeconds, 3590);
});

test("Apple Podcasts separates playback time from a manual played-state change", () => {
  const result = normalizeApplePodcastsEpisode({
    external_id: "apple-manual",
    title: "手动标记的一期",
    duration: 3600,
    playhead: 300,
    has_been_played: 1,
    play_state_manually_set: 1,
    playback_observed_at: 804_556_800,
    completion_observed_at: 804_643_200,
    manual_marked_at: 804_643_200,
    podcast_external_id: "show-1",
    podcast_title: "测试节目"
  });
  assert.equal(result.playback.playbackObservedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(result.playback.completionObservedAt, "2026-07-02T00:00:00.000Z");
  assert.equal(result.playback.completed, true);
  assert.equal(result.playback.manuallyCompleted, true);
  assert.equal(result.playback.automaticSummaryEligible, false);
  assert.equal(result.playback.estimatedListenedSeconds, 300);
});
