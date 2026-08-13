const API_BASE = "https://api.xiaoyuzhoufm.com";

export class XiaoyuzhouClient {
  constructor({ credentials, fetchFn = fetch, onCredentialsChanged = async () => {} }) {
    this.credentials = { ...credentials };
    this.fetchFn = fetchFn;
    this.onCredentialsChanged = onCredentialsChanged;
  }

  headers() {
    const { accessToken, refreshToken, deviceId } = this.credentials;
    if (!accessToken || !refreshToken) throw new Error("小宇宙登录会话不完整，请重新绑定");
    return {
      applicationid: "app.podcast.cosmos",
      "x-jike-access-token": accessToken,
      "x-jike-refresh-token": refreshToken,
      "x-jike-device-id": deviceId || "podcast-memory-local",
      "content-type": "application/json"
    };
  }

  async request(path, options = {}, allowRefresh = true) {
    const response = await this.fetchFn(`${API_BASE}${path}`, {
      ...options,
      headers: { ...this.headers(), ...(options.headers || {}) }
    });
    if (response.status === 401 && allowRefresh) {
      await this.refresh();
      return this.request(path, options, false);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`小宇宙接口返回 ${response.status}`);
    }
    return payload;
  }

  async refresh() {
    const response = await this.fetchFn(`${API_BASE}/app_auth_tokens.refresh`, {
      method: "POST",
      headers: this.headers()
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload["x-jike-access-token"]) {
      throw new Error("小宇宙登录已过期，请重新绑定");
    }
    this.credentials.accessToken = payload["x-jike-access-token"];
    if (payload["x-jike-refresh-token"]) {
      this.credentials.refreshToken = payload["x-jike-refresh-token"];
    }
    await this.onCredentialsChanged(this.credentials);
  }

  async getProfile() {
    const payload = await this.request("/v1/profile/get", { method: "GET" });
    return payload.data || {};
  }

  async getHistory(cursor = null, limit = 20) {
    const body = { limit };
    if (cursor) body.loadMoreKey = cursor;
    const payload = await this.request("/v1/episode-played/list-history", {
      method: "POST",
      body: JSON.stringify(body)
    });
    return {
      episodes: (payload.data || []).map((item) => item.episode || item),
      cursor: payload.loadMoreKey || null
    };
  }

  async getProgress(episodeIds) {
    if (!episodeIds.length) return [];
    const payload = await this.request("/v1/playback-progress/list", {
      method: "POST",
      body: JSON.stringify({ eids: episodeIds })
    });
    return payload.data || [];
  }

  async getMonthlyWrapped(uid, year, month) {
    const query = new URLSearchParams({ uid, year: String(year), month: String(month) });
    const payload = await this.request(`/v1/monthly-wrapped/get?${query}`, { method: "GET" });
    return payload.data || { playedDays: 0, playedSeconds: 0 };
  }

  async getMileage(cursor = null, rank = "TOTAL") {
    const body = { rank };
    if (cursor) body.loadMoreKey = cursor;
    const payload = await this.request("/v1/mileage/list", {
      method: "POST",
      body: JSON.stringify(body)
    });
    return {
      rows: Array.isArray(payload.data) ? payload.data : [],
      cursor: payload.loadMoreKey || null
    };
  }
}
