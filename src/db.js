import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value ?? {});

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const secureRegularFile = (path) => {
  if (!existsSync(path) || !lstatSync(path).isFile()) return;
  chmodSync(path, PRIVATE_FILE_MODE);
};

const secureBackupTree = (path) => {
  if (!existsSync(path)) return;
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isFile()) {
    chmodSync(path, PRIVATE_FILE_MODE);
    return;
  }
  if (!metadata.isDirectory()) return;
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
  for (const entry of readdirSync(path)) secureBackupTree(join(path, entry));
};

const secureDatabaseStorage = (path, { createDatabase = false } = {}) => {
  const dataDirectory = dirname(path);
  mkdirSync(dataDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(dataDirectory, PRIVATE_DIRECTORY_MODE);
  if (createDatabase && !existsSync(path)) {
    const descriptor = openSync(path, "a", PRIVATE_FILE_MODE);
    closeSync(descriptor);
  }
  for (const privatePath of [path, `${path}-wal`, `${path}-shm`]) secureRegularFile(privatePath);
  secureBackupTree(join(dataDirectory, "backups"));
};

export class PodcastDatabase {
  constructor(path) {
    this.path = path;
    this.isInMemory = path === ":memory:";
    if (!this.isInMemory) secureDatabaseStorage(path, { createDatabase: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
    if (!this.isInMemory) secureDatabaseStorage(path);
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS accounts (
        platform TEXT PRIMARY KEY,
        connected INTEGER NOT NULL DEFAULT 0,
        display_name TEXT,
        external_user_id TEXT,
        last_sync_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS podcasts (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        image_url TEXT,
        is_demo INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(platform, external_id)
      );
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        public_id TEXT,
        platform TEXT NOT NULL,
        external_id TEXT NOT NULL,
        podcast_id TEXT NOT NULL REFERENCES podcasts(id),
        title TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        published_at TEXT,
        description TEXT,
        audio_url TEXT,
        image_url TEXT,
        topic TEXT NOT NULL DEFAULT '其他',
        is_demo INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(platform, external_id)
      );
      CREATE TABLE IF NOT EXISTS playback_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        episode_id TEXT NOT NULL REFERENCES episodes(id),
        progress_seconds INTEGER NOT NULL,
        observed_at TEXT NOT NULL,
        delta_seconds INTEGER NOT NULL DEFAULT 0,
        is_estimated INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        is_demo INTEGER NOT NULL DEFAULT 0,
        UNIQUE(platform, episode_id, observed_at)
      );
      CREATE TABLE IF NOT EXISTS listening_totals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        period TEXT NOT NULL,
        listened_seconds INTEGER NOT NULL,
        is_estimated INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        is_demo INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        UNIQUE(platform, period, source)
      );
      CREATE TABLE IF NOT EXISTS summaries (
        episode_id TEXT PRIMARY KEY REFERENCES episodes(id),
        summary TEXT NOT NULL,
        key_points_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcripts (
        episode_id TEXT PRIMARY KEY REFERENCES episodes(id),
        transcript TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS summary_jobs (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL REFERENCES episodes(id),
        mode TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL,
        completed_steps INTEGER NOT NULL DEFAULT 0,
        total_steps INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS episode_completion_state (
        episode_id TEXT PRIMARY KEY REFERENCES episodes(id),
        platform TEXT NOT NULL,
        is_completed INTEGER NOT NULL DEFAULT 0,
        automatic_summary_eligible INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT,
        observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auto_summary_queue (
        episode_id TEXT PRIMARY KEY REFERENCES episodes(id),
        platform TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        job_id TEXT REFERENCES summary_jobs(id),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        imported_count INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_samples_episode_time ON playback_samples(episode_id, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_episodes_published ON episodes(published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_summary_jobs_episode ON summary_jobs(episode_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_auto_summary_status ON auto_summary_queue(status, completed_at);
    `);
    const summaryColumns = new Set(this.db.prepare(`PRAGMA table_info(summaries)`).all().map((column) => column.name));
    const summaryMigrations = [
      ["category", "TEXT"],
      ["outline_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["keywords_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["people_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["review_questions_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["limitation", "TEXT NOT NULL DEFAULT ''"],
      ["source_kind", "TEXT NOT NULL DEFAULT 'shownotes'"],
      ["model", "TEXT"],
      ["updated_at", "TEXT"]
    ];
    for (const [name, definition] of summaryMigrations) {
      if (!summaryColumns.has(name)) this.db.exec(`ALTER TABLE summaries ADD COLUMN ${name} ${definition}`);
    }
    const jobColumns = new Set(this.db.prepare(`PRAGMA table_info(summary_jobs)`).all().map((column) => column.name));
    if (!jobColumns.has("origin")) this.db.exec(`ALTER TABLE summary_jobs ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'`);
    const episodeColumns = new Set(this.db.prepare(`PRAGMA table_info(episodes)`).all().map((column) => column.name));
    if (!episodeColumns.has("public_id")) this.db.exec(`ALTER TABLE episodes ADD COLUMN public_id TEXT`);
    const missingPublicIds = this.db.prepare(`SELECT id FROM episodes WHERE public_id IS NULL OR public_id=''`).all();
    const assignPublicId = this.db.prepare(`UPDATE episodes SET public_id=? WHERE id=?`);
    for (const row of missingPublicIds) assignPublicId.run(`ep_${randomUUID()}`, row.id);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_public_id ON episodes(public_id)`);
    const completionColumns = new Set(this.db.prepare(`PRAGMA table_info(episode_completion_state)`).all().map((column) => column.name));
    if (!completionColumns.has("automatic_summary_eligible")) {
      this.db.exec(`ALTER TABLE episode_completion_state ADD COLUMN automatic_summary_eligible INTEGER NOT NULL DEFAULT 0`);
      this.db.exec(`UPDATE episode_completion_state SET automatic_summary_eligible=is_completed`);
    }
    // Older Apple connector versions retained feed/enclosure URLs and raw
    // metadata. Private podcast URLs can contain bearer credentials, so scrub
    // them eagerly instead of waiting for each episode to be synchronized.
    this.db.exec(`
      UPDATE episodes
      SET audio_url=NULL, image_url=NULL, metadata_json='{"source":"mac-podcasts-library"}'
      WHERE platform='apple-podcasts';
      UPDATE podcasts
      SET image_url=NULL, metadata_json='{}'
      WHERE platform='apple-podcasts';
    `);
    this.db.prepare(`
      UPDATE summary_jobs SET status='failed', error='服务重启后任务已停止', updated_at=?
      WHERE status IN ('queued', 'running')
    `).run(now());
    this.db.prepare(`
      UPDATE auto_summary_queue SET status='completed', last_error=NULL, updated_at=?
      WHERE episode_id IN (SELECT episode_id FROM summaries)
    `).run(now());
    this.db.prepare(`
      UPDATE auto_summary_queue SET status='pending', job_id=NULL,
        last_error='服务重启后自动任务将重新排队', updated_at=?
      WHERE status='running' AND attempts < 3
        AND episode_id NOT IN (SELECT episode_id FROM summaries)
    `).run(now());
    for (const platform of ["xiaoyuzhou", "gcores", "apple-podcasts"]) {
      this.db.prepare(`INSERT OR IGNORE INTO accounts(platform, updated_at) VALUES (?, ?)`).run(platform, now());
    }
  }

  close() {
    if (!this.isInMemory) secureDatabaseStorage(this.path);
    this.db.close();
    if (!this.isInMemory) secureDatabaseStorage(this.path);
  }

  setMeta(key, value) {
    this.db.prepare(`INSERT INTO app_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
  }

  getMeta(key) {
    return this.db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key)?.value ?? null;
  }

  setAccount(platform, patch) {
    const current = this.db.prepare(`SELECT * FROM accounts WHERE platform = ?`).get(platform) || {};
    this.db.prepare(`
      INSERT INTO accounts(platform, connected, display_name, external_user_id, last_sync_at, last_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform) DO UPDATE SET
        connected=excluded.connected, display_name=excluded.display_name,
        external_user_id=excluded.external_user_id, last_sync_at=excluded.last_sync_at,
        last_error=excluded.last_error, updated_at=excluded.updated_at
    `).run(
      platform,
      patch.connected ?? current.connected ?? 0,
      patch.displayName ?? current.display_name ?? null,
      patch.externalUserId ?? current.external_user_id ?? null,
      patch.lastSyncAt ?? current.last_sync_at ?? null,
      patch.lastError !== undefined ? patch.lastError : current.last_error ?? null,
      now()
    );
  }

  account(platform) {
    return this.db.prepare(`SELECT * FROM accounts WHERE platform = ?`).get(platform);
  }

  episodeIdsByExternalIds(platform, externalIds) {
    const ids = [...new Set((externalIds || []).map((value) => String(value)).filter(Boolean))];
    const result = new Map();
    // Keep each query comfortably below SQLite's bound-parameter limit. This
    // also covers the one-time Xiaoyuzhou backfill, which can contain thousands
    // of episodes.
    for (let index = 0; index < ids.length; index += 500) {
      const chunk = ids.slice(index, index + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db.prepare(`
        SELECT external_id, id FROM episodes
        WHERE platform = ? AND external_id IN (${placeholders})
      `).all(platform, ...chunk);
      for (const row of rows) result.set(String(row.external_id), row.id);
    }
    return result;
  }

  upsertEpisode(episode, { isDemo = false } = {}) {
    const podcastId = `${episode.platform}:podcast:${episode.podcast.externalId}`;
    const episodeId = `${episode.platform}:episode:${episode.externalId}`;
    this.db.prepare(`
      INSERT INTO podcasts(id, platform, external_id, title, author, image_url, is_demo, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title=CASE WHEN TRIM(excluded.title)='' THEN podcasts.title ELSE excluded.title END,
        author=CASE WHEN TRIM(COALESCE(excluded.author,''))='' THEN podcasts.author ELSE excluded.author END,
        image_url=CASE WHEN excluded.platform='apple-podcasts' THEN NULL ELSE COALESCE(excluded.image_url, podcasts.image_url) END,
        metadata_json=excluded.metadata_json
    `).run(podcastId, episode.platform, episode.podcast.externalId, episode.podcast.title,
      episode.podcast.author ?? null, episode.imageUrl ?? null, Number(isDemo), json(episode.podcast));
    this.db.prepare(`
      INSERT INTO episodes(id, public_id, platform, external_id, podcast_id, title, duration_seconds, published_at,
        description, audio_url, image_url, topic, is_demo, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title=CASE WHEN TRIM(excluded.title)='' THEN episodes.title ELSE excluded.title END,
        duration_seconds=CASE WHEN excluded.duration_seconds>0 THEN excluded.duration_seconds ELSE episodes.duration_seconds END,
        published_at=COALESCE(excluded.published_at, episodes.published_at),
        description=CASE WHEN TRIM(COALESCE(excluded.description,''))='' THEN episodes.description ELSE excluded.description END,
        audio_url=CASE WHEN excluded.platform='apple-podcasts' THEN NULL ELSE COALESCE(excluded.audio_url, episodes.audio_url) END,
        image_url=CASE WHEN excluded.platform='apple-podcasts' THEN NULL ELSE COALESCE(excluded.image_url, episodes.image_url) END,
        topic=excluded.topic, metadata_json=excluded.metadata_json
    `).run(episodeId, `ep_${randomUUID()}`, episode.platform, episode.externalId, podcastId, episode.title,
      episode.durationSeconds, episode.publishedAt ?? null, episode.description ?? "", episode.audioUrl ?? null,
      episode.imageUrl ?? null, episode.topic, Number(isDemo), json(episode.raw));
    return episodeId;
  }

  addPlaybackSample({ platform, episodeId, progressSeconds, observedAt, source, isEstimated, isDemo = false }) {
    const previous = this.db.prepare(`
      SELECT progress_seconds, observed_at FROM playback_samples
      WHERE platform = ? AND episode_id = ? ORDER BY observed_at DESC LIMIT 1
    `).get(platform, episodeId);
    let delta = 0;
    if (previous && progressSeconds > previous.progress_seconds && observedAt > previous.observed_at) {
      const candidate = progressSeconds - previous.progress_seconds;
      const wallClock = Math.max(0, (Date.parse(observedAt) - Date.parse(previous.observed_at)) / 1000);
      delta = Math.round(Math.min(candidate, wallClock, 7200));
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO playback_samples(platform, episode_id, progress_seconds, observed_at,
        delta_seconds, is_estimated, source, is_demo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(platform, episodeId, progressSeconds, observedAt, delta, Number(isEstimated), source, Number(isDemo));
    return delta;
  }

  upsertListeningTotal({ platform, period, listenedSeconds, isEstimated, source, isDemo = false }) {
    this.db.prepare(`
      INSERT INTO listening_totals(platform, period, listened_seconds, is_estimated, source, is_demo, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, period, source) DO UPDATE SET listened_seconds=excluded.listened_seconds,
        is_estimated=excluded.is_estimated, is_demo=excluded.is_demo, updated_at=excluded.updated_at
    `).run(platform, period, listenedSeconds, Number(isEstimated), source, Number(isDemo), now());
  }

  listeningTotal(platform, period, source) {
    return this.db.prepare(`
      SELECT * FROM listening_totals WHERE platform=? AND period=? AND source=?
    `).get(platform, period, source) || null;
  }

  addSummary(episodeId, summary, keyPoints = []) {
    this.db.prepare(`
      INSERT INTO summaries(episode_id, summary, key_points_json, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(episode_id) DO UPDATE SET summary=excluded.summary, key_points_json=excluded.key_points_json,
        created_at=excluded.created_at
    `).run(episodeId, summary, json(keyPoints), now());
  }

  saveGeneratedSummary(episodeId, value) {
    const stamp = now();
    this.db.prepare(`
      INSERT INTO summaries(episode_id, summary, key_points_json, created_at, category, outline_json,
        keywords_json, people_json, review_questions_json, limitation, source_kind, model, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(episode_id) DO UPDATE SET summary=excluded.summary,
        key_points_json=excluded.key_points_json, category=excluded.category,
        outline_json=excluded.outline_json, keywords_json=excluded.keywords_json,
        people_json=excluded.people_json, review_questions_json=excluded.review_questions_json,
        limitation=excluded.limitation, source_kind=excluded.source_kind,
        model=excluded.model, updated_at=excluded.updated_at
    `).run(
      episodeId, value.summary, json(value.key_points), stamp, value.category,
      json(value.outline), json(value.keywords), json(value.people), json(value.review_questions),
      value.limitation || "", value.sourceKind, value.model || null, stamp
    );
  }

  saveTranscript(episodeId, { text, sourceKind = "audio", model = null }) {
    const stamp = now();
    this.db.prepare(`
      INSERT INTO transcripts(episode_id, transcript, source_kind, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(episode_id) DO UPDATE SET transcript=excluded.transcript,
        source_kind=excluded.source_kind, model=excluded.model, updated_at=excluded.updated_at
    `).run(episodeId, text, sourceKind, model, stamp, stamp);
  }

  transcript(episodeId) {
    return this.db.prepare(`SELECT * FROM transcripts WHERE episode_id=?`).get(episodeId) || null;
  }

  createSummaryJob({ id, episodeId, mode, origin = "manual" }) {
    const stamp = now();
    this.db.prepare(`
      INSERT INTO summary_jobs(id, episode_id, mode, origin, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?)
    `).run(id, episodeId, mode, origin, stamp, stamp);
    return this.summaryJob(id);
  }

  updateSummaryJob(id, patch) {
    const current = this.summaryJob(id);
    if (!current) return null;
    this.db.prepare(`
      UPDATE summary_jobs SET status=?, completed_steps=?, total_steps=?, error=?, updated_at=? WHERE id=?
    `).run(
      patch.status ?? current.status,
      patch.completedSteps ?? current.completed_steps,
      patch.totalSteps ?? current.total_steps,
      patch.error !== undefined ? patch.error : current.error,
      now(), id
    );
    return this.summaryJob(id);
  }

  summaryJob(id) {
    return this.db.prepare(`SELECT * FROM summary_jobs WHERE id=?`).get(id) || null;
  }

  latestSummaryJob(episodeId) {
    return this.db.prepare(`SELECT * FROM summary_jobs WHERE episode_id=? ORDER BY updated_at DESC LIMIT 1`).get(episodeId) || null;
  }

  episodeDuration(episodeId) {
    return Number(this.db.prepare(`SELECT duration_seconds FROM episodes WHERE id=?`).get(episodeId)?.duration_seconds || 0);
  }

  observeEpisodeCompletion({
    episodeId,
    platform,
    completed,
    observedAt,
    enabledAt,
    automaticSummaryEligible = true,
    queueEnabled = true
  }) {
    if (!episodeId || !observedAt || Number.isNaN(Date.parse(observedAt))) return { queued: false, transition: false };
    const previous = this.db.prepare(`SELECT * FROM episode_completion_state WHERE episode_id=?`).get(episodeId) || null;
    if (previous && observedAt < previous.observed_at) return { queued: false, transition: false };
    const isCompleted = Boolean(completed);
    const transition = isCompleted && !Boolean(previous?.is_completed);
    const eligible = isCompleted && Boolean(automaticSummaryEligible);
    const eligibleTransition = eligible && !Boolean(previous?.automatic_summary_eligible);
    const stamp = now();
    this.db.prepare(`
      INSERT INTO episode_completion_state(
        episode_id, platform, is_completed, automatic_summary_eligible, completed_at, observed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(episode_id) DO UPDATE SET
        platform=excluded.platform, is_completed=excluded.is_completed,
        automatic_summary_eligible=excluded.automatic_summary_eligible,
        completed_at=CASE WHEN excluded.is_completed=1 THEN excluded.completed_at ELSE episode_completion_state.completed_at END,
        observed_at=excluded.observed_at, updated_at=excluded.updated_at
    `).run(episodeId, platform, Number(isCompleted), Number(eligible), isCompleted ? observedAt : null, observedAt, stamp);

    const afterEnablement = enabledAt && !Number.isNaN(Date.parse(enabledAt)) && observedAt > enabledAt;
    if (!queueEnabled || !eligibleTransition || !afterEnablement) {
      return { queued: false, transition };
    }
    const episode = this.db.prepare(`SELECT is_demo FROM episodes WHERE id=?`).get(episodeId);
    const hasSummary = this.db.prepare(`SELECT 1 AS found FROM summaries WHERE episode_id=?`).get(episodeId);
    if (!episode || episode.is_demo || hasSummary) return { queued: false, transition };
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO auto_summary_queue(
        episode_id, platform, completed_at, status, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', 0, ?, ?)
    `).run(episodeId, platform, observedAt, stamp, stamp);
    return { queued: Number(result.changes || 0) > 0, transition };
  }

  nextAutomaticSummary() {
    this.db.prepare(`
      UPDATE auto_summary_queue SET status='completed', last_error=NULL, updated_at=?
      WHERE status IN ('pending', 'running') AND episode_id IN (SELECT episode_id FROM summaries)
    `).run(now());
    return this.db.prepare(`
      SELECT q.*, e.title, e.description
      FROM auto_summary_queue q JOIN episodes e ON e.id=q.episode_id
      WHERE q.status='pending' AND q.attempts < 3
        AND e.is_demo=0
        AND q.episode_id NOT IN (SELECT episode_id FROM summaries)
      ORDER BY q.completed_at, q.created_at LIMIT 1
    `).get() || null;
  }

  claimAutomaticSummary(episodeId, jobId) {
    const result = this.db.prepare(`
      UPDATE auto_summary_queue SET status='running', attempts=attempts+1,
        job_id=?, last_error=NULL, updated_at=?
      WHERE episode_id=? AND status='pending' AND attempts < 3
    `).run(jobId, now(), episodeId);
    return Number(result.changes || 0) > 0;
  }

  finishAutomaticSummary(episodeId, { success, error = null }) {
    this.db.prepare(`
      UPDATE auto_summary_queue SET status=?, last_error=?, updated_at=? WHERE episode_id=?
    `).run(success ? "completed" : "failed", success ? null : String(error || "自动快速回顾失败").slice(0, 2000), now(), episodeId);
  }

  automaticSummaryStats() {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM auto_summary_queue GROUP BY status
    `).all();
    const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    const last = this.db.prepare(`
      SELECT e.public_id AS episode_id, q.platform, q.completed_at, q.status, q.last_error, q.updated_at
      FROM auto_summary_queue q JOIN episodes e ON e.id=q.episode_id
      ORDER BY q.updated_at DESC LIMIT 1
    `).get() || null;
    return {
      pending: counts.pending || 0,
      running: counts.running || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      last
    };
  }

  parseEpisodeRow(row) {
    if (!row) return null;
    return {
      ...row,
      keyPoints: JSON.parse(row.key_points_json || "[]"),
      outline: JSON.parse(row.outline_json || "[]"),
      keywords: JSON.parse(row.keywords_json || "[]"),
      people: JSON.parse(row.people_json || "[]"),
      reviewQuestions: JSON.parse(row.review_questions_json || "[]")
    };
  }

  episodeDetail(id) {
    const row = this.db.prepare(`
      WITH ranked_samples AS (
        SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.episode_id ORDER BY s.observed_at DESC, s.id DESC) AS sample_rank
        FROM playback_samples s
      )
      SELECT e.*, p.title AS podcast_title, p.author AS podcast_author,
        s.progress_seconds, s.observed_at,
        COALESCE(cs.is_completed, 0) AS is_completed,
        sm.summary, sm.key_points_json, sm.category AS ai_category, sm.outline_json,
        sm.keywords_json, sm.people_json, sm.review_questions_json, sm.limitation,
        sm.source_kind AS summary_source_kind, sm.model AS summary_model, sm.updated_at AS summary_updated_at,
        CASE WHEN tr.episode_id IS NULL THEN 0 ELSE 1 END AS has_transcript
      FROM episodes e JOIN podcasts p ON p.id=e.podcast_id
      LEFT JOIN ranked_samples s ON s.episode_id=e.id AND s.sample_rank=1
      LEFT JOIN episode_completion_state cs ON cs.episode_id=e.id
      LEFT JOIN summaries sm ON sm.episode_id=e.id
      LEFT JOIN transcripts tr ON tr.episode_id=e.id
      WHERE e.id=?
    `).get(id);
    const result = this.parseEpisodeRow(row);
    if (result) result.job = this.latestSummaryJob(id);
    return result;
  }

  episodeInternalId(publicId) {
    return this.db.prepare(`SELECT id FROM episodes WHERE public_id=?`).get(publicId)?.id || null;
  }

  listEpisodes({ query = "", topic = "", platform = "", summarizedOnly = false, limit = 50, offset = 0 } = {}) {
    const conditions = [];
    const parameters = [];
    if (query) {
      conditions.push(`(e.title LIKE ? OR p.title LIKE ? OR e.description LIKE ? OR sm.summary LIKE ?)`);
      const pattern = `%${query}%`;
      parameters.push(pattern, pattern, pattern, pattern);
    }
    if (topic) { conditions.push(`COALESCE(sm.category, e.topic)=?`); parameters.push(topic); }
    if (platform) { conditions.push(`e.platform=?`); parameters.push(platform); }
    if (summarizedOnly) conditions.push(`sm.episode_id IS NOT NULL`);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      WITH ranked_samples AS (
        SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.episode_id ORDER BY s.observed_at DESC, s.id DESC) AS sample_rank
        FROM playback_samples s
      )
      SELECT e.public_id AS id, e.title, e.platform, e.topic, e.duration_seconds, e.published_at,
        p.title AS podcast_title, s.progress_seconds, s.observed_at,
        COALESCE(cs.is_completed, 0) AS is_completed,
        sm.summary, sm.key_points_json, sm.category AS ai_category, sm.outline_json,
        sm.keywords_json, sm.people_json, sm.review_questions_json, sm.limitation,
        sm.source_kind AS summary_source_kind, sm.updated_at AS summary_updated_at
      FROM episodes e JOIN podcasts p ON p.id=e.podcast_id
      LEFT JOIN ranked_samples s ON s.episode_id=e.id AND s.sample_rank=1
      LEFT JOIN episode_completion_state cs ON cs.episode_id=e.id
      LEFT JOIN summaries sm ON sm.episode_id=e.id
      ${where}
      ORDER BY (s.observed_at IS NOT NULL) DESC, s.observed_at DESC, e.published_at DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, Math.min(Math.max(Number(limit) || 50, 1), 100), Math.max(Number(offset) || 0, 0));
    return rows.map((row) => this.parseEpisodeRow(row));
  }

  startSync(platform) {
    return this.db.prepare(`INSERT INTO sync_runs(platform, started_at, status) VALUES (?, ?, 'running')`).run(platform, now()).lastInsertRowid;
  }

  finishSync(id, { status, importedCount = 0, error = null }) {
    this.db.prepare(`UPDATE sync_runs SET finished_at=?, status=?, imported_count=?, error=? WHERE id=?`)
      .run(now(), status, importedCount, error, id);
  }

  clearDemo() {
    this.db.exec(`
      DELETE FROM auto_summary_queue WHERE episode_id IN (SELECT id FROM episodes WHERE is_demo = 1);
      DELETE FROM episode_completion_state WHERE episode_id IN (SELECT id FROM episodes WHERE is_demo = 1);
      DELETE FROM summary_jobs WHERE episode_id IN (SELECT id FROM episodes WHERE is_demo = 1);
      DELETE FROM transcripts WHERE episode_id IN (SELECT id FROM episodes WHERE is_demo = 1);
      DELETE FROM summaries WHERE episode_id IN (SELECT id FROM episodes WHERE is_demo = 1);
      DELETE FROM playback_samples WHERE is_demo = 1;
      DELETE FROM listening_totals WHERE is_demo = 1;
      DELETE FROM episodes WHERE is_demo = 1;
      DELETE FROM podcasts WHERE is_demo = 1;
    `);
    this.setMeta("demo_mode", "0");
  }

  visibleProgressTotal(platform) {
    return Number(this.db.prepare(`
      SELECT COALESCE(SUM(progress_seconds), 0) AS seconds FROM (
        SELECT episode_id, MAX(progress_seconds) AS progress_seconds
        FROM playback_samples WHERE platform = ? GROUP BY episode_id
      )
    `).get(platform).seconds);
  }

  dashboard() {
    const accounts = this.db.prepare(`SELECT platform, connected, display_name, last_sync_at, last_error FROM accounts ORDER BY platform DESC`).all();
    const totals = this.db.prepare(`SELECT platform, period, listened_seconds, is_estimated, updated_at FROM listening_totals ORDER BY updated_at DESC`).all();
    const lifetimeByPlatform = new Map();
    for (const row of totals) {
      if (row.period === "lifetime" && !lifetimeByPlatform.has(row.platform)) lifetimeByPlatform.set(row.platform, row);
    }
    let exact = 0;
    let estimated = 0;
    const monthlyFallback = new Map();
    for (const row of totals) {
      if (row.period === "lifetime" || lifetimeByPlatform.has(row.platform)) continue;
      const current = monthlyFallback.get(row.platform) || { exact: 0, estimated: 0 };
      current[row.is_estimated ? "estimated" : "exact"] += Number(row.listened_seconds);
      monthlyFallback.set(row.platform, current);
    }
    for (const row of lifetimeByPlatform.values()) {
      if (row.is_estimated) estimated += Number(row.listened_seconds);
      else exact += Number(row.listened_seconds);
    }
    for (const fallback of monthlyFallback.values()) {
      exact += fallback.exact;
      estimated += fallback.estimated;
    }
    const deltaRows = this.db.prepare(`SELECT platform, COALESCE(SUM(delta_seconds), 0) AS seconds FROM playback_samples WHERE is_estimated = 1 GROUP BY platform`).all();
    for (const row of deltaRows) {
      if (!lifetimeByPlatform.has(row.platform)) estimated += Number(row.seconds);
    }
    const recent = this.db.prepare(`
      WITH ranked_samples AS (
        SELECT s.*,
          ROW_NUMBER() OVER (PARTITION BY s.episode_id ORDER BY s.observed_at DESC, s.id DESC) AS sample_rank
        FROM playback_samples s
      )
      SELECT e.public_id AS id, e.title, e.platform, e.topic, e.duration_seconds, e.published_at, p.title AS podcast_title,
        s.progress_seconds, s.observed_at, COALESCE(cs.is_completed, 0) AS is_completed,
        sm.summary, sm.key_points_json, sm.category AS ai_category
      FROM ranked_samples s
      JOIN episodes e ON e.id=s.episode_id
      JOIN podcasts p ON p.id=e.podcast_id
      LEFT JOIN summaries sm ON sm.episode_id=e.id
      LEFT JOIN episode_completion_state cs ON cs.episode_id=e.id
      WHERE s.sample_rank=1
      ORDER BY s.observed_at DESC, s.id DESC LIMIT 12
    `).all().map((row) => ({ ...row, keyPoints: JSON.parse(row.key_points_json || "[]") }));
    const topics = this.db.prepare(`
      SELECT COALESCE(sm.category, e.topic) AS topic, COUNT(*) AS episodes,
        COALESCE(SUM(e.duration_seconds), 0) AS content_seconds
      FROM episodes e LEFT JOIN summaries sm ON sm.episode_id=e.id
      GROUP BY COALESCE(sm.category, e.topic) ORDER BY episodes DESC, topic
    `).all();
    const monthly = this.db.prepare(`
      SELECT period, SUM(listened_seconds) AS seconds,
        MAX(is_estimated) AS has_estimate FROM listening_totals
      WHERE period != 'lifetime'
      GROUP BY period ORDER BY period DESC LIMIT 12
    `).all().reverse();
    const byPlatform = {};
    for (const [platform, row] of lifetimeByPlatform) {
      const value = { exactSeconds: 0, estimatedSeconds: 0 };
      value[row.is_estimated ? "estimatedSeconds" : "exactSeconds"] = Number(row.listened_seconds);
      byPlatform[platform] = value;
    }
    for (const [platform, fallback] of monthlyFallback) {
      if (lifetimeByPlatform.has(platform)) continue;
      byPlatform[platform] = {
        exactSeconds: Number(fallback.exact),
        estimatedSeconds: Number(fallback.estimated)
      };
    }
    for (const row of deltaRows) {
      if (lifetimeByPlatform.has(row.platform)) continue;
      const value = byPlatform[row.platform] || { exactSeconds: 0, estimatedSeconds: 0 };
      value.estimatedSeconds += Number(row.seconds);
      byPlatform[row.platform] = value;
    }
    return {
      demoMode: this.getMeta("demo_mode") === "1",
      accounts,
      stats: {
        exactSeconds: Number(exact),
        estimatedSeconds: Number(estimated),
        byPlatform,
        episodeCount: this.db.prepare(`SELECT COUNT(*) AS count FROM episodes`).get().count,
        podcastCount: this.db.prepare(`SELECT COUNT(*) AS count FROM podcasts`).get().count
      },
      recent,
      topics,
      monthly
    };
  }
}
