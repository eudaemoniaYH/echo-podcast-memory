import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ApplePodcastsClient,
  IsolatedApplePodcastsClient
} from "../src/connectors/apple-podcasts.js";
import { GcoresClient } from "../src/connectors/gcores.js";
import { XiaoyuzhouClient } from "../src/connectors/xiaoyuzhou.js";

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { "content-type": "application/json" }
});

test("Apple Podcasts client reads only listened episodes from the Mac database", () => {
  const directory = mkdtempSync(join(tmpdir(), "echo-apple-podcasts-"));
  const databasePath = join(directory, "MTLibrary.sqlite");
  const fixture = new DatabaseSync(databasePath);
  try {
    fixture.exec(`
      CREATE TABLE ZMTPODCAST (
        Z_PK INTEGER PRIMARY KEY, ZTITLE TEXT, ZAUTHOR TEXT, ZUUID TEXT,
        ZSTORECOLLECTIONID INTEGER, ZFEEDURL TEXT, ZUPDATEDFEEDURL TEXT, ZIMAGEURL TEXT
      );
      CREATE TABLE ZMTEPISODE (
        Z_PK INTEGER PRIMARY KEY, ZPODCAST INTEGER, ZTITLE TEXT, ZUUID TEXT,
        ZSTORETRACKID INTEGER, ZGUID TEXT, ZMETADATAIDENTIFIER TEXT,
        ZDURATION REAL, ZPLAYHEAD REAL, ZHASBEENPLAYED INTEGER, ZPLAYCOUNT INTEGER,
        ZLASTDATEPLAYED REAL, ZPLAYSTATELASTMODIFIEDDATE REAL,
        ZPLAYSTATEMANUALLYSET INTEGER, ZLASTUSERMARKEDASPLAYEDDATE REAL,
        ZPUBDATE REAL, ZITEMDESCRIPTION TEXT, ZENCLOSUREURL TEXT
      );
      INSERT INTO ZMTPODCAST VALUES
        (1, '高质量节目', '主播', 'show-1', 0, 'https://example.com/feed.xml', NULL, 'https://example.com/art.jpg'),
        (2, '私有节目甲', '甲', NULL, 0, 'https://private.example/a.xml', NULL, NULL),
        (3, '私有节目乙', '乙', NULL, 0, 'https://private.example/b.xml', NULL, NULL);
      INSERT INTO ZMTEPISODE VALUES
        (1, 1, '已经听过的一期', 'episode-1', 0, NULL, NULL,
          3600, 1800, 0, 1, 805000000, 805000000, 0, NULL, 804000000,
          '<p>这是一段<strong>完整</strong>简介。</p>', 'https://example.com/episode.mp3'),
        (2, 1, '从未播放的一期', 'episode-2', 0, NULL, NULL,
          4000, 0, 0, 0, NULL, NULL, 0, NULL, 804000000,
          '不应导入', 'https://example.com/unplayed.mp3'),
        (3, 2, '共享 GUID 甲', NULL, 0, 'shared-guid', NULL,
          3000, 600, 0, 1, 805000100, 805000100, 0, NULL, 804000000,
          '私有节目甲简介', 'https://private.example/a.mp3'),
        (4, 3, '共享 GUID 乙', NULL, 0, 'shared-guid', NULL,
          3000, 700, 0, 1, 805000200, 805000200, 0, NULL, 804000000,
          '私有节目乙简介', 'https://private.example/b.mp3');
    `);
  } finally {
    fixture.close();
  }

  try {
    const result = new ApplePodcastsClient({ databasePath }).getHistory();
    assert.equal(result.available, true);
    assert.equal(result.episodes.length, 3);
    const byTitle = new Map(result.episodes.map((episode) => [episode.title, episode]));
    assert.equal(byTitle.get("已经听过的一期").external_id, "uuid:episode-1");
    assert.equal(byTitle.get("已经听过的一期").podcast_title, "高质量节目");
    assert.equal(byTitle.get("已经听过的一期").playhead, 1800);
    assert.notEqual(
      byTitle.get("共享 GUID 甲").external_id,
      byTitle.get("共享 GUID 乙").external_id
    );
    assert.deepEqual(result.sourceCounts, { podcasts: 3, episodes: 4, listened: 3 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Apple Podcasts client treats a missing local database as not initialized", () => {
  const client = new ApplePodcastsClient({ databasePath: join(tmpdir(), "echo-missing-podcasts.sqlite") });
  assert.deepEqual(client.getHistory(), {
    available: false,
    episodes: [],
    databasePath: join(tmpdir(), "echo-missing-podcasts.sqlite")
  });
});

test("isolated Apple Podcasts client reads through a killable worker process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "echo-apple-podcasts-worker-"));
  const databasePath = join(directory, "MTLibrary.sqlite");
  const fixture = new DatabaseSync(databasePath);
  try {
    fixture.exec(`
      CREATE TABLE ZMTPODCAST (
        Z_PK INTEGER PRIMARY KEY, ZTITLE TEXT, ZUUID TEXT
      );
      CREATE TABLE ZMTEPISODE (
        Z_PK INTEGER PRIMARY KEY, ZPODCAST INTEGER, ZTITLE TEXT,
        ZPLAYHEAD REAL, ZHASBEENPLAYED INTEGER, ZLASTDATEPLAYED REAL,
        ZPLAYSTATELASTMODIFIEDDATE REAL, ZPLAYSTATEMANUALLYSET INTEGER,
        ZLASTUSERMARKEDASPLAYEDDATE REAL
      );
    `);
  } finally {
    fixture.close();
  }

  try {
    const result = await new IsolatedApplePodcastsClient({
      databasePath,
      readTimeoutMs: 3000
    }).getHistory();
    assert.equal(result.available, true);
    assert.deepEqual(result.sourceCounts, { podcasts: 0, episodes: 0, listened: 0 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("isolated Apple Podcasts client reports a hard read timeout", async () => {
  let killedWith = null;
  const fakeChild = {
    kill(signal) {
      killedWith = signal;
      return true;
    },
    once() {}
  };
  const client = new IsolatedApplePodcastsClient({
    readTimeoutMs: 25,
    execFileFn: () => fakeChild
  });
  await assert.rejects(
    client.getHistory(),
    /读取超过 1 秒/
  );
  assert.equal(killedWith, "SIGKILL");
});

test("isolated Apple Podcasts client cancels an active reader on shutdown", async () => {
  let killedWith = null;
  const fakeChild = {
    kill(signal) {
      killedWith = signal;
      return true;
    },
    once() {}
  };
  const client = new IsolatedApplePodcastsClient({
    readTimeoutMs: 10_000,
    execFileFn: () => fakeChild
  });
  const pending = client.getHistory();
  client.cancelActive();
  await assert.rejects(pending, /读取已取消/);
  assert.equal(killedWith, "SIGKILL");
});

test("Xiaoyuzhou client uses the read-only history endpoint and session headers", async () => {
  const calls = [];
  const client = new XiaoyuzhouClient({
    credentials: { accessToken: "access", refreshToken: "refresh", deviceId: "device" },
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ data: [{ episode: { eid: "episode-1" } }], loadMoreKey: "next" });
    }
  });
  const result = await client.getHistory(null, 20);
  assert.equal(result.episodes[0].eid, "episode-1");
  assert.equal(result.cursor, "next");
  assert.match(calls[0].url, /episode-played\/list-history$/);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers["x-jike-access-token"], "access");
});

test("Xiaoyuzhou mileage exposes pagination cursor", async () => {
  const client = new XiaoyuzhouClient({
    credentials: { accessToken: "access", refreshToken: "refresh" },
    fetchFn: async () => jsonResponse({ data: [{ playedSeconds: 3600 }], loadMoreKey: 20 })
  });
  const result = await client.getMileage();
  assert.equal(result.rows[0].playedSeconds, 3600);
  assert.equal(result.cursor, 20);
});

test("Gcores client reads playlist history with Token authentication", async () => {
  const calls = [];
  const client = new GcoresClient({
    credentials: { token: "gcores-token" },
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ playlist: [{ id: "42", type: "radios", progress: 900 }] });
    }
  });
  const result = await client.getHistory();
  assert.equal(result[0].id, "42");
  assert.match(calls[0].url, /\/history$/);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.authorization, "Token token=gcores-token");
});

