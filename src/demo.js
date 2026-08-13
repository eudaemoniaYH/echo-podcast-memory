const demoEpisodes = [
  {
    platform: "xiaoyuzhou", externalId: "demo-xy-1", title: "AI 助手正在怎样改变个人工作流",
    durationSeconds: 4380, publishedAt: "2026-07-15T03:00:00.000Z", description: "讨论人工智能、知识管理与个人工作方式。",
    podcast: { externalId: "demo-pod-1", title: "明日工作室", author: "演示主播" }, topic: "AI 与科技", raw: {}
  },
  {
    platform: "gcores", externalId: "demo-gc-1", title: "我们为什么仍然热爱单机游戏",
    durationSeconds: 6240, publishedAt: "2026-07-13T05:00:00.000Z", description: "从叙事、机制和玩家记忆聊主机游戏。",
    podcast: { externalId: "gcores-radio", title: "机核电台", author: "机核" }, topic: "游戏", raw: {}
  },
  {
    platform: "xiaoyuzhou", externalId: "demo-xy-2", title: "消费品牌的下一条增长曲线",
    durationSeconds: 3560, publishedAt: "2026-07-11T08:00:00.000Z", description: "品牌、市场与创业案例复盘。",
    podcast: { externalId: "demo-pod-2", title: "商业漫游", author: "演示主播" }, topic: "商业与经济", raw: {}
  },
  {
    platform: "gcores", externalId: "demo-gc-2", title: "一部科幻电影如何建立完整世界",
    durationSeconds: 5120, publishedAt: "2026-07-08T08:00:00.000Z", description: "电影创作与流行文化观察。",
    podcast: { externalId: "gcores-radio", title: "机核电台", author: "机核" }, topic: "影视与文化", raw: {}
  }
];

export function seedDemo(db) {
  if (db.getMeta("demo_seeded")) return;
  const samples = [3260, 4890, 2940, 4010];
  demoEpisodes.forEach((episode, index) => {
    const episodeId = db.upsertEpisode(episode, { isDemo: true });
    db.addPlaybackSample({
      platform: episode.platform,
      episodeId,
      progressSeconds: samples[index],
      observedAt: new Date(Date.now() - index * 86_400_000).toISOString(),
      source: "demo",
      isEstimated: episode.platform === "gcores",
      isDemo: true
    });
  });
  db.upsertListeningTotal({ platform: "xiaoyuzhou", period: "2026-05", listenedSeconds: 29880, isEstimated: false, source: "demo-monthly", isDemo: true });
  db.upsertListeningTotal({ platform: "xiaoyuzhou", period: "2026-06", listenedSeconds: 42120, isEstimated: false, source: "demo-monthly", isDemo: true });
  db.upsertListeningTotal({ platform: "xiaoyuzhou", period: "2026-07", listenedSeconds: 26760, isEstimated: false, source: "demo-monthly", isDemo: true });
  db.upsertListeningTotal({ platform: "gcores", period: "2026-07", listenedSeconds: 9720, isEstimated: true, source: "demo-estimate", isDemo: true });
  db.addSummary("xiaoyuzhou:episode:demo-xy-1", "AI 助手的价值不只在节省时间，而在于把零散工作变成可以复用、检查和持续改进的系统。", ["先固定高频工作流", "保留人工审核节点", "把输出沉淀为知识资产"]);
  db.addSummary("gcores:episode:demo-gc-1", "单机游戏提供了由作者精心控制节奏的完整体验，玩家记忆往往来自机制、叙事与个人处境的共同作用。", ["完整体验仍有稀缺性", "机制会塑造叙事感受"]);
  db.setMeta("demo_mode", "1");
  db.setMeta("demo_seeded", "1");
}
