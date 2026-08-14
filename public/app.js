const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const platformName = { xiaoyuzhou: "小宇宙", gcores: "机核", "apple-podcasts": "Apple Podcasts" };
const platformLogin = {
  xiaoyuzhou: "https://podcaster.xiaoyuzhoufm.com/",
  gcores: "https://www.gcores.com/"
};

let setupInfo = null;
let connectingPlatform = null;
let latestAccounts = [];
let aiInfo = { configured: false };
let currentEpisodeId = null;
let currentEpisode = null;
let searchTimer = null;
let jobTimer = null;
let memoryRequest = 0;
let backgroundRefreshTimer = null;
let showcaseMode = false;
let localSetupAvailable = false;

const DASHBOARD_CACHE_KEY = "echo:last-dashboard";
const MEMORY_CACHE_KEY = "echo:last-memory";
const OFFLINE_CACHE_ENABLED_KEY = "echo:offline-cache-enabled";
const INSTALL_DISMISS_KEY = "echo:install-dismissed-at";
const OFFLINE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const formatHours = (seconds, digits = 1) => (Number(seconds || 0) / 3600).toFixed(digits).replace(/\.0$/, "");
const formatDate = (value) => value
  ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value))
  : "日期未知";
const formatDateTime = (value) => value
  ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value))
  : "尚未同步";
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
}[char]));

const readLocalCache = (key) => {
  try {
    if (localStorage.getItem(OFFLINE_CACHE_ENABLED_KEY) !== "1") {
      localStorage.removeItem(key);
      return null;
    }
    const envelope = JSON.parse(localStorage.getItem(key) || "null");
    if (!envelope || !Number.isFinite(envelope.savedAt) || Date.now() - envelope.savedAt > OFFLINE_CACHE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return envelope.value;
  } catch { return null; }
};

const writeLocalCache = (key, value) => {
  try {
    if (localStorage.getItem(OFFLINE_CACHE_ENABLED_KEY) !== "1") return;
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), value }));
  } catch {}
};

const clearOfflineCache = () => {
  try {
    localStorage.removeItem(DASHBOARD_CACHE_KEY);
    localStorage.removeItem(MEMORY_CACHE_KEY);
  } catch {}
};

async function bootstrapLocalSession() {
  const accessToken = new URLSearchParams(window.location.hash.slice(1)).get("access");
  if (!accessToken) return;
  const response = await fetch("/api/local-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken })
  });
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "本机私密链接验证失败");
  }
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    const error = new Error("暂时连不到运行回声的 Mac");
    error.offline = true;
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 3600);
}

function setAutomationStatus(message, state = "ready") {
  const element = $("#automationStatus");
  element.textContent = message;
  element.classList.toggle("syncing", state === "syncing");
  element.classList.toggle("offline", state === "offline");
}

function minutesUntil(value) {
  if (!value) return null;
  const minutes = Math.ceil((Date.parse(value) - Date.now()) / 60_000);
  return Number.isFinite(minutes) ? Math.max(0, minutes) : null;
}

async function loadAutomationStatus() {
  try {
    const status = await api("/api/automation");
    if (status.showcaseMode) {
      setAutomationStatus("只读合成演示");
      return status;
    }
    if (status.running) {
      setAutomationStatus("正在自动同步", "syncing");
      return status;
    }
    const failed = Object.entries(status.platforms || {}).find(([, item]) => item.status === "failed");
    if (failed) {
      setAutomationStatus(`部分平台需检查 · ${platformName[failed[0]] || failed[0]}`, "offline");
      return status;
    }
    const remaining = minutesUntil(status.nextSyncAt);
    setAutomationStatus(remaining === null ? `每 ${status.intervalMinutes} 分钟自动同步` : `自动同步 · ${remaining || "不到 1"} 分钟后`);
    return status;
  } catch (error) {
    setAutomationStatus(error.message, "offline");
    throw error;
  }
}

