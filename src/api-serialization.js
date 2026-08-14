const PUBLIC_EPISODE_FIELDS = [
  "platform", "title", "podcast_title", "podcast_author", "topic",
  "duration_seconds", "published_at", "observed_at", "progress_seconds",
  "is_completed", "is_demo", "ai_category", "summary", "summary_source_kind",
  "summary_model", "summary_updated_at", "limitation", "has_transcript",
  "keyPoints", "outline", "keywords", "people", "reviewQuestions"
];

const PUBLIC_JOB_FIELDS = [
  "id", "mode", "status", "completed_steps", "total_steps", "error",
  "created_at", "updated_at"
];

export const serializeSummaryJob = (job) => {
  if (!job) return null;
  const result = {};
  for (const field of PUBLIC_JOB_FIELDS) {
    if (job[field] !== undefined) result[field] = job[field];
  }
  return result;
};

export const serializeEpisodeDetail = (episode) => {
  if (!episode) return null;
  const result = { id: episode.public_id };
  for (const field of PUBLIC_EPISODE_FIELDS) {
    if (episode[field] !== undefined) result[field] = episode[field];
  }
  if (episode.job) result.job = serializeSummaryJob(episode.job);
  result.has_audio = Boolean(episode.audio_url) || episode.platform === "gcores";
  return result;
};
