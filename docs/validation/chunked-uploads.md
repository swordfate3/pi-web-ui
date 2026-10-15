# 大文件分片上传验证

## 范围与状态

基于 `main@3fa9e5f` 的未提交工作树，包含回形针＋“上传文件”入口。默认单文件 1 GiB、固定 8 MiB 分片，支持本地校验进度、取消／失败后重试、刷新后重选原文件续传，以及最终完整哈希校验和暂存总预留约束。行为与配置见 [PRD](../prd/file-uploads.md) 和 [ADR 0016](../adr/0016-resumable-workspace-uploads.md)。

本地实现与以下验证已完成，**未提交、推送或部署**。所有上传及提示均为合成 fixture，只使用隔离临时 Pi／Hub 和 faux provider；没有读取真实用户正文／凭据、安装依赖、更新启用包、重载当前 Pi 或修改公网链路。

## 最终结果

| 层级 | 结果与范围 |
| --- | --- |
| 默认单测 | `npm run test:unit`：232 项，**231 通过、1 项可选 GiB 跳过、0 失败**；含后端分片、HTTP 错误脱敏、客户端／哈希／scope、既有 Hub／分发／日期等回归 |
| 实际 1 GiB store 实写 | 核心快照组 **24/24**，其中精确 1 GiB 使用单个 8 MiB buffer ×128，完整落盘大小与流式 SHA-256 核对；单项约 47.3 秒 |
| 实际 1 GiB 增量哈希 | `IncrementalSha256` 用复用 1 MiB buffer ×1024 与 Node crypto 对比一致，约 5.06 秒；这是 Node 中执行浏览器共享算法，不是浏览器 1 GiB 实测 |
| 真实 Pi 后端 | 离线解包 runtime **15/15**：原生连接、Hub／generation／停止、日期、下载、上传，以及 compaction／异步 dispatch 拒绝；上传 direct／Hub 均实际传输并校验 **65 MiB** 多块文件 |
| 真实 Pi 浏览器 | 同一离线解包 runtime 完整 Chromium **61/61**；其中上传 **8/8**，包含直连、Hub 桌面／手机尺寸、刷新重选后仅补缺失分片、取消后完成收据复用、会话切换、目录失败重试与超限拒绝 |
| 静态／构建 | `build:web`（前端 TS＋Web／Hub Vite＋manifest）、`e2e:gen`、`verify:dist` 通过；Biome **177 文件**通过；后端／E2E 补充严格类型检查 **0 diagnostics** |
| Python gateway | 16 项，15 通过、1 条件跳过；未跑可选真实 Caddy 集成 |
| 离线分发 | tarball **702 条目**，4,902,518 压缩字节／25,272,900 解包字节；manifest **129 源／673 输出**；Node-only 安装校验入口、Hub CLI help 和八类 stale-input 负例通过 |

后端／E2E 类型检查复用本机另一现有 worktree 的 `@types/ws` 路径以弥补当前 node_modules 缺项，不安装依赖，不将此说明为全新干净环境的标准 tsc 通过。

离线分发使用 `npm pack --ignore-scripts`、tar 解包并显式执行 `node scripts/web-dist.mjs --install`，仅复制已有 `ws`；**不等于实际 npm／Pi install/update/prepare 生命周期**。生产依赖仍只有 `ws`。发布 tarball 省略前端源，按既有契约只校验输出哈希；另建 full-source fixture 对八种输入逐一篡改并确认拒绝：Web HTML、remote plan、Python gateway、Hub server、Hub CLI、Hub Vite 配置、上传后端、新增增量 SHA-256 源。

## 关键安全／资源证据

- 精确块长与逐块 SHA-256；重复确认块不重复追加，错误 hash 拒绝；complete 再流式核验全文件大小／hash。中文原名、原始二进制和真实 Pi `read` 工具读取均有断言，不只检查界面状态。
- 中断后只确认完整成功块；HTTP socket 断开不冒充后端异步 truncate／fsync 已结束，恢复测试有界等待 busy lease 释放后核对 offset。
- 配额按未完成文件完整声明大小计费，完成后释放；active chunk／finalization 清理、scope 变化、symlink 目录替换、已确认数据被篡改和旧 runtime 等均有回归。成功文件不因 TTL、取消或 receipt 消费删除。
- 独立后端快照审查发现一个必须修问题：底层文件系统／流错误可能包含绝对路径。已改为固定安全 HTTP 错误，并通过真实 HTTP 制造 ENOENT 的回归，确认不含 cwd、ENOENT、lstat 或 partial 路径。客户端／哈希／UI 独立快照审查未发现确认的必须修问题；两者均不冒充独立运行动态测试或完整基线 diff 审查。
- 保留原真实 Pi user `message_start` 接收确认和 unknown no-retry fence，续传不会绕过已 dispatch 的未知提交。dispatch 后第三方异步 hook／reload 仍受上游不可撤回 API 限制，不承诺撤回所有模型工作。

## Browser 视觉验证（独立于功能 E2E）

以隔离真实 Pi fixture 的本机临时 URL `http://127.0.0.1:<临时端口>/` 打开 Browser，截图后直接查看，不修改 React 状态或伪造 WebSocket。临时服务已停止。