function setupInstallExperience() {
  document.body.classList.toggle("is-standalone", isStandalone);
  if (!isIOS || isStandalone) return;
  let dismissedAt = 0;
  try { dismissedAt = Number(localStorage.getItem(INSTALL_DISMISS_KEY) || 0); } catch {}
  const dismissedRecently = dismissedAt && Date.now() - dismissedAt < 7 * 24 * 60 * 60 * 1000;
  if (!dismissedRecently) $("#installCard").hidden = false;
}

function updateModalState() {
  const anyOpen = $$(".modal").some((modal) => !modal.hidden);
  document.body.classList.toggle("modal-open", anyOpen);
}

function openModal(selector) {
  $(selector).hidden = false;
  updateModalState();
}

function closeModal(selector) {
  $(selector).hidden = true;
  updateModalState();
}

function renderAccounts(accounts, { showcase = false, canConnect = true } = {}) {
  latestAccounts = accounts;
  for (const account of accounts) {
    const card = $(`[data-platform="${account.platform}"]`);
    const status = card?.querySelector(".status-line");
    const button = card?.querySelector(".sync-button");
    if (!card) continue;
    if (showcase) {
      status.classList.remove("connected");
      status.textContent = "合成数据 · 未连接任何账号";
      button.disabled = true;
      button.dataset.mode = "showcase";
      button.textContent = "演示";
      button.setAttribute("aria-label", `${platformName[account.platform]}只读演示`);
      continue;
    }
    if (!canConnect && account.platform !== "apple-podcasts" && !account.connected) {
      status.classList.remove("connected");
      status.textContent = "请回到 Mac 本机完成首次绑定";
      button.disabled = true;
      button.dataset.mode = "remote";
      button.textContent = "仅限本机";
      button.setAttribute("aria-label", `${platformName[account.platform]}需在 Mac 本机连接`);
      continue;
    }
    if (account.platform === "apple-podcasts") {
      status.classList.toggle("connected", Boolean(account.connected) && !account.last_error);
      status.textContent = account.last_error
        ? `读取失败：${account.last_error}`
        : account.connected
          ? `已自动读取${account.last_sync_at ? ` · ${formatDateTime(account.last_sync_at)} 更新` : ""}`
          : account.display_name || "自动检测 Mac 播客资料库";
      button.disabled = false;
      button.dataset.mode = "sync";
      button.textContent = "检查";
      button.setAttribute("aria-label", "检查 Apple Podcasts");
      continue;
    }
    if (account.connected) {
      status.classList.toggle("connected", !account.last_error);
      status.textContent = account.last_error
        ? `上次同步失败：${account.last_error}`
        : `已连接${account.last_sync_at ? ` · ${formatDateTime(account.last_sync_at)} 更新` : ""}`;
      button.disabled = false;
      button.dataset.mode = "sync";
      button.textContent = "同步";
      button.setAttribute("aria-label", `同步${platformName[account.platform]}`);
    } else {
      status.classList.remove("connected");
      status.textContent = "未连接 · 点击开始一次性绑定";
      button.disabled = false;
      button.dataset.mode = "connect";
      button.textContent = "连接";
      button.setAttribute("aria-label", `连接${platformName[account.platform]}`);
    }
  }
}

async function copyText(value, successMessage) {
  try {
    await navigator.clipboard.writeText(value);
    toast(successMessage);
  } catch {
    toast("复制失败，请手动选择并复制");
  }
}

function openConnection(platform) {
  connectingPlatform = platform;
  $("#connectionTitle").textContent = `连接${platformName[platform]}`;
  $("#connectionIntro").textContent = `这是一次性设置。完成后，${platformName[platform]}的新收听记录会自动进入回声。`;
  $("#loginStepTitle").textContent = `登录${platformName[platform]}网页`;
  $("#platformLoginLink").href = platformLogin[platform];
  $("#platformLoginLink").textContent = `打开${platformName[platform]}登录页面 ↗`;
  $("#modalPairingCode").textContent = setupInfo?.pairingCode || "········";
  openModal("#connectionModal");
}

function closeConnection() {
  closeModal("#connectionModal");
}

