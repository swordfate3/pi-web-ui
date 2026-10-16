# 大型实时内容与网页传输限界

状态：基于 `497b15c` 的本地未提交修复；未 push、未更新用户安装包，未 `/reload`，未重启 Hub／隧道。测试仅使用隔离 Pi、faux provider、合成文件／会话与临时 Git 仓库，不读取用户实际会话正文。

## 问题与改动边界

通用错误 `Web UI message exceeds the transport size limit. Use bounded history or the original session.` 来自最终 **4 MiB UTF-8 JSON** 帧保护，不是模型上下文上限。Hub 单独的 16 MiB 限制不变。没有真实故障 payload，因此不宣称已确认用户每次报错的方法。

- 实时 delta 原来重复携带不断增长的 `message`／`partial`；现在只移除这两个冗余快照。`agent_end.messages`、`turn_end.message/toolResults` 同样不重复传输。保留事件名和其他控制字段，不修改 Pi 原事件、持久化数据或模型输入。
- 仍过大的已知 message/tool/turn/compaction 事件转成带 session/runtime、sourceEvent、bytes 的 `transport_omitted`。浏览器验证身份和元数据，显示一个可关闭的独立状态提示；终态复用原有有界历史同步，中间更新不逐片请求。失败同步保留明确错误，不自动无限重试。
- Git diff 与文件预览的完整 JSON 预算为约 3 MiB（保留 1 KiB envelope 余量）。Git tracked／untracked 总量超限或 Git 输出缓冲区超限时返回明确失败；文件超过既有 1 MiB 或 JSON 转义后超预算提示下载。没有把部分 diff 作为完整成功返回。
- 更新 ADR0002、ADR0008 和 AGENTS 的明确 transport-only 例外。后端仍不生成 artifact／tab／聊天产品模型。

## 实际验证

| 层次 | 结果和范围 |
| --- | --- |
| 修复前 | 已安装旧版 `497b15c` 运行同一合成大型参数／结果场景失败：网页没有恢复出 completed write 控件。不是读取真实故障会话复现。 |
| 默认单测 | 262 项，261 通过，1 可选 GiB 条件跳过；包括投影不 mutation、失败响应 ID、未知事件 fail closed、scope 校验、终态恢复／通知清理、20 个终态遗漏合并及恢复失败无自动重试、合成 Git／文件 JSON 转义预算。 |
| 真实 Pi 后端 | portable／Hub／日期历史／下载／上传／usage 六类 integration，共 16/16。此轮运行在 Git／文件 Agent 最终交接之前，不冒充最终所有文件原子快照验证。 |
| 完整 Chromium | 68/68，约 5.3 分钟。该轮已含核心 live 修复／最终预览函数，尚未加入后续 JSONL 完整正文与请求计数断言。 |
| 最终定向 Chromium | 大型传输＋workspace 共 9/9；新 direct／Hub 场景校验所有帧 ≤4 MiB、没有顶层 size error、delta 不含累计快照、工具结束／输入提交状态、终态同步次数上界及稳定后不继续轮询、通知关闭、刷新恢复。最终还校验合成 JSONL 中 toolCall 原始参数和 toolResult 全文，以及原文件大小／SHA-256 都完整。 |
| 构建／hash | `build:web`、`verify:dist` 通过；138 source inputs、673 output files。仅 hash 一致性，不证明可信来源。 |
| 静态检查 | Biome 198 文件，无 error；新增覆盖既有 history-store 后暴露 5 条原有 non-null assertion warning，没有全文件顺手重构。前端构建类型与补充 connection／新测试／E2E 类型 DIAGNOSTICS=0（复用 review 工作树已有 ws 声明，未安装依赖）。 |
| 类型边界 | 专项 Git harness 最初静态导入完整 mirror adapter 时暴露其 5 项既有类型问题（`__dirname`、mime、model、SessionEntry、fork result）；没有声称整个 adapter strict 通过。改为与既有 mock harness 一样动态加载，补充 strict 检查覆盖新增 helper／协议 store／测试，不借此声称已修复 adapter 旧问题。 |
| 离线分发 | pack／解包 704 entries，含新后端 helper、只有 ws 生产依赖；七类 stale input 均拒绝，Hub CLI help 正常；**不是实际 npm 安装／更新生命周期**。离线解包 runtime 的 direct／Hub 新场景先跑 2/2；最终加入 untracked 读取失败修正后在全新解包目录再次跑大型传输＋workspace 共 9/9。 |
| 独立 Browser 视觉 | 真实隔离服务 `127.0.0.1:46019`：1440×900 和 390×844 截图直接查看；中文提示、关闭按钮、completed write preview 与输入框正常；手机 scrollWidth=390。不是自动 E2E 截图替代，也不是实体手机测试。 |