- 桌面 **1440×900**：回形针＋“上传文件”、25 MiB 附件选择、输入区与实际上传进度均可见；无重叠或遮挡。
- 手机尺寸 **390×844**：实际校验进度、上传进度、取消后的保留附件／续传说明，以及完成后可信路径进入聊天、输入区清空均可见。文件名截断可读，取消／发送入口可见；`scrollWidth=390`，未见横向溢出。
- 使用 25 MiB 合成文件（四片）；Browser MCP 对非同机文件传递有 50 MiB 限制，65 MiB 文件选择尝试被工具拒绝，未当成产品上传失败。真实后端 65 MiB 证据来自另一集成层。
- 视觉完成态的 faux 回复为 `UPLOAD_PATH_MISSING`：该 fixture 仅匹配 `中文说明.txt` 并执行 read，而此视觉输入是 `.bin`。截图证明路径提交与输入区恢复，不证明该二进制已被模型分析；真实文本 read 已由后端／浏览器 E2E 单独覆盖。
- 未稳定截取瞬态 finalizing 单独截图，不宣称其视觉态独立通过。首次名为 hashing 的桌面图实际上已进入上传，后续手机 CPU throttle 图才捕获真实校验态；不按文件名冒充状态。

原始截图位于从仓库根目录出发的 `../../downloads/playwright-mcp/`（不是包内发布资源）：

- `chunk-desktop-selected.png`（桌面选择）
- `chunk-desktop-hashing.png`（桌面实际上传，不是 hashing）
- `chunk-mobile-uploading.png`（手机上传）
- `chunk-mobile-paused.png`（手机取消／重试说明）
- `chunk-mobile-hashing-390.png`（手机真实校验态）
- `chunk-mobile-complete.png`（手机提交后）

`chunk-mobile-hashing-final.png` 捕获了校验态，但该调用 viewport 被工具重置，不计入 390×844 手机证据。

## 开发失败与复跑

- 初次后端核心快照暴露完整哈希失败后目录遗留和交接测试在 dispatch 前错误期待 unknown，分别修实现清理与测试等待边界；后续追加 quota／clear／symlink／tamper 四项通过。
- 首次 `/tmp` overlay 的精确 1 GiB store 尝试 210 秒超时，未算通过。改用工作区挂载盘测试暂存后完成实际实写；v2 fsync 改异步等待并在 await 后重查 scope，不跳过持久同步。该 GiB fixture 均已清理。
- 客户端初次单测四项失败（预期／异步步骤／旧文案等）、新 E2E 的变量／文件选择／poll 类型错误和首次缺 step 的生成失败，均保留开发日志；最终单测／生成／类型检查通过。
- 首轮后端 **13/15**：faux fixture 的唯一 read 响应被前一 legacy prompt 消费，修为按实际上下文响应；随后真实中断后的恢复查询早于异步写锁释放，测试改为只对 busy 做有界等待，不降低数据／offset 断言。最终 **15/15**。
- 完整浏览器曾两次 **60/61**：“非 Git 工作区”fixture 的 TMPDIR 放在工作区挂载路径，向上识别外层 Git 仓库／状态不可用；恢复该套件原有 `/tmp` 隔离目录后 **61/61**，未改产品或放宽断言。

## 本地原始日志索引

- `/tmp/pi-chunk-unit-final.log`、`/tmp/pi-chunk-check-final.log`、`/tmp/pi-chunk-types-final.log`、`/tmp/pi-chunk-dist-final.log`
- `/tmp/pi-chunk-build-final.log`、`/tmp/pi-chunk-package-final.log`（最终构建与离线分发）；最终重建／打包的计数与字节数和已测 runtime 相同
- `/tmp/pi-chunk-backend-unit-final.log`（实际 GiB store）、`/tmp/pi-chunk-sha-large.log`（实际 GiB 增量哈希）
- `/tmp/pi-chunk-backend-final.log`（15 后端）、`/tmp/pi-chunk-browser-release-final.log`（61 浏览器）
- `/tmp/pi-chunk-browser.log`（8 上传浏览器）；`.tmp/chunk-release/result.json`（离线分发元数据）

日志与 `.tmp` 产物是本机临时证据，不属于包分发保证。源码、tracked `dist`、文档仍为本地未提交改动。

## 验证边界

- 声明大小边界不是实际传完整文件；store GiB 与算法 GiB 证据不等于浏览器／公网 GiB 传输。
- 未验证生产公网、实体手机、外部 Caddy／隧道或 Windows/macOS 文件系统；不推断 GitHub CI 状态。
- 续传须同一运行期／scope，刷新后重新选原文件并重新本地 hash，只节省网络传输；不承诺跨进程、扩展 reload、跨会话或 crash recovery。异常崩溃可能遗留 partial，需人工管理。
- 成功附件由用户管理，不自动删除；2 GiB 暂存预留不是跨进程／已保存文件累计磁盘 quota，不保证容器持久化、内容安全扫描或解析。
- 本轮未提交／推送、安装／更新包、改共享设置或重启真实 Pi／Hub／隧道。当前启用包不会因此自动获得分片功能。