function renderChart(monthly) {
  const chart = $("#monthlyChart");
  if (!monthly.length) {
    chart.innerHTML = '<p class="empty">连接账号后显示月度收听节奏</p>';
    return;
  }
  const max = Math.max(...monthly.map((item) => Number(item.seconds)), 1);
  chart.innerHTML = monthly.map((item) => `
    <div class="bar-group">
      <div class="bar ${item.has_estimate ? "estimated" : ""}" style="height:${Math.max(3, Number(item.seconds) / max * 178)}px" data-hours="${formatHours(item.seconds)}"></div>
      <span class="bar-label">${escapeHtml(item.period.slice(5))}月</span>
    </div>
  `).join("");
}

function renderTopics(topics) {
  const list = $("#topicList");
  const max = Math.max(...topics.map((item) => Number(item.episodes)), 1);
  list.innerHTML = topics.slice(0, 6).map((item) => `
    <div class="topic-row">
      <span>${escapeHtml(item.topic)}</span>
      <div class="topic-track"><div class="topic-fill" style="width:${Number(item.episodes) / max * 100}%"></div></div>
      <span class="topic-count">${item.episodes}</span>
    </div>
  `).join("") || '<p class="empty">还没有主题数据</p>';
}

function renderEpisodes(episodes) {
  const list = $("#episodeList");
  list.innerHTML = episodes.map((episode, index) => {
    const progress = episode.is_completed ? 100 : episode.duration_seconds
      ? Math.min(100, Number(episode.progress_seconds || 0) / Number(episode.duration_seconds) * 100)
      : 0;
    return `
      <article class="episode" data-episode-id="${escapeHtml(episode.id)}" tabindex="0">
        <span class="episode-index">${String(index + 1).padStart(2, "0")}</span>
        <div>
          <p class="episode-title">${escapeHtml(episode.title)}</p>
          <p class="episode-meta">${escapeHtml(episode.podcast_title)} · ${platformName[episode.platform] || escapeHtml(episode.platform)} · ${formatDate(episode.observed_at)}</p>
          ${episode.summary ? `<p class="episode-summary">${escapeHtml(episode.summary)}</p>` : ""}
        </div>
        <div class="progress-wrap">
          <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
          <span class="progress-label">${Math.round(progress)}% · ${formatHours(episode.duration_seconds, 1)}h</span>
        </div>
        <span class="topic-pill">${escapeHtml(episode.ai_category || episode.topic || "其他")}</span>
      </article>`;
  }).join("") || '<p class="empty">连接账号后，最近收听会自动出现在这里。</p>';
}

function renderMemory(episodes) {
  const list = $("#memoryList");
  list.innerHTML = episodes.map((episode) => `
    <article class="memory-card" data-episode-id="${escapeHtml(episode.id)}" tabindex="0">
      <div class="memory-card-top">
        <span class="memory-platform">${platformName[episode.platform] || escapeHtml(episode.platform)}</span>
        <span class="memory-date">${formatDate(episode.observed_at || episode.published_at)}</span>
      </div>
      <h3 class="memory-title">${escapeHtml(episode.title)}</h3>
      <p class="memory-podcast">${escapeHtml(episode.podcast_title)} · ${escapeHtml(episode.ai_category || episode.topic || "其他")}</p>
      ${episode.summary
        ? `<p class="memory-summary">${escapeHtml(episode.summary)}</p>`
        : '<p class="memory-empty-summary">尚无文字回顾 · 点击生成</p>'}
    </article>
  `).join("") || '<p class="empty">没有符合当前条件的节目。</p>';
}

function populateTopicFilter(topics) {
  const select = $("#memoryTopic");
  const current = select.value;
  const defaults = ["AI 与科技", "游戏", "商业与经济", "影视与文化", "社会与历史", "生活与成长", "科学与健康", "旅行与地域", "人物访谈", "其他"];
  const values = [...new Set([...defaults, ...topics.map((item) => item.topic).filter(Boolean)])];
  select.innerHTML = '<option value="">全部主题</option>' + values
    .map((topic) => `<option value="${escapeHtml(topic)}">${escapeHtml(topic)}</option>`)
    .join("");
  if (values.includes(current)) select.value = current;
}

