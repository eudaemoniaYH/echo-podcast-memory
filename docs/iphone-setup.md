# 在 iPhone 上使用回声

回声采用“Mac 常驻同步 + iPhone 私有 Web App”的结构：小宇宙和机核令牌继续留在 Mac 钥匙串，Apple Podcasts 通过 Apple 自己的“同步资料库”把播放位置同步到 Mac；回声每 10 分钟只读整理三处记录，iPhone 只访问整理后的本地资料库。

## 1. 让 Mac 自动运行

在终端运行：

```bash
cd echo-podcast-memory
./scripts/install-macos-agent.sh
```

安装后，回声会把一个独立运行副本与数据库放在 `~/Library/Application Support/Podcast Memory`，避免外置硬盘权限或暂时断开影响后台服务。它会在登录 Mac 时自动启动、异常退出后自动重启，并在启动后立即同步一次。

若要纳入 Apple Podcasts，还需做一次 Apple 自己的初始化：

1. iPhone 打开 `设置 → App → 播客 → 同步资料库`。
2. Mac 首次打开系统“播客”App，完成欢迎/隐私确认，并使用与 iPhone 相同的 Apple Account。
3. Mac“播客”中打开 `播客 → 设置 → 通用 → 同步资料库`。
4. 回声第一次检查 Apple 资料库时，macOS 可能显示 `“node”想访问其他 App 的数据`；点击“允许”。这是 Apple 本地资料库的只读访问授权。

看到 iPhone 的节目或播放位置出现在 Mac 后即可关闭窗口。以后无需逐集导入；回声会自动读取 Mac 的只读本地镜像。Apple 没有公开个人收听历史 API，因此 Mac 尚未收到同步时，回声也不会凭空看到 iPhone 的记录。

若 Apple 卡片持续显示“读取超过 5 秒”，再次点“检查”并查看其他窗口后方是否有该系统弹窗。Apple 读取有独立的 5 秒超时，即使尚未授权，也不会影响小宇宙、机核或回声页面。只有在弹窗完全无法再次出现时，才考虑在 `系统设置 → 隐私与安全性 → 完全磁盘访问权限` 中添加当前 Node 可执行文件；这项备用权限范围更大。

## 2. 建立私有 HTTPS 连接

1. 在 Mac 和 iPhone 安装 Tailscale。
2. 两台设备登录同一个 Tailscale 账号。
3. 在 Mac 运行：

```bash
cd echo-podcast-memory
./scripts/setup-tailscale-serve.sh
```

脚本会显示一个 `https://...ts.net/` 地址。它只在你的 Tailscale 私网中可见，不会使用 Funnel，也不会公开到互联网。

脚本也会把这个**唯一**的 HTTPS 来源和当前 Tailscale 登录身份写入本机私有配置，并重新安装后台服务。回声会同时核对地址与 Tailscale Serve 注入的身份标头；DNS 名称或登录账号变化时，重新运行同一脚本即可。

## 3. 添加到 iPhone 主屏幕

1. 在 iPhone Safari 打开脚本显示的私有 HTTPS 地址。
2. 点“分享”。
3. 选择“添加到主屏幕”。
4. 打开“作为 Web App”，再点“添加”。

以后可直接从主屏幕打开“回声”。App 每次回到前台都会刷新，保持打开时也会每分钟检查一次；平台数据由 Mac 每 10 分钟自动同步。

## 运行条件与隐私

- Mac 必须开机、已登录且能联网；Mac 睡眠或关机期间无法读取新的平台记录。
- iPhone 和 Mac 必须都连入同一个 tailnet，iPhone 不要求与 Mac 处在同一个 Wi-Fi。
- 平台令牌仍保存在 Mac 的系统钥匙串；快速回顾使用 Mac 已登录的 ChatGPT/Codex 订阅，不需要在 iPhone 输入 API Key。
- 自动快速回顾由 Mac 后台执行，所以 Mac 还需要保持 ChatGPT/Codex 登录；iPhone 只显示队列状态和生成结果。
- PWA 的静态外壳可离线打开；最近一次加载的数据会保存在 iPhone 本地用于断网浏览。

## 取消后台服务

```bash
./scripts/uninstall-macos-agent.sh
```

这只会取消自动启动，不会删除 SQLite 数据库、平台令牌或文字回顾。
