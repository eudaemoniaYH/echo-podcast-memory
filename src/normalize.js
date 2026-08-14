const TOPIC_RULES = [
  ["AI 与科技", /\b(ai|llm|gpu|apple|openai|芯片|人工智能|大模型|科技|互联网|机器人)\b/i],
  ["游戏", /(游戏|主机|任天堂|索尼|xbox|steam|game|电竞)/i],
  ["商业与经济", /(商业|公司|创业|投资|金融|经济|市场|消费|品牌)/i],
  ["影视与文化", /(电影|影视|导演|音乐|文学|文化|动漫|艺术)/i],
  ["社会与历史", /(社会|历史|政治|城市|教育|国际|战争|人物)/i],
  ["生活与成长", /(生活|成长|职场|健康|心理|旅行|家庭|关系)/i]
];

const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== "");
const seconds = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  // A podcast episode longer than seven days is implausible; larger values are milliseconds.
  return Math.round(number > 604_800 ? number / 1000 : number);
};

const plainGcoresContent = (value) => {
  if (!value) return "";
  if (typeof value !== "string") return String(value);
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed.blocks)) return parsed.blocks.map((block) => block.text || "").filter(Boolean).join("\n");
  } catch {}
  return value;
};

const clock = (value) => {
  const total = Math.max(0, Math.round(Number(value) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const secondsPart = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secondsPart).padStart(2, "0")}` : `${minutes}:${String(secondsPart).padStart(2, "0")}`;
};

export function classifyTopic(title = "", description = "") {
  const text = `${title} ${description}`;
  return TOPIC_RULES.find(([, rule]) => rule.test(text))?.[0] || "其他";
}

export function normalizeXiaoyuzhouEpisode(raw) {
  const podcast = raw.podcast || raw.pod || {};
  const externalId = String(first(raw.eid, raw.id, raw.episodeId, ""));
  const podcastExternalId = String(first(podcast.pid, podcast.id, raw.pid, "unknown"));
  const published = first(raw.pubDate, raw.publishedAt, raw.createTime);
  const publishedAt = published
    ? new Date(typeof published === "number" && published < 10_000_000_000 ? published * 1000 : published).toISOString()
    : null;
  const description = first(raw.shownotes, raw.description, raw.brief, "");
  return {
    platform: "xiaoyuzhou",
    externalId,
    title: first(raw.title, "未命名单集"),
    durationSeconds: seconds(first(raw.duration, raw.durationSeconds, raw.media?.duration)),
    publishedAt,
    description,
    audioUrl: first(raw.enclosure?.url, raw.media?.source?.url, raw.audioUrl, null),
    imageUrl: first(raw.image?.picUrl, raw.cover?.picUrl, podcast.image?.picUrl, podcast.image, null),
    podcast: {
      externalId: podcastExternalId,
      title: first(podcast.title, podcast.name, raw.podcastTitle, "小宇宙播客"),
      author: first(podcast.author, podcast.host, "")
    },
    topic: classifyTopic(first(raw.title, ""), description),
    raw: { isFinished: Boolean(raw.isFinished) }
  };
}

export function normalizeGcoresRadio(raw, historyItem = {}) {
  const externalId = String(first(raw.id, historyItem.id, ""));
  const body = plainGcoresContent(first(raw.content, raw.description, raw.desc, raw.excerpt, ""));
  const timeline = (raw.timelines || []).map((item) => {
    const text = [item.title, item.content].filter(Boolean).join("：");
    return text ? `[${clock(item.at)}] ${text}` : "";
  }).filter(Boolean).join("\n");
  const description = [body, timeline ? `时间轴\n${timeline}` : ""].filter(Boolean).join("\n\n");
  const published = first(raw["published-at"], raw.publishedAt);
  return {
    platform: "gcores",
    externalId,
    title: first(raw.title, `机核节目 ${externalId}`),
    durationSeconds: seconds(first(raw.duration, raw["hosted-media-duration"])),
    publishedAt: published ? new Date(published).toISOString() : null,
    description,
    audioUrl: first(raw.audioUrl, null),
    imageUrl: first(raw.cover, raw.thumb, null),
    podcast: {
      externalId: "gcores-radio",
      title: "机核电台",
      author: first(raw.category, "机核")
    },
    topic: classifyTopic(first(raw.title, ""), description),
    raw: { mediaType: raw.mediaType || null }
  };
}

export function normalizeProgress(item) {
  return {
    episodeId: String(first(item.eid, item.id, item.episodeId, "")),
    progressSeconds: seconds(first(item.progress, item.progressSeconds, item.position)),
    observedAt: normalizeTimestamp(first(item.playedAt, item.timestamp, item.updatedAt))
  };
}

export function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const APPLE_REFERENCE_DATE_OFFSET_SECONDS = 978_307_200;

export function normalizeAppleTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (numeric <= 0) return null;
  // Recent Apple Podcasts databases contain a mixture of NSDate (2001 epoch)
  // and Unix timestamps. Podcast-era Unix values are larger than the offset.
  const unixSeconds = numeric < APPLE_REFERENCE_DATE_OFFSET_SECONDS
    ? numeric + APPLE_REFERENCE_DATE_OFFSET_SECONDS
    : numeric;
  const date = new Date(unixSeconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const stripHtml = (value = "") => String(value)
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/p\s*>/gi, "\n\n")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n[ \t]+/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .replace(/[ \t]{2,}/g, " ")
  .trim();

export function normalizeApplePodcastsEpisode(raw) {
  const durationSeconds = seconds(raw.duration);
  const progressSeconds = Math.min(durationSeconds || Number.MAX_SAFE_INTEGER, seconds(raw.playhead));
  const playbackObservedAt = normalizeAppleTimestamp(
    first(raw.playback_observed_at, raw.observed_at, raw.last_played_at)
  );
  const completionObservedAt = normalizeAppleTimestamp(
    first(raw.completion_observed_at, raw.play_state_modified_at, raw.observed_at)
  ) || playbackObservedAt;
  const manualMarkedAt = normalizeAppleTimestamp(raw.manual_marked_at);
  const completed = Boolean(Number(raw.has_been_played || 0));
  const manualState = Boolean(
    Number(raw.play_state_manually_set || 0) || Number(raw.marked_as_played || 0)
  );
  const manuallyCompleted = completed && manualState && (
    !manualMarkedAt || !playbackObservedAt || manualMarkedAt >= playbackObservedAt
  );
  const automaticSummaryEligible = completed && !manuallyCompleted;
  const description = stripHtml(raw.description || "");
  return {
    episode: {
      platform: "apple-podcasts",
      externalId: String(first(raw.external_id, "")),
      title: first(raw.title, "未命名单集"),
      durationSeconds,
      publishedAt: normalizeAppleTimestamp(raw.published_at),
      description,
      audioUrl: null,
      imageUrl: null,
      podcast: {
        externalId: String(first(raw.podcast_external_id, "unknown")),
        title: first(raw.podcast_title, "Apple 播客"),
        author: first(raw.podcast_author, "")
      },
      topic: classifyTopic(first(raw.title, ""), description),
      raw: { source: "mac-podcasts-library" }
    },
    playback: {
      progressSeconds,
      observedAt: playbackObservedAt || completionObservedAt,
      playbackObservedAt,
      completionObservedAt,
      completed,
      manuallyCompleted,
      automaticSummaryEligible,
      estimatedListenedSeconds: automaticSummaryEligible && durationSeconds > 0
        ? durationSeconds
        : progressSeconds,
      playCount: Math.max(0, Math.round(Number(raw.play_count || 0)))
    }
  };
}