async function loadDashboard() {
  const data = await api("/api/dashboard");
  writeLocalCache(DASHBOARD_CACHE_KEY, data);
  renderDashboard(data);
  return data;
}

function renderDashboard(data) {
  showcaseMode = Boolean(data.showcaseMode);
  $("#demoBadge").hidden = !data.demoMode;
  if (showcaseMode) {
    $("#pairingCode").textContent = "DEMO ONLY";
    $(".pairing-card small").textContent = "只读演示不会生成或暴露配对凭据";
  } else if (!localSetupAvailable) {
    $("#pairingCode").textContent = "LOCAL ONLY";
    $(".pairing-card small").textContent = "首次绑定只在 Mac 本机页面显示配对码";
  }
  const total = data.stats.exactSeconds + data.stats.estimatedSeconds;
  $("#totalHours").textContent = formatHours(total);
  $("#episodeCount").textContent = data.stats.episodeCount;
  $("#podcastCount").textContent = data.stats.podcastCount;
  const byPlatform = data.stats.byPlatform || {};
  const platformSeconds = (platform) => Number(byPlatform[platform]?.exactSeconds || 0) +
    Number(byPlatform[platform]?.estimatedSeconds || 0);
  const hints = [
    `小宇宙 ${formatHours(platformSeconds("xiaoyuzhou") || data.stats.exactSeconds)} 小时`,
    `机核约 ${formatHours(platformSeconds("gcores"))} 小时`
  ];
  const appleAccount = data.accounts.find((account) => account.platform === "apple-podcasts");
  if (platformSeconds("apple-podcasts")) {
    hints.push(`Apple 约 ${formatHours(platformSeconds("apple-podcasts"))} 小时`);
  } else if (appleAccount?.connected) {
    hints.push("Apple 已接入（暂无可估算时长）");
  } else if (appleAccount?.last_error) {
    hints.push("Apple 等待 macOS 授权");
  } else {
    hints.push("Apple 等待资料库");
  }
  $("#estimateHint").textContent = hints.join(" · ");
  renderAccounts(data.accounts, { showcase: showcaseMode, canConnect: localSetupAvailable || Boolean(setupInfo?.pairingCode) });
  renderChart(data.monthly);
  renderTopics(data.topics);
  renderEpisodes(data.recent);
  populateTopicFilter(data.topics);
}

async function loadMemory() {
  const requestId = ++memoryRequest;
  const params = new URLSearchParams({ limit: "60" });
  const query = $("#memorySearch").value.trim();
  const platform = $("#memoryPlatform").value;
  const topic = $("#memoryTopic").value;
  const summarizedOnly = $("#summarizedOnly").checked;
  const isDefaultRequest = !query && !platform && !topic && !summarizedOnly;
  if (query) params.set("q", query);
  if (platform) params.set("platform", platform);
  if (topic) params.set("topic", topic);
  if (summarizedOnly) params.set("summarized", "1");
  const result = await api(`/api/episodes?${params}`);
  const episodes = result.episodes || result;
  if (requestId !== memoryRequest) return;
  if (isDefaultRequest) writeLocalCache(MEMORY_CACHE_KEY, episodes);
  renderMemory(episodes);
}

async function loadAIStatus({ force = false } = {}) {
  aiInfo = await api(`/api/ai/status${force ? "?refresh=1" : ""}`);
  const status = $("#aiStatus");
  if (showcaseMode || aiInfo.showcaseMode) {
    status.classList.remove("configured");
    status.textContent = "只读演示 · 未连接 AI";
    $("#configureAI").textContent = "演示模式";
    $("#configureAI").disabled = true;
    return aiInfo;
  }
  status.classList.toggle("configured", aiInfo.configured);
  status.textContent = aiInfo.configured
    ? "OpenAI API 已连接 · 按量计费"
    : "AI 默认关闭 · 浏览不受影响";
  $("#configureAI").textContent = "查看可选 AI";
  const modalStatus = $("#aiModalStatus");
  if (modalStatus) {
    modalStatus.textContent = aiInfo.configured
      ? `已连接：${aiInfo.summaryModel}。${aiInfo.automaticSummary?.enabled ? "自动回顾已开启。" : "自动回顾未开启。"}`
      : (aiInfo.message || "AI 快速回顾尚未启用");
  }
  return aiInfo;
}

