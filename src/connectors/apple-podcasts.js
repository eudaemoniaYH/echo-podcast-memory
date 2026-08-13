import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const connectorDirectory = dirname(fileURLToPath(import.meta.url));
const defaultWorkerPath = join(connectorDirectory, "..", "workers", "read-apple-podcasts.js");
const MAX_WORKER_OUTPUT_BYTES = 64 * 1024 * 1024;

const configuredReadTimeoutMs = () => {
  const configured = Number(process.env.APPLE_PODCASTS_READ_TIMEOUT_MS);
  if (!Number.isSafeInteger(configured)) return 5000;
  return Math.min(Math.max(configured, 1000), 30_000);
};

export const defaultApplePodcastsDatabasePath = () => (
  process.env.APPLE_PODCASTS_DB_PATH ||
  join(
    homedir(),
    "Library",
    "Group Containers",
    "243LU875E5.groups.com.apple.podcasts",
    "Documents",
    "MTLibrary.sqlite"
  )
);

const columnsFor = (db, table) => new Set(
  db.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name)
);

const hasTable = (db, table) => Boolean(
  db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(table)
);

const column = (columns, alias, name, fallback = "NULL") => (
  columns.has(name) ? `${alias}."${name}"` : fallback
);

const textValue = (columns, alias, name) => (
  columns.has(name) ? `NULLIF(TRIM(CAST(${alias}."${name}" AS TEXT)), '')` : "NULL"
);

const positiveTextValue = (columns, alias, name) => (
  columns.has(name)
    ? `CASE WHEN CAST(${alias}."${name}" AS INTEGER)>0 THEN CAST(${alias}."${name}" AS TEXT) END`
    : "NULL"
);

const numberValue = (columns, alias, name, fallback = "0") => (
  columns.has(name) ? `COALESCE(${alias}."${name}", ${fallback})` : fallback
);

const maximum = (...expressions) => `MAX(${expressions.join(", ")})`;

export class ApplePodcastsClient {
  constructor({ databasePath = defaultApplePodcastsDatabasePath(), Database = DatabaseSync } = {}) {
    this.databasePath = databasePath;
    this.Database = Database;
  }