实时核心独立只读审查在限定快照内无确认 P2+；预览预算复核发现原有 untracked 读失败吞错仍返回不完整成功的 P2（基线 `catch {}` 可核对，不能归为预算新引入）。本轮顺带改成固定、不含路径的失败响应，新增非 root POSIX chmod0 真实失败回归，以及 diff 自身转义、tracked＋untracked 混合累计回归并通过。两次审查均未执行程序、非原子完整 diff 审计。恢复失败／请求次数已分别补充单测和最终 E2E；慢速下一段回答恰与恢复重叠的可见体验仍无专项动态证据。

## 失败尝试与修正

- E2E 初版 import 使 BDD 生成器尝试 CommonJS 加载 ESM pi-ai，改用独立的纯合成数据模块。
- 初版仅投影 delta，真实 Pi 仍从 agent_end／turn_end 重复正文报超限；追加两种明确投影后 direct／Hub 通过。
- manifest 单测预期列表新增路径未排序导致一次失败，修正字典序后全单测通过。
- 新的 debounce 失败路径单测在 Node 中缺 window，补充仅此测试生命周期内的 timer stub；UiText 字符串断言类型改为精确 equal 后补充 types 通过。
- 独立 Browser 第二张桌面 settled 截图两次超时，bringToFront 后成功；保留失败，不当成页面已断线或已修复的产品故障。
- 二次离线 pack 解包误复用先前目录，残留旧 hashed assets 被 manifest 正确拒绝；改为全新 `.tmp/transport-release-final` 后校验与 9 场景通过，没有放宽完整性验证。

## 未覆盖／仍可能出现的限制

- 不是任意超大 payload 都可恢复：未知／交互式扩展／state_sync 等事件仍 fail closed；超大的 `get_fork_messages`、`get_files` 等响应仍可能触发保留 ID 的通用失败，未在本轮加入分页或截断。fork 全文可能用于恢复草稿，不能静默改成 preview。
- 没有改变日期范围、100 条／512 KiB 历史页、32 KiB 单条预览和树限制；旧日期／旧页不被强制切回今天。不能保证尚未持久化的内容立即有历史预览。
- 最终 guard 对非投影字段仍先 JSON 序列化，故本轮限制的是 wire 大小，不保证超大对象的恒定 CPU／内存或全程无界全文渲染性能。
- 原始会话保留指 Pi 已保存的原文；没有新增持久化、崩溃恢复、远端备份或真实账单服务。
- 未检验公网、实体软键盘／Safari／Firefox、真实第三方扩展巨大交互 payload 或用户实际故障流量；不发起新模型请求、不增加生成 token。

## 本地证据位置

- 日志：`/tmp/pi-transport-{unit-final,build-final,check-final,types-final,dist-final,backend,e2e-all,e2e-final-all-assertions,package-final,e2e-offline,e2e-offline-final}.log`；旧版失败 `/tmp/pi-transport-e2e-before.log`。
- 离线包结果：`.tmp/transport-release-final/result.json`。
- 截图（仓库外，不随软件包）：`/workspace/downloads/playwright-mcp/transport-{desktop,mobile,desktop-settled}.png`，已直接 read；初次 desktop 在终态同步稳定前截图，最终以 desktop-settled 为准。
- 自有临时视觉服务 PID109574 已 SIGTERM 并确认退出。当前不再可访问，不意味着用户安装实例已加载新代码。
