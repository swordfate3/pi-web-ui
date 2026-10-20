# 数学渲染与终端等待提示

## 状态与范围

本轮在隔离工作树开发，基于 Web UI 1.0.1 发布提交；未提升版本、提交、推送、安装、reload 或部署，不改变生产服务。

- 数学：兼容聊天消息里的 `\(...\)` 与 `\[...\]`，保留既有 dollar math 策略及代码、转义、普通金额。最终采用原生 micromark/remark syntax，而不是改写 Markdown 原文；代码、转义、列表和引用的边界交由 CommonMark 处理。KaTeX CSS／字体随包构建，手机公式局部横向滚动。
- 原生确认：**仅缓解网页看不到等待状态**，不是 Web Yes/No 授权实现。真正的记忆写入仍须在 Pi 终端或原有可信 RPC 客户端回应。
- 不修改 scoped-memory 源码、安装 release、SDK 或原生确认／commit 路径。

## 确认边界

Pi 原生 `ctx.ui.confirm` 的 TUI／RPC 回答通道并非 mirror WebSocket。旧 `extension_ui_response` 返回 ACK 但没有实际 resolver；本轮改为明确 unsupported 错误，前端显示失败。

聊天 origin 不是可信管理 origin；模型生成内容可能访问同 origin 的 Web 接口，不能把 WebSocket 上的 `confirmed: true`、Origin／nonce 校验或按钮事件直接当作记忆授权。

公开 `ui_prompt_start/end` 只用于展示 `kind/title?`，不包含正文、选项、当前输入或 resolver。banner 在断线、session/runtime 更换及 prompt end 时清理；重连从当前 snapshot 恢复仍在等待的瞬态 metadata，不写聊天历史。安全 Web Yes/No 需要另行设计独立可信 origin 与一次性授权协议。

## 已执行验证

### 基线

- 原始隔离树单元测试：496 项，495 通过、1 条件跳过。
- 原始连接类型检查通过；已有 Markdown 浏览器场景通过。

### 终端等待

- 合成独立 fixture 调用**真实 `ctx.ui.confirm`**，不是手工模拟事件。测试确认正文仅在 fixture 的可信 RPC 流里出现，未进入收集的 WebSocket 帧。
- Pi 1.1.0／1.3.0：各 3/3 真实集成通过。Web 伪造批准返回错误；确认仍等待；重连 snapshot 保留等待；可信 RPC 拒绝后收到 end 且后续 snapshot 为空。另测 100ms timeout 和独立 AbortController abort：不发送 RPC 回答，真实 SDK 返回非批准，start/end 各一次、Web 无正文、结束后重连为空。
- 独立只读审查未发现可证实的本次 terminal-prompt 缺陷；不代表完整系统安全证明。
- Browser 实际打开本地真实 Pi fixture：桌面 1440×1000、手机 390×844。两张截图均已查看：提示标题及终端回应说明可读，手机自然换行，没有遮挡消息输入区；无假 Yes/No。
- 原始截图：`downloads/pi-web-ui-visual-check/terminal-prompt-desktop.png`、`terminal-prompt-mobile.png`（会话产物，不纳入包）。
- 手机首次截图工具多次超时；页面 reload 后重新截取并实际查看成功，没有把 DOM 断言当作视觉通过。

### 后端回归

- 真实 Pi 后端串行运行消息修订、portable connection 和 session Hub：Pi 1.1.0／1.3.0 各 11/11 通过。
- 上述行为仍保留 unknown 派发不可自动重试和生命周期防护，没有加入清锁旁路。

## 数学与最终统一验证

- 原始文本预处理方案经独立审查发现代码、已有 dollar math、引用/列表和缩进公式保护不足，已彻底替换为原生语法扩展；不在消息正文中插入 dollar 或空行。保留 `singleDollarTextMath: false`，不把 `$5` 或原本的单美元文本新解释为公式。
- 新语法使用原有 math 插件的 rehype KaTeX 默认安全选项，不启用 `trust`。同段未闭合起始符的后缀扫描采用 tokenizer 实例级 WeakMap 缓存，避免重复扫描的二次复杂度；缓存不跨文档或流式重解析。
- 6 项数学测试通过：AST 及真实 Streamdown streaming/static SSR，覆盖代码关闭反引号前反斜杠、列表 fence、缩进与 tab 多行公式、引用／嵌套列表、已有 dollar math、未闭合公式、KaTeX 不可信 URL 和缓存隔离。1k/2k/4k/8k 未闭合起始符的本机单次实验约 13/13/24/33ms；这是观察数据，不是跨机器性能保证。
- 真实 Pi＋faux provider 的数学浏览器场景通过，检查用户和助手公式、代码／金额，以及 390px 页面未横向撑宽。这里的模型响应是合成 fixture，不访问真实模型。
- 数学 Browser 截图已实际查看：1440×1000 与 390×844。行内上下标、独立分式／求和、既有 double-dollar 数学可见；代码保留、金额仍普通文字，没有页面溢出。产物为 `downloads/pi-web-ui-visual-check/math-tex-desktop.png`、`math-tex-mobile.png`。Browser 交互曾有稳定性等待超时，最终通过可信 fixture RPC 准备合成会话后再导航检查；另有 Playwright 真实 UI 发送流程通过，不混淆这两种证据。
- 最终完整单元测试 **509 项：508 通过／1 条件跳过／0 失败**。前端和连接 TypeScript 通过；Biome 256 文件 **0 error／30 warning／1 info**。`build:web` 和 `verify:dist` 通过，包含新增 extension 源文件指纹；build 仍有既有大 chunk 提示。
- 完整浏览器 **72 项：69 通过／3 失败**，不是全绿：Hub 卡片稳定性一项在轮询后旧 DOM handle 断开；大型传输直连／Hub 两项预期 Submit、实际仍 Stop。用精确发布基线 `53bb63f` 的独立工作树重跑这 4 个相关场景：1 通过、相同 3 项失败，故确认这些失败在未修改基线也存在，未在本轮放宽断言或掩盖。
- 较早完整浏览器尝试被 300 秒外层预算中止；后续用足够预算完整完成上述 72 项。中间数学测试曾因 partial 字符串、fixture 单美元预期、selector 严格模式及 BDD CJS 导入 ESM-only response 失败，均已修正并重新执行相关测试。
- 没有下载／安装依赖；新直接 dev 依赖均已存在当前 lock／本地开发环境，仅补充声明并同步 lock 根依赖。未执行 Git/npm 网络安装回归。

尚未覆盖真实用户 memory 写入、生产公网链路、所有 Pi 扩展的 custom UI，以及生产重启；不读取真实会话正文或凭据。测试仅使用合成会话，不意味着当前 Pi 已加载本轮源码。
