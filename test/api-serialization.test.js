import assert from "node:assert/strict";
import test from "node:test";
import { serializeEpisodeDetail, serializeSummaryJob } from "../src/api-serialization.js";

test("episode API detail omits raw metadata and credential-bearing media URLs", () => {
  const result = serializeEpisodeDetail({
    id: "apple-podcasts:episode:private",
    public_id: "ep_00000000-0000-4000-8000-000000000000",
    platform: "apple-podcasts",
    title: "私密节目",
    podcast_title: "测试播客",
    external_id: "private-feed-id",
    podcast_id: "private-podcast-id",
    description: "private shownotes",
    audio_url: "https://example.com/audio.mp3?token=secret",
    image_url: "https://example.com/private-cover.jpg",
    metadata_json: JSON.stringify({ feedUrl: "https://example.com/feed?token=secret" }),
    keyPoints: ["公开给当前客户端使用的结构化结果"]
  });
  assert.equal(result.has_audio, true);
  assert.equal(result.id, "ep_00000000-0000-4000-8000-000000000000");
  assert.deepEqual(result.keyPoints, ["公开给当前客户端使用的结构化结果"]);
  for (const field of ["external_id", "podcast_id", "description", "audio_url", "image_url", "metadata_json"]) {
    assert.equal(Object.hasOwn(result, field), false, `${field} must not cross the API boundary`);
  }
});

test("summary job API omits the private database episode identifier", () => {
  const result = serializeSummaryJob({
    id: "job-1",
    episode_id: "apple-podcasts:episode:enclosure:https://private.example/audio?token=secret",
    mode: "notes",
    origin: "manual",
    status: "queued",
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z"
  });
  assert.equal(result.id, "job-1");
  assert.equal(Object.hasOwn(result, "episode_id"), false);
  assert.equal(Object.hasOwn(result, "origin"), false);
});