function sourceLabel(sourceKind) {
  return sourceKind === "transcript"
    ? { text: "基于整期音频转写", className: "deep" }
    : { text: "基于节目简介与时间轴", className: "" };
}

function listBlock(title, values, { ordered = false, wide = false } = {}) {
  if (!values?.length) return "";
  const tag = ordered ? "ol" : "ul";
  return `
    <section class="detail-block ${wide ? "wide" : ""}">
      <h3>${escapeHtml(title)}</h3>
      <${tag}>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</${tag}>
    </section>`;
}

function outlineBlock(outline) {
  if (!outline?.length) return "";
  return `
    <section class="detail-block wide">
      <h3>回看提纲</h3>
      <div class="outline-list">${outline.map((item) => `
        <article><strong>${escapeHtml(item.heading)}</strong><p>${escapeHtml(item.detail)}</p></article>
      `).join("")}</div>
    </section>`;
}

function renderJob(job) {
  if (!job || !["queued", "running"].includes(job.status)) return "";
  const total = Number(job.total_steps || 0);
  const completed = Number(job.completed_steps || 0);
  const percentage = total ? Math.round(completed / total * 100) : 8;
  const label = job.mode === "deep"
    ? (total ? `正在转写音频 ${completed}/${total}` : "正在准备音频转写")
    : "正在阅读节目资料并生成回顾";
  return `
    <div class="job-progress">
      <div><span>${escapeHtml(label)}</span><strong>${percentage}%</strong></div>
      <div class="detail-progress"><span style="width:${percentage}%"></span></div>
      <small>可以关闭窗口，任务会在本机继续。</small>
    </div>`;
}

function renderEpisodeDetail(episode) {
  currentEpisode = episode;
  const progress = episode.is_completed ? 100 : episode.duration_seconds
    ? Math.min(100, Number(episode.progress_seconds || 0) / Number(episode.duration_seconds) * 100)
    : 0;
  const summarySource = sourceLabel(episode.summary_source_kind);
  const activeJob = episode.job && ["queued", "running"].includes(episode.job.status) ? episode.job : null;
  const hasAudio = Boolean(episode.has_audio);
  const summaryMarkup = episode.summary ? `
    <span class="summary-source ${summarySource.className}">${summarySource.text}</span>
    <p class="detail-summary">${escapeHtml(episode.summary)}</p>
    <div class="detail-grid">
      ${listBlock("核心要点", episode.keyPoints, { wide: true })}
      ${outlineBlock(episode.outline)}
      ${listBlock("关键词", episode.keywords)}
      ${listBlock("人物与机构", episode.people)}
      ${listBlock("以后可以追问", episode.reviewQuestions, { ordered: true, wide: true })}
    </div>
    ${episode.limitation ? `<p class="summary-limitation">范围说明：${escapeHtml(episode.limitation)}</p>` : ""}
  ` : `
    <div class="detail-placeholder">
      这期还没有文字回顾。以后听完新的一集，回声会自动读取节目简介和时间轴生成快速回顾；你也可以现在手动生成。
    </div>`;
  $("#episodeDetail").innerHTML = `
    <p class="detail-kicker">${platformName[episode.platform] || escapeHtml(episode.platform)} · ${escapeHtml(episode.ai_category || episode.topic || "其他")}</p>
    <h2 id="episodeDetailTitle" class="detail-title">${escapeHtml(episode.title)}</h2>
    <p class="detail-meta">${escapeHtml(episode.podcast_title)} · ${formatDate(episode.observed_at || episode.published_at)} · ${formatHours(episode.duration_seconds)} 小时</p>
    <div class="detail-progress"><span style="width:${progress}%"></span></div>
    ${summaryMarkup}
    ${renderJob(activeJob)}
    ${showcaseMode ? "" : `<div class="detail-actions">
      <button class="summary-button" type="button" data-summary-mode="quick" ${activeJob ? "disabled" : ""}>${episode.summary ? "重新生成快速回顾" : "生成快速回顾"}</button>
      ${hasAudio && aiInfo.transcriptionConfigured ? `<button class="summary-button deep" type="button" data-summary-mode="deep" ${activeJob ? "disabled" : ""}>${episode.has_transcript ? "用完整转写重新总结" : "转写整期并深度总结"}</button>` : ""}
    </div>`}
  `;
}

