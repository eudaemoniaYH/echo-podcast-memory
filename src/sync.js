import { IsolatedApplePodcastsClient } from "./connectors/apple-podcasts.js";
import { GcoresClient } from "./connectors/gcores.js";
import { XiaoyuzhouClient } from "./connectors/xiaoyuzhou.js";
import {
  normalizeApplePodcastsEpisode,
  normalizeGcoresRadio,
  normalizeProgress,
  normalizeTimestamp,
  normalizeXiaoyuzhouEpisode
} from "./normalize.js";

const monthSequence = (count) => {
  const result = [];
  const date = new Date();
  date.setUTCDate(1);
  for (let index = 0; index < count; index += 1) {
    result.push({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 });
    date.setUTCMonth(date.getUTCMonth() - 1);
  }
  return result;
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const incrementalXiaoyuzhouHistoryPages = () => {
  const configured = Number(process.env.XIAOYUZHOU_INCREMENTAL_HISTORY_PAGES);
  if (!Number.isSafeInteger(configured) || configured < 1) return 3;
  return Math.min(configured, 200);
};

export class SyncService {
  constructor({
    db,
    credentials,
    fetchFn = fetch,
    applePodcastsClient = null,
    automaticSummariesEnabled = false
  }) {
    this.db = db;
    this.credentials = credentials;
    this.fetchFn = fetchFn;
    this.applePodcastsClient = applePodcastsClient || new IsolatedApplePodcastsClient();
    this.automaticSummariesEnabled = automaticSummariesEnabled;
    this.running = new Set();
  }

  cancelActive() {
    this.applePodcastsClient.cancelActive?.();
  }

  async sync(platform) {
    if (this.running.has(platform)) return { skipped: true, reason: "already-running" };
    this.running.add(platform);
    const runId = this.db.startSync(platform);
    try {
      let result;
      if (platform === "apple-podcasts") {
        result = await this.syncApplePodcasts();
      } else if (platform === "xiaoyuzhou" || platform === "gcores") {
        const stored = await this.credentials.get(platform);
        if (!stored) throw new Error("尚未绑定账号");
        result = platform === "xiaoyuzhou"
          ? await this.syncXiaoyuzhou(stored)
          : await this.syncGcores(stored);
      } else {
        throw new Error(`不支持的播客平台：${platform}`);
      }
      const stamp = new Date().toISOString();
      this.db.setAccount(platform, { connected: 1, lastSyncAt: stamp, lastError: null, ...result.account });
      this.db.finishSync(runId, { status: "success", importedCount: result.importedCount });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.setAccount(platform, { lastError: message });
      this.db.finishSync(runId, { status: "failed", error: message });
      throw error;
    } finally {
      this.running.delete(platform);
    }
  }

  async syncApplePodcasts() {
    const history = await this.applePodcastsClient.getHistory();
    if (!history.available) {
      return {
        available: false,
        importedCount: 0,
        automaticSummaryQueuedCount: 0,
        account: {
          connected: 0,
          displayName: "等待打开 Mac 播客"
        }
      };
    }

    const firstCompletionBaseline = !this.db.getMeta("apple_podcasts_completion_baselined_at");
    const completionEnabledAt = [
      this.db.getMeta("apple_podcasts_completion_baselined_at"),
      this.db.getMeta("auto_summary_enabled_at")
    ].filter((value) => value && !Number.isNaN(Date.parse(value)))
      .sort()
      .at(-1) || null;
    if (firstCompletionBaseline) {
      this.db.setMeta("apple_podcasts_completion_baselined_at", new Date().toISOString());
    }

    const normalizedByExternalId = new Map();
    for (const item of history.episodes.map(normalizeApplePodcastsEpisode)) {
      if (!item.episode.externalId ||
          (!item.playback.playbackObservedAt && !item.playback.completionObservedAt)) continue;
      const previous = normalizedByExternalId.get(item.episode.externalId);
      if (!previous || item.playback.observedAt > previous.playback.observedAt) {
        normalizedByExternalId.set(item.episode.externalId, item);
      }
    }
    const normalized = [...normalizedByExternalId.values()];
    const existingEpisodeIds = this.db.episodeIdsByExternalIds(
      "apple-podcasts",
      normalized.map((item) => item.episode.externalId)
    );
    let importedCount = 0;
    let automaticSummaryQueuedCount = 0;
    let visibleHistorySeconds = 0;

    for (const { episode, playback } of normalized) {
      if (!existingEpisodeIds.has(episode.externalId)) importedCount += 1;
      const episodeId = this.db.upsertEpisode(episode);
      if (playback.playbackObservedAt) {
        this.db.addPlaybackSample({
          platform: "apple-podcasts",
          episodeId,
          progressSeconds: playback.progressSeconds,
          observedAt: playback.playbackObservedAt,
          source: "mac-sync-play-position",
          isEstimated: true
        });
      }
      if (playback.completionObservedAt) {
        const completion = this.db.observeEpisodeCompletion({
          episodeId,
          platform: "apple-podcasts",
          completed: playback.completed,
          observedAt: playback.completionObservedAt,
          enabledAt: firstCompletionBaseline ? null : completionEnabledAt,
          automaticSummaryEligible: playback.automaticSummaryEligible,
          queueEnabled: this.automaticSummariesEnabled
        });
        if (completion?.queued) automaticSummaryQueuedCount += 1;
      }
      visibleHistorySeconds += playback.estimatedListenedSeconds;
    }

    if (normalized.length) {
      this.db.upsertListeningTotal({
        platform: "apple-podcasts",
        period: "lifetime",
        listenedSeconds: visibleHistorySeconds,
        isEstimated: true,
        source: "visible-history-progress"
      });
      this.db.clearDemo();
    }

    const sourceHasEpisodes = Number(history.sourceCounts?.episodes || 0) > 0;
    return {
      available: true,
      importedCount,
      automaticSummaryQueuedCount,
      sourceEpisodeCount: normalized.length,
      sourceCounts: history.sourceCounts,
      account: {
        connected: normalized.length || sourceHasEpisodes ? 1 : 0,
        displayName: normalized.length
          ? "Apple 播客"
          : sourceHasEpisodes
            ? "资料库已同步，暂未发现收听记录"
            : "等待在 Mac“播客”开启同步资料库"
      }
    };
  }

  async syncXiaoyuzhou(stored) {
    const client = new XiaoyuzhouClient({
      credentials: stored,
      fetchFn: this.fetchFn,
      onCredentialsChanged: (value) => this.credentials.set("xiaoyuzhou", value)
    });
    const profile = await client.getProfile();
    const all = [];
    let cursor = null;
    let reachedHistoryEnd = false;
    const historyWasBackfilled = Boolean(this.db.getMeta("xiaoyuzhou_history_backfilled_at"));
    const historyPageLimit = historyWasBackfilled ? incrementalXiaoyuzhouHistoryPages() : 200;
    for (let page = 0; page < historyPageLimit; page += 1) {
      const result = await client.getHistory(cursor);
      all.push(...result.episodes);
      cursor = result.cursor;
      if (!cursor) {
        reachedHistoryEnd = true;
        break;
      }
      if (!historyWasBackfilled) await delay(100);
    }
    const episodes = [...new Map(
      all.map(normalizeXiaoyuzhouEpisode).filter((item) => item.externalId).map((item) => [item.externalId, item])
    ).values()];
    const progress = [];
    const episodeIds = episodes.map((item) => item.externalId);
    for (let index = 0; index < episodeIds.length; index += 50) {
      progress.push(...await client.getProgress(episodeIds.slice(index, index + 50)));
      if (!historyWasBackfilled && index + 50 < episodeIds.length) await delay(100);
    }
    const normalizedProgress = progress.map(normalizeProgress).filter((item) => item.episodeId);
    const progressMap = new Map(normalizedProgress.map((item) => [item.episodeId, item]));
    const existingEpisodeIds = this.db.episodeIdsByExternalIds(
      "xiaoyuzhou",
      episodes.map((episode) => episode.externalId)
    );
    let importedCount = 0;
    let automaticSummaryQueuedCount = 0;
    const autoSummaryEnabledAt = this.db.getMeta("auto_summary_enabled_at");
    for (const episode of episodes) {
      if (!existingEpisodeIds.has(episode.externalId)) importedCount += 1;
      const episodeId = this.db.upsertEpisode(episode);
      const sample = progressMap.get(episode.externalId);
      if (sample?.observedAt) {
        this.db.addPlaybackSample({
          platform: "xiaoyuzhou",
          episodeId,
          progressSeconds: sample.progressSeconds,
          observedAt: sample.observedAt,
          source: "platform-progress",
          isEstimated: false
        });
        const completion = this.db.observeEpisodeCompletion({
          episodeId,
          platform: "xiaoyuzhou",
          completed: Boolean(episode.raw?.isFinished),
          observedAt: sample.observedAt,
          enabledAt: autoSummaryEnabledAt,
          queueEnabled: this.automaticSummariesEnabled
        });
        if (completion?.queued) automaticSummaryQueuedCount += 1;
      }
    }
    if (!historyWasBackfilled && reachedHistoryEnd) {
      this.db.setMeta("xiaoyuzhou_history_backfilled_at", new Date().toISOString());
    }
    const firstSync = !this.db.account("xiaoyuzhou")?.last_sync_at;
    if (profile.uid) {
      for (const { year, month } of monthSequence(firstSync ? 6 : 2)) {
        const total = await client.getMonthlyWrapped(profile.uid, year, month);
        this.db.upsertListeningTotal({
          platform: "xiaoyuzhou",
          period: `${year}-${String(month).padStart(2, "0")}`,
          listenedSeconds: Number(total.playedSeconds || 0),
          isEstimated: false,
          source: "monthly-wrapped"
        });
      }
    }
    const mileageLastSynced = this.db.getMeta("xiaoyuzhou_mileage_synced_at");
    const mileageIsStale = !mileageLastSynced || Date.now() - Date.parse(mileageLastSynced) > 24 * 60 * 60 * 1000;
    if (mileageIsStale) {
      let cursor = null;
      let totalSeconds = 0;
      let pages = 0;
      do {
        const page = await client.getMileage(cursor);
        totalSeconds += page.rows.reduce((sum, row) => sum + Number(row.playedSeconds || 0), 0);
        cursor = page.cursor;
        pages += 1;
        if (cursor) await delay(100);
      } while (cursor && pages < 100);
      if (totalSeconds > 0) {
        this.db.upsertListeningTotal({
          platform: "xiaoyuzhou",
          period: "lifetime",
          listenedSeconds: totalSeconds,
          isEstimated: false,
          source: "mileage-total"
        });
        this.db.setMeta("xiaoyuzhou_mileage_synced_at", new Date().toISOString());
      }
    }
    return {
      importedCount,
      automaticSummaryQueuedCount,
      account: {
        externalUserId: profile.uid || null,
        displayName: profile.nickname || profile.nickName || "小宇宙账号"
      }
    };
  }

  async syncGcores(stored) {
    const client = new GcoresClient({ credentials: stored, fetchFn: this.fetchFn });
    const history = await client.getHistory();
    const radioHistory = history.filter((item) =>
      (item.type === "radios" || !item.type) && item.id !== undefined && item.id !== null && String(item.id)
    );
    const ids = [...new Set(radioHistory.map((item) => String(item.id)))];
    const episodeIds = this.db.episodeIdsByExternalIds("gcores", ids);
    const missingIds = ids.filter((id) => !episodeIds.has(id));
    const radios = [];
    for (let index = 0; index < missingIds.length; index += 20) {
      radios.push(...await client.getRadios(missingIds.slice(index, index + 20)));
    }
    const radioMap = new Map(radios.map((item) => [String(item.id), item]));
    const historyMap = new Map(radioHistory.map((item) => [String(item.id), item]));
    for (const id of missingIds) {
      const item = historyMap.get(id) || { id };
      const raw = radioMap.get(id) || { id };
      episodeIds.set(id, this.db.upsertEpisode(normalizeGcoresRadio(raw, item)));
    }
    const samples = radioHistory.map((item) => ({
      item,
      episodeId: episodeIds.get(String(item.id)),
      observedAt: normalizeTimestamp(item.timestamp)
    })).filter((sample) => sample.episodeId && sample.observedAt)
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
    let automaticSummaryQueuedCount = 0;
    const autoSummaryEnabledAt = this.db.getMeta("auto_summary_enabled_at");
    for (const { item, episodeId, observedAt } of samples) {
      const progressSeconds = Math.max(0, Math.round(Number(item.progress || 0)));
      this.db.addPlaybackSample({
        platform: "gcores",
        episodeId,
        progressSeconds,
        observedAt,
        source: "history-progress-delta",
        isEstimated: true
      });
      const durationSeconds = this.db.episodeDuration(episodeId);
      const completed = progressSeconds > 0 && durationSeconds > 0 && (
        progressSeconds / durationSeconds >= 0.98 || durationSeconds - progressSeconds <= 60
      );
      const completion = this.db.observeEpisodeCompletion({
        episodeId,
        platform: "gcores",
        completed,
        observedAt,
        enabledAt: autoSummaryEnabledAt,
        queueEnabled: this.automaticSummariesEnabled
      });
      if (completion?.queued) automaticSummaryQueuedCount += 1;
    }
    this.db.upsertListeningTotal({
      platform: "gcores",
      period: "lifetime",
      listenedSeconds: this.db.visibleProgressTotal("gcores"),
      isEstimated: true,
      source: "visible-history-progress"
    });
    return {
      importedCount: missingIds.length,
      automaticSummaryQueuedCount,
      account: { displayName: "机核账号" }
    };
  }
}
