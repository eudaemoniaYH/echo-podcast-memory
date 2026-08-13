# Security Policy

## Reporting a vulnerability

请不要在公开 Issue 中发布以下内容：

- 小宇宙、机核或其他平台的 Cookie、令牌与账号标识
- 回声的短时配对码
- SQLite 数据库、收听历史、节目摘要或 Tailscale 私有地址
- macOS Keychain 内容、日志或包含个人路径的诊断文件

请使用 GitHub 仓库的 **Security → Report a vulnerability** 私下报告；如果 Private Vulnerability Reporting 暂未启用，请只提交不含利用细节的简短 Issue，请求维护者提供私下沟通方式。

报告中请说明受影响版本、可复现条件、预期影响和已经采取的缓解措施。不要测试不属于你的平台账号或设备。

## Supported version

当前仅维护 `main` 分支的最新版本。该项目是个人研究原型，不提供生产环境安全承诺。

公开托管真实收听资料、通过 Tailscale Funnel 暴露服务、或将其作为多人服务运行均不在支持范围内。

## Security boundaries

- 服务只监听 `127.0.0.1`；iPhone 访问由用户自行配置的 Tailscale Serve 提供。
- 平台会话保存在 macOS Keychain，收听数据保存在本机 SQLite。
- 浏览器连接器只接受明确配置的单一扩展来源；配对码短时有效、成功后轮换且不得分享。
- 远程 PWA 只接受显式配置的唯一 HTTPS 来源；服务始终监听 loopback，不应使用 Tailscale Funnel 或公开反向代理。
- 快速回顾会把节目简介与时间轴发送给已登录的 Codex；不会自动上传整期音频。
