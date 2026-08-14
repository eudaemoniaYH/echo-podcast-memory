# Security Policy

## Reporting a vulnerability

请不要在公开 Issue 中发布以下内容：

- 小宇宙、机核或其他平台的 Cookie、令牌与账号标识
- 回声的短时配对码
- 回声的本机私密访问链接、访问令牌或会话 Cookie
- SQLite 数据库、收听历史、节目摘要或 Tailscale 私有地址
- macOS Keychain 内容、日志或包含个人路径的诊断文件

请使用 GitHub 仓库的 **Security → Report a vulnerability** 私下报告；如果 Private Vulnerability Reporting 暂未启用，请只提交不含利用细节的简短 Issue，请求维护者提供私下沟通方式。

报告中请说明受影响版本、可复现条件、预期影响和已经采取的缓解措施。不要测试不属于你的平台账号或设备。

## Supported version

当前仅维护 `main` 分支的最新版本。该项目是个人研究原型，不提供生产环境安全承诺。

公开托管真实收听资料、通过 Tailscale Funnel 暴露服务、或将其作为多人服务运行均不在支持范围内。

## Security boundaries

- 服务只监听 `127.0.0.1`；iPhone 访问由用户自行配置的 Tailscale Serve 提供。
- loopback 不是身份认证：个人 API 还要求每个数据目录首次运行时生成的 256-bit 本机会话令牌；重装会复用它，不要分享安装脚本显示的 `#access=...` 地址。
- 平台会话保存在 macOS Keychain，收听数据保存在本机 SQLite。
- 浏览器连接器只接受明确配置的单一扩展来源；配对码短时有效、成功后轮换且不得分享。
- 远程 PWA 只接受显式配置的唯一 HTTPS 来源；服务始终监听 loopback，不应使用 Tailscale Funnel 或公开反向代理。
- AI、自动回顾和音频转写默认关闭。启用快速回顾后，播客/单集名和最多 120,000 字符的简介或时间轴会发送到无工具的 OpenAI Responses API，并产生 Platform API 费用。
- 整期音频只在单独启用并逐次确认后上传；受保护机核音频还需第二个环境开关，且用户必须自行确认上传权利。
- PWA 个人资料离线缓存默认关闭；开启后存放在当前设备浏览器，只读取 24 小时内的数据，过期内容在下次打开时清除，并可立即手动清除。
