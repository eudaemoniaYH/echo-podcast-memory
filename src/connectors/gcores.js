const API_BASE = "https://www.gcores.com/gapi/v1";
const AUDIO_BASE = "https://alioss.gcores.com/uploads/audio/";

export class GcoresClient {
  constructor({ credentials, fetchFn = fetch }) {
    this.token = credentials.token;
    this.fetchFn = fetchFn;
  }

  async request(path) {
    if (!this.token) throw new Error("机核登录会话不完整，请重新绑定");
    let response;
    try {
      response = await this.fetchFn(`${API_BASE}${path}`, {
        headers: {
          accept: "application/vnd.api+json",
          "content-type": "application/vnd.api+json",
          authorization: `Token token=${this.token}`
        },
        signal: AbortSignal.timeout(45_000)
      });
    } catch (error) {
      if (error?.name === "TimeoutError") throw new Error("机核接口响应超时，请稍后重试");
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) {
      throw new Error("机核登录已过期，请重新绑定");
    }
    if (!response.ok) throw new Error(`机核接口返回 ${response.status}`);
    return payload;
  }

  async getHistory() {
    const payload = await this.request("/history");
    const source = payload.data?.attributes || payload.data || payload;
    return Array.isArray(source.playlist) ? source.playlist : [];
  }

  async getRadios(ids) {
    if (!ids.length) return [];
    const query = new URLSearchParams();
    query.set("filter[id]", ids.join(","));
    query.set("fields[radios]", "title,duration,cover,thumb,published-at,category,media,desc,content,excerpt");
    query.set("fields[medias]", "audio,duration,media-type,playback-type,timelines");
    query.set("fields[timelines]", "at,title,content");
    query.set("include", "category,media.timelines");
    query.set("page[limit]", String(ids.length));
    const payload = await this.request(`/radios?${query}`);
    const included = new Map((payload.included || []).map((item) => [`${item.type}:${item.id}`, item]));
    return (payload.data || []).map((item) => {
      const categoryRef = item.relationships?.category?.data;
      const category = categoryRef ? included.get(`${categoryRef.type}:${categoryRef.id}`) : null;
      const mediaRef = item.relationships?.media?.data;
      const media = mediaRef ? included.get(`${mediaRef.type}:${mediaRef.id}`) : null;
      const audio = media?.attributes?.audio;
      const mediaType = media?.attributes?.["media-type"] || null;
      const timelines = (media?.relationships?.timelines?.data || [])
        .map((reference) => included.get(`${reference.type}:${reference.id}`))
        .filter(Boolean)
        .map((timeline) => ({ id: String(timeline.id), ...timeline.attributes }))
        .sort((left, right) => Number(left.at || 0) - Number(right.at || 0));
      return {
        id: String(item.id),
        ...item.attributes,
        category: category?.attributes?.name || null,
        audioUrl: audio && mediaType !== "protected_audio" ? `${AUDIO_BASE}${audio}` : null,
        mediaType,
        playbackType: media?.attributes?.["playback-type"] || null,
        timelines
      };
    });
  }

  async getProtectedAudioUrl(radioId) {
    let response;
    try {
      response = await this.fetchFn(`${API_BASE}/medias/protected/radios/${encodeURIComponent(radioId)}`, {
        redirect: "manual",
        headers: {
          accept: "application/vnd.api+json",
          authorization: `Token token=${this.token}`
        },
        signal: AbortSignal.timeout(30_000)
      });
    } catch (error) {
      if (error?.name === "TimeoutError") throw new Error("机核音频地址响应超时，请稍后重试");
      throw error;
    }
    if (response.status === 401 || response.status === 403) throw new Error("机核登录已过期，请重新绑定");
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) return location;
    if (response.ok && response.url && response.url !== `${API_BASE}/medias/protected/radios/${radioId}`) return response.url;
    throw new Error(`机核受保护音频接口返回 ${response.status}`);
  }
}