  getHistory() {
    try {
      statSync(this.databasePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { available: false, episodes: [], databasePath: this.databasePath };
      }
      throw new Error(`无法检查 Mac 播客资料库：${error?.message || error}`);
    }

    let db;
    try {
      db = new this.Database(this.databasePath, { readOnly: true });
    } catch (error) {
      throw new Error(`无法只读打开 Mac 播客资料库：${error?.message || error}`);
    }

    try {
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=2000;");
      if (!hasTable(db, "ZMTEPISODE") || !hasTable(db, "ZMTPODCAST")) {
        throw new Error("Mac 播客资料库结构不兼容：缺少节目或单集表");
      }
      const episodeColumns = columnsFor(db, "ZMTEPISODE");
      const podcastColumns = columnsFor(db, "ZMTPODCAST");
      for (const required of [
        "Z_PK",
        "ZPODCAST",
        "ZTITLE",
        "ZPLAYHEAD",
        "ZHASBEENPLAYED",
        "ZLASTDATEPLAYED",
        "ZPLAYSTATELASTMODIFIEDDATE",
        "ZPLAYSTATEMANUALLYSET",
        "ZLASTUSERMARKEDASPLAYEDDATE"
      ]) {
        if (!episodeColumns.has(required)) {
          throw new Error(`Mac 播客资料库结构不兼容：单集缺少 ${required}`);
        }
      }
      for (const required of ["Z_PK", "ZTITLE"]) {
        if (!podcastColumns.has(required)) {
          throw new Error(`Mac 播客资料库结构不兼容：节目缺少 ${required}`);
        }
      }

      const feedUrl = `COALESCE(
        ${textValue(podcastColumns, "p", "ZUPDATEDFEEDURL")},
        ${textValue(podcastColumns, "p", "ZFEEDURL")}
      )`;
      const podcastExternalId = `COALESCE(
        'uuid:' || ${textValue(podcastColumns, "p", "ZUUID")},
        'store:' || ${positiveTextValue(podcastColumns, "p", "ZSTORECOLLECTIONID")},
        'feed:' || ${feedUrl},
        'local-pk:' || CAST(p.Z_PK AS TEXT),
        'unknown'
      )`;
      const qualifiedGuid = `CASE
        WHEN ${textValue(episodeColumns, "e", "ZGUID")} IS NOT NULL
        THEN 'guid:' || ${podcastExternalId} || ':' || ${textValue(episodeColumns, "e", "ZGUID")}
      END`;
      const episodeExternalId = `COALESCE(
        'uuid:' || ${textValue(episodeColumns, "e", "ZUUID")},
        'store:' || ${positiveTextValue(episodeColumns, "e", "ZSTORETRACKID")},
        'metadata:' || ${textValue(episodeColumns, "e", "ZMETADATAIDENTIFIER")},
        ${qualifiedGuid},
        'enclosure:' || ${textValue(episodeColumns, "e", "ZENCLOSUREURL")},
        'local-pk:' || CAST(e.Z_PK AS TEXT)
      )`;
      const playhead = numberValue(episodeColumns, "e", "ZPLAYHEAD");
      const hasBeenPlayed = numberValue(episodeColumns, "e", "ZHASBEENPLAYED");
      const playCount = numberValue(episodeColumns, "e", "ZPLAYCOUNT");
      const listenedCondition = [
        `${column(episodeColumns, "e", "ZLASTDATEPLAYED")} IS NOT NULL`,
        `${playhead} > 0`,
        `${hasBeenPlayed} > 0`,
        `${playCount} > 0`
      ].join(" OR ");

      const sourceCounts = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM ZMTPODCAST) AS podcast_count,
          (SELECT COUNT(*) FROM ZMTEPISODE) AS episode_count
      `).get();
      const episodes = db.prepare(`
        SELECT
          ${episodeExternalId} AS external_id,
          COALESCE(
            ${textValue(episodeColumns, "e", "ZTITLE")},
            ${textValue(episodeColumns, "e", "ZITUNESTITLE")},
            ${textValue(episodeColumns, "e", "ZCLEANEDTITLE")},
            '未命名单集'
          ) AS title,
          ${maximum(
            numberValue(episodeColumns, "e", "ZDURATION"),
            numberValue(episodeColumns, "e", "ZENTITLEDDURATION"),
            numberValue(episodeColumns, "e", "ZFREEDURATION")
          )} AS duration,
          ${column(episodeColumns, "e", "ZPUBDATE")} AS published_at,
          COALESCE(
            ${textValue(episodeColumns, "e", "ZITEMDESCRIPTIONWITHOUTHTML")},
            ${textValue(episodeColumns, "e", "ZITUNESSUBTITLE")},
            ${textValue(episodeColumns, "e", "ZITEMDESCRIPTION")},
            ''
          ) AS description,
          COALESCE(
            ${textValue(episodeColumns, "e", "ZENCLOSUREURL")},
            ${textValue(episodeColumns, "e", "ZFREEENCLOSUREURL")},
            ${textValue(episodeColumns, "e", "ZASSETURL")}
          ) AS audio_url,
          COALESCE(
            ${textValue(episodeColumns, "e", "ZARTWORKTEMPLATEURL")},
            ${textValue(podcastColumns, "p", "ZIMAGEURL")},
            ${textValue(podcastColumns, "p", "ZARTWORKTEMPLATEURL")}
          ) AS image_url,
          ${podcastExternalId} AS podcast_external_id,
          COALESCE(${textValue(podcastColumns, "p", "ZTITLE")}, 'Apple 播客') AS podcast_title,
          COALESCE(
            ${textValue(podcastColumns, "p", "ZAUTHOR")},
            ${textValue(episodeColumns, "e", "ZAUTHOR")},
            ''
          ) AS podcast_author,
          ${feedUrl} AS feed_url,
          ${playhead} AS playhead,
          ${column(episodeColumns, "e", "ZLASTDATEPLAYED")} AS playback_observed_at,
          ${column(episodeColumns, "e", "ZPLAYSTATELASTMODIFIEDDATE")} AS completion_observed_at,
          ${column(episodeColumns, "e", "ZLASTUSERMARKEDASPLAYEDDATE")} AS manual_marked_at,
          ${hasBeenPlayed} AS has_been_played,
          ${playCount} AS play_count,
          ${numberValue(episodeColumns, "e", "ZPLAYSTATE")} AS play_state,
          ${numberValue(episodeColumns, "e", "ZMARKASPLAYED")} AS marked_as_played,
          ${numberValue(episodeColumns, "e", "ZPLAYSTATEMANUALLYSET")} AS play_state_manually_set,
          ${textValue(episodeColumns, "e", "ZMETADATAIDENTIFIER")} AS metadata_identifier,
          ${textValue(episodeColumns, "e", "ZFREETRANSCRIPTIDENTIFIER")} AS transcript_identifier
        FROM ZMTEPISODE e
        LEFT JOIN ZMTPODCAST p ON p.Z_PK=e.ZPODCAST
        WHERE ${listenedCondition}
        ORDER BY e.Z_PK DESC
      `).all();

      return {
        available: true,
        episodes,
        databasePath: this.databasePath,
        sourceCounts: {
          podcasts: Number(sourceCounts.podcast_count || 0),
          episodes: Number(sourceCounts.episode_count || 0),
          listened: episodes.length
        }
      };
    } catch (error) {
      if (/^Mac 播客资料库结构不兼容/.test(error?.message || "")) throw error;
      throw new Error(`读取 Mac 播客资料库失败：${error?.message || error}`);
    } finally {
      db.close();
    }
  }
}

export class IsolatedApplePodcastsClient {
  constructor({
    databasePath = defaultApplePodcastsDatabasePath(),
    readTimeoutMs = configuredReadTimeoutMs(),
    nodePath = process.execPath,
    workerPath = defaultWorkerPath,
    execFileFn = execFile
  } = {}) {
    this.databasePath = databasePath;
    this.readTimeoutMs = readTimeoutMs;
    this.nodePath = nodePath;
    this.workerPath = workerPath;
    this.execFileFn = execFileFn;
    this.activeChildren = new Set();
    this.activeOperations = new Set();
  }

  async getHistory() {
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        let child = null;
        let timer = null;
        let operation = null;
        let settled = false;

        const settle = (action, value) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (operation) this.activeOperations.delete(operation);
          action(value);
        };
        const callback = (error, stdout, stderr) => {
          if (child) this.activeChildren.delete(child);
          if (error) {
            if (stderr && !error.stderr) error.stderr = stderr;
            settle(reject, error);
            return;
          }
          settle(resolve, { stdout, stderr });
        };

        try {
          child = this.execFileFn(
            this.nodePath,
            [this.workerPath, this.databasePath],
            {
              encoding: "utf8",
              killSignal: "SIGKILL",
              maxBuffer: MAX_WORKER_OUTPUT_BYTES
            },
            callback
          );
        } catch (error) {
          settle(reject, error);
          return;
        }
        if (settled) return;
        if (!child || typeof child.kill !== "function") {
          const error = new Error("Apple Podcasts 读取进程没有返回可终止的子进程");
          error.code = "APPLE_PODCASTS_PROTOCOL_ERROR";
          settle(reject, error);
          return;
        }

        this.activeChildren.add(child);
        child.once?.("close", () => this.activeChildren.delete(child));
        operation = {
          cancel: () => {
            const error = new Error("Apple Podcasts 读取已取消");
            error.code = "APPLE_PODCASTS_READ_CANCELLED";
            settle(reject, error);
            child.kill("SIGKILL");
          }
        };
        this.activeOperations.add(operation);
        timer = setTimeout(() => {
          const error = new Error("Apple Podcasts 读取进程超时");
          error.code = "APPLE_PODCASTS_READ_TIMEOUT";
          settle(reject, error);
          child.kill("SIGKILL");
        }, this.readTimeoutMs);
      });
    } catch (error) {
      if (error?.code === "APPLE_PODCASTS_READ_TIMEOUT") {
        throw new Error(
          `Mac 播客资料库读取超过 ${Math.ceil(this.readTimeoutMs / 1000)} 秒；` +
          "请在 macOS 弹窗“node 想访问其他 App 的数据”中点“允许”，回声会稍后自动重试"
        );
      }
      if (error?.code === "APPLE_PODCASTS_READ_CANCELLED") {
        throw new Error("Mac 播客资料库读取已取消");
      }
      const detail = String(error?.stderr || error?.message || error).trim();
      throw new Error(detail || "Mac 播客资料库读取进程失败");
    }

    try {
      const payload = JSON.parse(result.stdout);
      if (typeof payload?.available !== "boolean" || !Array.isArray(payload?.episodes)) {
        throw new Error("返回结构不完整");
      }
      return payload;
    } catch (error) {
      throw new Error(`Mac 播客资料库读取结果无效：${error?.message || error}`);
    }
  }

  cancelActive() {
    for (const operation of [...this.activeOperations]) operation.cancel();
    for (const child of [...this.activeChildren]) child.kill("SIGKILL");
  }
}