async function openEpisode(episodeId) {
  currentEpisodeId = episodeId;
  clearTimeout(jobTimer);
  $("#episodeDetail").innerHTML = '<p class="empty">正在读取单集资料…</p>';
  openModal("#episodeModal");
  try {
    const { episode } = await api(`/api/episodes/${encodeURIComponent(episodeId)}`);
    if (currentEpisodeId !== episodeId) return;
    renderEpisodeDetail(episode);
    if (["queued", "running"].includes(episode.job?.status)) pollSummaryJob(episode.job.id);
  } catch (error) {
    $("#episodeDetail").innerHTML = `<p class="detail-placeholder">${escapeHtml(error.message)}</p>`;
  }
}

function closeEpisode() {
  currentEpisodeId = null;
  currentEpisode = null;
  clearTimeout(jobTimer);
  closeModal("#episodeModal");
}

function openAISettings() {
  openModal("#aiModal");
}

function closeAISettings() {
  closeModal("#aiModal");
}

async function startSummary(mode) {
  if (!currentEpisodeId) return;
  if (!aiInfo.configured) {
    openAISettings();
    toast(aiInfo.message || "请先明确启用 OpenAI Platform API");
    return;
  }
  const buttons = $$("[data-summary-mode]");
  let cloudAudioConfirmed = false;
  if (mode === "deep") {
    cloudAudioConfirmed = window.confirm(
      "深度总结会把整期音频分段上传到 OpenAI Platform API，可能产生费用；机核内容还可能受会员或版权限制。请只处理你有权上传的内容。是否继续？"
    );
    if (!cloudAudioConfirmed) return;
  }
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api(`/api/summarize/${encodeURIComponent(currentEpisodeId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, cloudAudioConfirmed })
    });
    renderEpisodeDetail({ ...currentEpisode, job: result.job });
    pollSummaryJob(result.job.id);
    toast(mode === "deep" ? "已开始整期转写，可以先去浏览其他节目" : "正在生成快速回顾");
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    toast(error.message);
  }
}

async function pollSummaryJob(jobId) {
  clearTimeout(jobTimer);
  try {
    const { job } = await api(`/api/summary-jobs/${encodeURIComponent(jobId)}`);
    if (!currentEpisodeId) return;
    if (["queued", "running"].includes(job.status)) {
      renderEpisodeDetail({ ...currentEpisode, job });
      jobTimer = setTimeout(() => pollSummaryJob(jobId), 1600);
      return;
    }
    if (job.status === "completed") {
      toast("文字回顾已生成");
      await Promise.all([openEpisode(currentEpisodeId), loadMemory(), loadDashboard()]);
      return;
    }
    renderEpisodeDetail({ ...currentEpisode, job });
    toast(job.error || "文字回顾生成失败");
  } catch (error) {
    toast(error.message);
  }
}

function hydrateFromLocalCache() {
  const dashboard = readLocalCache(DASHBOARD_CACHE_KEY);
  const episodes = readLocalCache(MEMORY_CACHE_KEY);
  if (dashboard) renderDashboard(dashboard);
  if (episodes) renderMemory(episodes);
  return Boolean(dashboard || episodes);
}

async function refreshVisibleData({ quiet = false } = {}) {
  const results = await Promise.allSettled([loadDashboard(), loadMemory(), loadAutomationStatus()]);
  const failure = results.find((result) => result.status === "rejected");
  if (!failure) return true;
  const hasCache = Boolean(readLocalCache(DASHBOARD_CACHE_KEY) || readLocalCache(MEMORY_CACHE_KEY));
  setAutomationStatus(hasCache ? "Mac 离线 · 显示上次数据" : "Mac 暂时离线", "offline");
  if (!quiet) toast(failure.reason?.message || "暂时无法刷新");
  return false;
}

async function sync(platform, button) {
  const idleLabel = platform === "apple-podcasts" ? "检查" : "同步";
  button.disabled = true;
  button.textContent = platform === "apple-podcasts" ? "检查中" : "同步中";
  try {
    const result = await api(`/api/sync/${platform}`, { method: "POST" });
    const suffix = result.skipped
      ? "正在进行另一轮同步，请稍后再检查"
      : platform === "apple-podcasts" && result.available === false
        ? "尚未找到本地资料库；请先在 Mac 打开一次系统“播客”"
        : platform === "apple-podcasts" && !result.sourceEpisodeCount
          ? "资料库尚无收听记录；请在 Mac“播客”中用同一 Apple Account 开启“同步资料库”"
          : `同步完成，导入 ${result.importedCount || 0} 条记录`;
    toast(`${platformName[platform]}${suffix}`);
    await Promise.all([loadDashboard(), loadMemory(), loadAutomationStatus()]);
  } catch (error) {
    toast(error.message);
  } finally {
    button.textContent = idleLabel;
    button.disabled = false;
  }
}

function episodeActivation(event) {
  const card = event.target.closest("[data-episode-id]");
  if (!card) return;
  if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  openEpisode(card.dataset.episodeId);
}

$$('[data-sync]').forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.mode === "connect") openConnection(button.dataset.sync);
  else sync(button.dataset.sync, button);
}));
$$('[data-close-connection]').forEach((element) => element.addEventListener("click", closeConnection));
$$('[data-close-episode]').forEach((element) => element.addEventListener("click", closeEpisode));
$$('[data-close-ai]').forEach((element) => element.addEventListener("click", closeAISettings));

$("#copyChromeUrl").addEventListener("click", () => copyText("chrome://extensions", "扩展管理地址已复制"));
$("#copyPairingCode").addEventListener("click", () => copyText(setupInfo?.pairingCode || "", "配对码已复制"));
$("#copyPlatformLogin").addEventListener("click", () => copyText(platformLogin[connectingPlatform] || "", `${platformName[connectingPlatform]}登录地址已复制`));
$("#checkConnection").addEventListener("click", async () => {
  await loadDashboard();
  const connected = latestAccounts.find((account) => account.platform === connectingPlatform)?.connected;
  if (connected) {
    closeConnection();
    toast(`${platformName[connectingPlatform]}已连接，自动同步已经开始`);
  } else {
    toast("还没有收到连接，请确认已在 Chrome 扩展里点击“连接”");
  }
});

$("#episodeList").addEventListener("click", episodeActivation);
$("#episodeList").addEventListener("keydown", episodeActivation);
$("#memoryList").addEventListener("click", episodeActivation);
$("#memoryList").addEventListener("keydown", episodeActivation);
$("#episodeDetail").addEventListener("click", (event) => {
  const button = event.target.closest("[data-summary-mode]");
  if (button) startSummary(button.dataset.summaryMode);
});

$("#configureAI").addEventListener("click", openAISettings);
$("#saveAIKey").addEventListener("click", async () => {
  const button = $("#saveAIKey");
  const apiKey = $("#openaiApiKey").value.trim();
  button.disabled = true;
  try {
    aiInfo = await api("/api/ai/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey })
    });
    $("#openaiApiKey").value = "";
    await loadAIStatus({ force: true });
    toast(aiInfo.configured ? "OpenAI API 已连接；调用会按量计费" : aiInfo.message);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#checkAIConnection").addEventListener("click", async () => {
  const button = $("#checkAIConnection");
  button.disabled = true;
  button.textContent = "正在检查";
  try {
    await loadAIStatus({ force: true });
    toast(aiInfo.configured ? "OpenAI Platform API 设置可用（按量计费）" : aiInfo.message || "AI 尚未启用");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "重新检查 API 设置";
  }
});

$("#memorySearch").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadMemory().catch((error) => toast(error.message)), 260);
});
for (const selector of ["#memoryPlatform", "#memoryTopic", "#summarizedOnly"]) {
  $(selector).addEventListener("change", () => loadMemory().catch((error) => toast(error.message)));
}

$("#dismissInstall").addEventListener("click", () => {
  try { localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now())); } catch {}
  $("#installCard").hidden = true;
});

const offlineCacheToggle = $("#offlineCacheToggle");
try { offlineCacheToggle.checked = localStorage.getItem(OFFLINE_CACHE_ENABLED_KEY) === "1"; } catch {}
offlineCacheToggle.addEventListener("change", () => {
  try {
    if (offlineCacheToggle.checked) localStorage.setItem(OFFLINE_CACHE_ENABLED_KEY, "1");
    else localStorage.removeItem(OFFLINE_CACHE_ENABLED_KEY);
  } catch {}
  if (!offlineCacheToggle.checked) clearOfflineCache();
  toast(offlineCacheToggle.checked ? "已开启离线保存；仅读取 24 小时内的缓存" : "已关闭并清除离线资料");
});
$("#clearOfflineCache").addEventListener("click", () => {
  clearOfflineCache();
  try { localStorage.removeItem(OFFLINE_CACHE_ENABLED_KEY); } catch {}
  offlineCacheToggle.checked = false;
  toast("此设备上的离线资料已清除，离线保存也已关闭");
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("#aiModal").hidden) closeAISettings();
  else if (!$("#episodeModal").hidden) closeEpisode();
  else if (!$("#connectionModal").hidden) closeConnection();
});

$("#refreshButton").addEventListener("click", () => refreshVisibleData()
  .then((ok) => { if (ok) toast("数据已刷新"); }));

window.addEventListener("offline", () => setAutomationStatus("网络离线 · 显示上次数据", "offline"));
window.addEventListener("online", () => { void refreshVisibleData({ quiet: true }); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshVisibleData({ quiet: true });
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void refreshVisibleData({ quiet: true });
});

async function startApplication() {
  try { await bootstrapLocalSession(); } catch (error) { toast(error.message); }
  setupInstallExperience();
  hydrateFromLocalCache();

  const results = await Promise.allSettled([
    api("/api/setup"),
    loadDashboard(),
    loadMemory(),
    loadAIStatus(),
    loadAutomationStatus()
  ]);
  const setupResult = results[0];
  if (setupResult.status === "fulfilled") {
    setupInfo = setupResult.value;
    localSetupAvailable = Boolean(setupInfo.pairingCode);
    if (setupInfo.showcaseMode) {
      $("#pairingCode").textContent = "DEMO ONLY";
      $(".pairing-card small").textContent = "只读演示不会生成或暴露配对凭据";
    } else if (setupInfo.pairingCode) {
      $("#pairingCode").textContent = setupInfo.pairingCode;
    }
    void loadDashboard().catch(() => {});
  }
  const failure = results.find((result, index) => index > 0 && result.status === "rejected");
  if (failure) {
    const hasCache = Boolean(readLocalCache(DASHBOARD_CACHE_KEY) || readLocalCache(MEMORY_CACHE_KEY));
    setAutomationStatus(hasCache ? "Mac 离线 · 显示上次数据" : "Mac 暂时离线", "offline");
    if (!hasCache) toast(failure.reason?.message || "暂时无法读取数据");
  }
}

void startApplication();

backgroundRefreshTimer = setInterval(() => {
  if (document.visibilityState === "visible") void refreshVisibleData({ quiet: true });
}, 60_000);
