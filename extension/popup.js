const server = "http://127.0.0.1:8787";
const status = document.querySelector("#status");
const input = document.querySelector("#pairingCode");
input.value = localStorage.getItem("pairingCode") || "";

const cookie = (url, name) => chrome.cookies.get({ url, name }).then((result) => result?.value || null);

async function connect(platform, button) {
  const pairingCode = input.value.trim().toUpperCase();
  if (pairingCode.length !== 12) {
    status.textContent = "请先输入仪表盘显示的 12 位短时配对码。";
    return;
  }
  localStorage.setItem("pairingCode", pairingCode);
  button.disabled = true;
  button.textContent = "连接中";
  try {
    let body;
    if (platform === "xiaoyuzhou") {
      const [accessToken, refreshToken] = await Promise.all([
        cookie("https://podcaster.xiaoyuzhoufm.com/", "x-jike-access-token"),
        cookie("https://podcaster.xiaoyuzhoufm.com/", "x-jike-refresh-token")
      ]);
      if (!accessToken || !refreshToken) {
        await chrome.tabs.create({ url: "https://podcaster.xiaoyuzhoufm.com/" });
        throw new Error("未找到小宇宙登录状态。已打开登录页，登录后再点一次。 ");
      }
      body = { pairingCode, accessToken, refreshToken, deviceId: crypto.randomUUID() };
    } else {
      const token = await cookie("https://www.gcores.com/", "appToken");
      if (!token) {
        await chrome.tabs.create({ url: "https://www.gcores.com/" });
        throw new Error("未找到机核登录状态。已打开机核，登录后再点一次。 ");
      }
      body = { pairingCode, token };
    }
    const response = await fetch(`${server}/api/connect/${platform}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "连接失败");
    status.textContent = `连接成功，已自动导入 ${result.importedCount || 0} 条收听记录。`;
    button.textContent = "已连接";
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
    button.textContent = "连接";
  }
}

document.querySelectorAll("[data-connect]").forEach((button) => {
  button.addEventListener("click", () => connect(button.dataset.connect, button));
});