test("Gcores metadata requests every ID in a batch", async () => {
  let requestedUrl = "";
  const client = new GcoresClient({
    credentials: { token: "gcores-token" },
    fetchFn: async (url) => {
      requestedUrl = url;
      return jsonResponse({ data: [], included: [] });
    }
  });
  await client.getRadios(["1", "2", "3"]);
  assert.match(decodeURIComponent(requestedUrl), /page\[limit\]=3/);
  assert.match(decodeURIComponent(requestedUrl), /include=category,media.timelines/);
  assert.match(decodeURIComponent(requestedUrl), /fields\[medias\]=audio,duration,media-type,playback-type,timelines/);
});

test("Gcores client reads a protected audio redirect without following it", async () => {
  let options;
  const client = new GcoresClient({
    credentials: { token: "gcores-token" },
    fetchFn: async (_url, requestOptions) => {
      options = requestOptions;
      return new Response(null, { status: 302, headers: { location: "https://protected.gcores.com/signed/audio.mp3" } });
    }
  });
  assert.equal(await client.getProtectedAudioUrl("42"), "https://protected.gcores.com/signed/audio.mp3");
  assert.equal(options.redirect, "manual");
});

test("Gcores client resolves the included media audio URL", async () => {
  const client = new GcoresClient({
    credentials: { token: "gcores-token" },
    fetchFn: async () => jsonResponse({
      data: [{ id: "42", type: "radios", attributes: { title: "节目" }, relationships: { media: { data: { type: "medias", id: "9" } } } }],
      included: [{ id: "9", type: "medias", attributes: { audio: "episode.mp3" } }]
    })
  });
  const [radio] = await client.getRadios(["42"]);
  assert.equal(radio.audioUrl, "https://alioss.gcores.com/uploads/audio/episode.mp3");
});

test("Gcores protected media never uses the public CDN URL", async () => {
  const client = new GcoresClient({
    credentials: { token: "gcores-token" },
    fetchFn: async () => jsonResponse({
      data: [{ id: "42", type: "radios", attributes: { title: "会员节目" }, relationships: { media: { data: { type: "medias", id: "9" } } } }],
      included: [{ id: "9", type: "medias", attributes: { audio: "protected.mp3", "media-type": "protected_audio" } }]
    })
  });
  const [radio] = await client.getRadios(["42"]);
  assert.equal(radio.mediaType, "protected_audio");
  assert.equal(radio.audioUrl, null);
});
