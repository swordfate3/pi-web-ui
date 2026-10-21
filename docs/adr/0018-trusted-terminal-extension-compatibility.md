# ADR 0018：用可信终端覆盖现有和新安装的扩展

日期：2026-10-19。状态：**选定设计草案；允许先做本地、默认关闭的契约与隔离验证，不是生产启用许可。**

## 1. 要解决什么

手机使用 Web 时，记忆确认和 `/mcp` 自定义面板不可操作；不能要求用户每安装一个扩展就开发对应 Web 页面。

选定方向：**保留聊天镜像，增加通往同一 Pi TUI 的可信终端入口。** 首版记忆直接在真实 TUI 上确认，`/mcp` 直接显示原面板；不先制造另一套记忆批准协议或 MCP 配置写入接口。结构化网页对话框作为后续体验增强，不是兼容前提。

可观察验收：

1. 浏览器显示同一个 Pi 进程的完整确认预览，人工拒绝不写记忆，人工确认才继续原有提交流程。
2. `/mcp` 的 TUI 面板可用方向键／确认／取消操作；一个新安装的合成 custom-UI 扩展无需 Web 专用适配即可操作。
3. 本机终端与网页看见同一个进程，不启动第二个 Pi，不回放 prompt，不擅自 reload。
4. 普通聊天网页、Agent 生成的 HTML、旧连接、旧写入租约不能输入终端。
5. 功能关闭或旧容器不具备能力时，聊天与现有运行管理不变，界面明确报告不支持。

不承诺：原生 Windows Hub、任意桌面 GUI／浏览器 OAuth 回调／外部 `$EDITOR` 自动映射、恶意扩展隔离、无终端通道的运行中 Pi 无缝接管，以及任意 TUI 在任意窄屏上视觉完美。

## 2. 已确认现状与重要修正

| 依据 | 已确认的事实 | 对设计的影响 |
|---|---|---|
| `extensions/mirror-server.ts`、`docs/terminal-prompts.md` | mirror 只有 UI 等待 metadata；没有 TUI resolver | 不能把现有 Web response ACK 改成批准就宣称通用支持 |
| Pi `docs/rpc-extension-ui.md` | RPC 支持 confirm/select/input/editor，但 `custom()` 返回 undefined | 全部改为 RPC 会丢失 `/mcp` 等完整 TUI，不能作为通用方案 |
| 已安装 MCP adapter `commands.ts` 的 `canRenderPanel/openMcpPanel` | 自定义面板要求 `ctx.mode === "tui"` | 必须保留 Pi TUI 运行模式 |
| 已安装 supervisor `spawn()` | 子进程继承外层 TTY；未持有 PTY master | Web 包单独更新无法增加终端接入 |
| `docs/validation/managed-restart-security-rulings.md` F3 | 当前已审设计禁止 PTY relay，终端不确定性永久锁存 | 新终端是独立 opt-in profile，不能伪装为原重启机制的小修补 |
| `extensions/runtime-stdin-guard.mjs`、`runtime-control.ts` | 未审计输入永久 taint；只有 1.1.0/1.3.0 重启传输受审 | 不清 taint；新 profile 默认不具备远程重启资格，须独立重新审计 |
| `hub/server.ts`、`hub/management.ts` | 管理 origin 独立、管理 listener 拒绝全部 Upgrade 和 Pi 内容 | 不在管理 origin 偷开普通 Pi WebSocket/终端输出 |

本次只读观察安装文件，不授权修改 `/usr/local` 或已安装 SDK。当前工作区未找到 pi-docker supervisor 的可编辑源码工作树；这阻塞现有受管启动方式的生产集成，**不阻塞本仓库以 Python 标准库启动隔离测试 Pi 的 PTY 验证**。Gate 负责现有部署审批，不是 PTY 功能或本地验证的前置依赖；除非另选与 Gate 集成的 provider，不要求 Gate 源码，也不默认让 Gate 承载终端流。

## 3. 选定拓扑与职责

```text
普通聊天 origin ── Hub chat ── mirror ───────────────┐
                                                  │ 同一个 Pi TUI 子进程
独立终端 origin ── Hub terminal ── terminal provider │
                                     │            │
                              固定 terminal broker│
                                     │            │
                                  PTY master ═ slave
                                     │
                           supervisor / 本机 TTY relay

独立管理 origin ── Hub management ── 现有 lifecycle provider
                                      （保持独立）
```

### Pi runtime：唯一终端所有者

- 旧 profile `inherited-tui` 原样保留。新增 `web-terminal-v1`，仅管理员显式选择的新启动可使用；不是探测到浏览器就自动切换。
- 新 profile 由镜像内 supervisor 分配 PTY，以正确 controlling-terminal、session/process-group 启动**唯一 Pi 子进程**。固定 broker 持有输出解析和输入租约；外层本机 TTY 仅转发到该 PTY，不再同时直连 child stdin。
- Python 标准库处理 PTY/process group；固定 Node broker 处理有界终端状态与协议。两者都属于镜像维护源，不属于用户可写的扩展包；broker 不能接受执行程序、argv、cwd、环境变量、容器名、PID 或任意 socket 路径。
- broker 为每次真实 child 创建随机 `terminalEpoch`；退出后立即终止所有连接、销毁 buffer 和租约。新的 child 永远新 epoch；旧连接不得跟随继任进程。
- PTY 不是“只给记忆用”的权限：用户获得的是当前 Pi TUI 输入能力，包括插件操作、内置命令及该进程原本允许的 shell 行为。入口必须明确说明，不能标成只读或低风险确认。

### terminal provider：宿主寻址与授权核实

- Hub/Pi 仍不持有 Docker socket。由管理员侧 provider 使用固定、审过的 terminal 控制客户端，基于 run grant、允许的镜像和启动 profile 定位唯一容器；不按浏览器提交的容器名执行 shell。
- 使用**独立 terminal provider 凭据和策略**，不能复用 registry、Gate 申请、lifecycle 或 runtime-update token。
- 若复用 Gate 进程承载 terminal provider，须新增独立、默认 disabled 的协议/授权域和有界流；现有 lifecycle 16KiB 请求/响应 API 不升级成任意隧道，原策略不隐含终端权限。
- provider 输出的是受限制的 terminal schema，不是通用 TCP/WebSocket 代理；未配置时 Hub 显示 unavailable。

### Hub：第三个终端 origin

- 选择独立 terminal listener/origin，而不是已有 management listener：保留管理面禁止 Pi 输出/Upgrade 的不变量，也不把终端解析器故障的影响提升为生命周期管理权限。
- 终端 listener 只提供包内固定终端资产及 terminal API/WS。不提供 Pi HTTP、项目 HTML、任意上游、Service Worker、iframe 或泛化 CONNECT。
- 保持三个 origin 不同；只改 URL 路径不算分离。不授予聊天 origin CORS。固定 Host/Origin 校验、CSP、frame-ancestors none、noopener/no-referrer；公网必须 HTTPS/WSS。
- 终端认证可复用现有**验证逻辑**，但独立 cookie 名称、session store、epoch、CSRF、权限 scope；现有管理登录不隐式获得 terminal read/write。可使用管理员显式配置的同一网关身份，但仍需 terminal scope 启用。
- 本地不同端口只提供浏览器 origin 隔离，cookie 不按端口隔离；聊天转发继续剥离全部 Cookie/Authorization/x-pi-hub-*，不能依靠端口避免泄露。

### 浏览器：可信外壳，不执行终端内容

- 候选终端渲染器为固定版本 `@xterm/xterm`，服务端状态镜像候选为 `@xterm/headless`＋serialization addon；**当前未安装，版本与依赖需在安装前审核**。不采用手写 ANSI→HTML。
- 终端输出视为完全不可信，绝不 innerHTML；禁止 OSC52 剪贴板读写、自动跳链接、通知、下载、动态标题覆盖身份栏、外部图片/自定义图形加载及 addon 自动行为。外壳持续显示 run/session 的可信身份，终端文本不能伪造外壳。
- 首版渲染器 `disableStdin`，不把通用 `onData/onBinary` 回送 Pi。键盘/手机输入来自外壳的人工输入框和固定按键（方向、Enter、Esc、Tab、Ctrl+C 等），显式取得控制后才发送。
- 终端自动 DA/DSR 响应与人工按键分开：不把渲染输出触发的响应当用户输入；首版不转发浏览器自动响应，必要终端报告由固定 broker 在审计后提供。不能为兼容而放开任意 escape reply。
- IME 从 composition end 后的显式提交取值；方向键是固定 key enum，不让服务器猜按钮文字。多行粘贴要单独确认，最大 8KiB，展示“会发送多行／可能执行命令”；支持 bracketed paste 不等于可免确认。
- 首版不支持 TUI 鼠标协议；提供键盘路线。复制由用户明确操作，终端输出不能主动读取浏览器剪贴板。

## 4. 控制权、会话与重启：保守规则

### 单一 writer

每个 child 只有一个输入所有者：`none | local | remote(lease)`。

- 默认外层本机 TTY 有权输入，网页 attach 默认只读；即便只读，终端可能含秘密，必须 terminal.read 授权。
- 本机有待处理输入／已锁存终端不确定性时，不能无提示移交。首版要求本机通过 supervisor 保留的控制手势明确交还控制（手势由固定 relay 消费，不转交 Pi），或启动时显式选择 remote-control 初始模式。
- 网页显式“取得控制”申请短期 writer lease；服务端 CAS 授予。第二个标签只能只读，不因刷新抢占；显式接管先撤销旧租约、确认新连接及清空未交付输入，再激活新 lease。
- 本机保留一个固定“收回控制”手势；触发后先 fence remote，再恢复 local。普通本机按键在 remote 所有时不缓冲、不转发，不自动抢占。宿主 SIGTERM/SIGHUP 不是按键，始终保留关闭语义。
- 断线、注销、撤销、写租约到期：立即 fence，丢弃未交付输入，所有者变 none，不自动给新页面/本机；用户明确重新取权。

### 不与聊天写入并发

- 远程 writer 激活期间，在 Pi adapter 中持有 runtime 级交互屏障：所有普通聊天客户端的 prompt/steer/follow_up、session/model/config mutation 等被拒绝；只读历史/状态保留。不能仅禁当前页面按钮；不能借此清除 revision unknown。
- 屏障通过固定 broker 与当前 adapter 的私有 IPC 建立，先成功设置再授予 writer；适配器不可达、reload 或身份变化立即 fence writer。失败部分不回退到“先写键再补锁”。
- session/runtime 身份变化撤销写租约，浏览器需看到新身份再手动取得控制；terminal.read 可在授权及新 snapshot 后继续。leaf 正常随 agent 执行变化不撤销 writer；leaf 不当作长期键盘操作的锁。
- 已执行终端命令可能仍在异步工作，writer release 不等于它已取消。首次终端控制后，旧 guard 的不确定性锁存继续存在；首版聊天的只读能力保持可用，但重新开启聊天写入需要实际完成证据；拿不到证据则本进程保持 `terminal_untracked`，提示继续用终端或明确退出/重启恢复，不靠 ACK/空闲/时间/reload 清除。
- 这个限制不是最终双界面无缝切换体验；若要在任意扩展操作后安全恢复聊天写入，需要 Pi 宿主公开的统一命令/对话生命周期完成证明，是独立 SDK 工作，不能在 Web 私自推断。

### 不削弱现有重启资格

- `web-terminal-v1` 在首次独立传输审计前，一律 `managedRestartEligible:false, reason:terminal_profile_unaudited`，由 supervisor 在 restart admission/preflight 和 Gate 的可信 profile 策略共同强制拒绝，不能只隐藏按钮或信任扩展自报；不能借“没有输入”沿用 inherited TTY 的审计结果。
- 以后若审计通过，非豁免的 stdin data 仍按原 guard 永久 taint；等待、退出面板、断线、reload 均不能恢复资格。guard 不是全终端效应监控：PTY line discipline 的信号／EOF、SIGWINCH、直接 fd 或 `/dev/tty` 读取、扩展自主后台活动不一定经过 stdin data。新 profile 从启动禁用 restart 是当前真正的保守边界。
- 首版不为该 profile 提供 Hub 安全重启按钮；正常 `/quit` 保留，后续管理员另行批准的新启动恢复原会话。不要承诺本功能上线就能同时实现任意终端交互后的自动更新重启。
- runtime/Gate 的 restart 与 terminal lease 在同一 run 互斥域，prepare 一旦开始就不可 attach 写入；cancel 不重放键，shutdown 不解锁给新 writer。即使首版禁用重启，也测试并发失败路径，防后续 profile 误用。

## 5. 数据契约（v1，首个开发切片只实现验证与状态机）

### 能力

浏览器能力必须由 Hub/provider 核实，不由普通 Pi 自报即授权：

```ts
type TerminalTarget = {
  v: 1;
  runId: string;               // 32 hex，由当前 grant 解析
  runtimeId: string;
  sessionId: string;
  terminalEpoch: string;       // 32 hex，真实 child 一代
  profile: "web-terminal-v1";
  inputState: "local" | "none" | "remote" | "fenced";
  managedRestartEligible: false;
};
```

target 不是可执行目的地，不含 token、PID、socket、容器名、路径或输出正文；unknown profile/version/字段类型拒绝，不默认为可用。

### 建连

1. terminal origin 认证后获取当前 target；`POST /api/terminal/attach` 要求同源＋CSRF、target tuple、mode read-only；由 Hub 解析 grant 到 provider。
2. 响应短期 attachId。它不是独立 bearer authority，始终绑定 terminal session、连接和 target；不放 URL token。
3. WS 握手不以 cookie alone 授权输入。仅 exact terminal Origin/Host＋有效 terminal session 可建短期未认证 WS，2 秒内首个 auth frame 提交 CSRF/attachId；最多 8 个待认证 socket，失败关闭，不返回目标/输出。
4. 每帧及在途异步完成重核授权 epoch、target 与 lease；撤销主动关闭，不能只在握手检查一次。

### 输入与输出

```ts
type TerminalInput = {
  v: 1; type: "input"; terminalEpoch: string; leaseId: string;
  sequence: number;            // 当前 lease 从 1 开始严格连续
  data: string;               // 服务端按 UTF-8 最大 8KiB；不记录原文
};
// 实际实现还必须绑定 Hub session/socket/run/runtime/session；不可只靠此帧字段。

type TerminalOutput = {
  v: 1; type: "output"; terminalEpoch: string;
  sequence: number; data: string;  // 不可信终端数据，UTF-8 流解码不能拆坏字符
};
```

- input 校验成功只表示获准尝试写 PTY；ACK `written` 也只表示字节交付，不代表命令执行或记忆提交。
- 重复、乱序、错 lease/epoch、旧连接、超限直接 fence；输入**不自动重试**。断线不确定时显示“可能已输入，请查看终端”，不能重放 Enter/Yes。
- 不持久化键、终端输出或确认预览；仅审计 who/target/attach/lease时间、字节计数、结果类别，避免日志泄露 token/秘密。
- 上限：每 child 最多 2 reader／1 writer，每帧输入 8KiB、输出 32KiB，每连接输出队列 256KiB、broker 解析积压 1MiB，screen 最多 240×120／滚动历史最多 1000 行／序列化 snapshot 最多 1MiB。最终值可在隔离测量后收紧，不因超限静默丢字后继续假装一致。
- 输出慢客户端被关闭，不阻塞 PTY/本机显示；broker 自身超过解析积压则终端能力 unavailable、撤销 writer，Pi 仍存活且继续排空输出。

### 重连和尺寸

ANSI delta 缺失不能靠任意最后几 KiB 重放修复。固定 broker 从 child 启动即维护 headless 终端状态，初次/重连发送**同一序列水位的完整序列化 screen snapshot**后继续 delta；输出通道在 snapshot 边界串行化。超限、解析器重启或历史丢失则拒绝可交互 attach，不自动发 Ctrl+L 猜测修复。

本机控制终端关闭仍优雅关闭 child/supervisor，不因网页还在线就静默后台常驻。新 profile 下 Ctrl+C 必须由 PTY line discipline/前台进程组传递给真正 child；SIGTERM/SIGHUP 仍由 supervisor 按关闭契约转发，不能照抄当前 inherited TTY 的 SIGINT 假设。退出时恢复本机 raw mode、尺寸和文件描述符。

窗口由当前 writer 决定，readers缩放/滚动不能反复修改同一个 PTY；无 writer 使用启动时固定尺寸。resize 范围 20..240列、5..120行，节流，使用 TIOCSWINSZ/SIGWINCH 正常机制，不伪造 SDK 私有渲染调用。中文/emoji 与 UTF-8 decoder、全屏/regular、IME 是实际验收，不靠 frame 存在认定正确。

## 6. 为什么不选其他主方案

- **每扩展各写 Web 面板**：无法覆盖新装扩展；只作为少数高频功能的增强。
- **全局替换 `ctx.ui` 或 private runner**：不是公开稳定接入点，破坏取消和第三方生命周期，不采用。
- **全部迁 RPC**：标准对话可用但 custom TUI 仍缺失；也改变现有启动、交互和守卫证明，不作为本轮主路径。
- **聊天 origin 内放网页终端**：把能批准记忆、修改 MCP/运行 shell 的输入权限暴露给聊天侧脚本，不采用。
- **管理 origin 直接复用任意终端输出**：违反当前管理面只运行可信内容、不代理 Pi 流的设计；本轮使用第三 origin，避免捆绑扩大旧授权。
- **另开第二个 Pi 或 docker exec shell**：不是同一个确认/面板，不能解决等待中的操作；也会引入无关 shell 权限，不采用。

## 7. 最小实施顺序与权限

### M1：包内契约与确定性围栏（可先开发）

仅新增未接入产品的 schema/lease 状态机及合成 tests，不开网络 listener、不读真实终端、不变更 SDK、guard、supervisor 或 memory。验证身份、单 writer、sequence、撤销/超时、冻结和断线不重放。这些通过只能证明状态机，不代表终端可用。

初始切片：`hub/terminal-contract.ts`、`hub/terminal-lease.ts`、`tests/terminal-lease.test.ts`。模型使用单调时钟，lease 固定 30 秒、操作入口惰性检查过期、不因输入自动续期；模型不会检测断线或设置后台定时器，未来宿主须在授权撤销/到期/断线时主动调用 revoke/freeze 并关闭连接。`consume()` 只消耗序列并返回字节，不写 PTY、不证明权限、不提供执行 ACK；真实 sink 必须在实际写入前重核连接、授权和 lease，丢弃已撤销的在途数据。此切片没有 local 字节转发能力，也不实现网络握手、屏障或身份变化侦测。

### M2a：仓库内最小真实 PTY 验证（无需 Gate 或新依赖）

使用 Python 标准库 forkpty 启动隔离测试 Pi，测试原生确认预览、拒绝/批准的合成副作用、custom 面板方向键/确认/取消、resize、测试连接失效不重放及退出清理。同 PID 的真实 TUI 是目标；不是热附当前 Pi，不加载个人扩展，不接 Hub、不改 SDK/guard/supervisor。不以测试程序发送合成 Yes 作为真实人工授权证明。

已增加 `e2e/harness/isolated-pty.py`、`test-isolated-pty.py` 和 `e2e/fixtures/pty-ui-extension.ts`；范围与实测见[隔离 PTY 验证](../validation/isolated-pty.md)。这是终端基础链路试验，不是产品 broker：测试连接只是进程内句柄，没有网络、认证、实际本机 relay、screen snapshot 或产品输入接口。

### M2a 后续：真实私有 transport 试验（仍未接产品）

`e2e/harness/pty-transport.ts` 复用现有 TerminalLeaseState，增加仅临时本地Unix socket（目录0700/socket0600、独立read/write随机凭据，仅返回测试调用方，不打印）。固定Python worker通过私有JSONL pipes持有唯一隔离Pi PTY，重核epoch/lease/sequence/期限后单次写入，原始输出base64转发。没有普通聊天mirror，因此未实现adapter交互屏障，也不可直接接生产Pi。

真实socket断开同步撤销broker模型，删除独立lease标记；worker在sink准入检查读取该标记，修复FIFO撤权消息落在输入后面的排队窗口。检查已经通过到单次os.write的并发窗口属于in-flight/unknown，不承诺能撤回；不自动重放。后继grant必须等sink revoke ACK，不能仅凭租约模型已none恢复输入。此fixture文件标记不是生产跨容器授权方案。

attach明确 `screenAvailable:false`，不重放输出尾部，不把ANSI字节当HTML或完整screen。测试覆盖真实断线、30秒固定期限、暂停在sink检查前撤权、SIGSTOP worker关闭等；详见[实际连接验证](../validation/pty-transport.md)。worker停滞先EOF，再有界TERM/CONT清理，未清理完成必须报错而不是伪装成功。生产信号/不可中断进程和逃逸后代仍需runtime设计。

### M2a 后续：完整画面与只读浏览器 fixture（已本地验证）

固定安装 headless / browser xterm 6.0.0、serialize 0.14.0，禁安装脚本，保留既有锁条目。新增 `TerminalScreen` 持续解析真实 PTY 输出；`startPtyTransport({screen:true})` 经 startup barrier 等完整 prefix 解析后才开放 attach，resize geometry 走同一 worker 输出管道，capture／write／广播串行水位。默认 raw 模式仍不能恢复 screen。

screen 模式只发完整 framebuffer，不混原始 delta；客户端每帧新建 terminal，避免把缺失 pending UTF-8／CSI 的快照当完整 parser checkpoint。serialize 实验性，已有缩窄折行 cursor 偏一列的回归记录，不承诺任意状态完美恢复。浏览器仅是只读 fixture，选取真实 frame 注入后检查公开 buffer 并实际查看桌面／手机截图；不是实时 WebSocket 产品或已落实 terminal origin／授权。OSC/自动response不回输PTY，不启链接／剪贴板 addon。

Pi1.1/1.3 screen专项各3/3，完整单元562项（561 pass/1 skip）。手机仍原列宽横向滚动，emoji缺字；新screen并未接Hub listener。完整证据与未测边界见[画面验证](../validation/terminal-screen.md)。

### M2a 后续：独立隔离网页与受控输入（已本地验证，非产品 M3 接线）

`e2e/harness/terminal-browser-server.ts` 新建测试专用 loopback origin，用真实 HubTerminalAuth／临时 run grant 绑定唯一测试 Pi，复用私有 Unix transport。网页不持 Unix凭据或任意路径，显式配对→连接→既有write授权内申请单writer→通用按键／草稿文本，不设专用批准键、不转发xterm自动response。每帧／动作及100ms主动检查授权，撤权即destroyUnix触发真实sink marker fencing。

页面默认只读，无自动连接／重连／控制／重试／续租；30秒固定lease、单在途操作，输入已发送后的主动释放／hidden也保留unknown；written不代表执行完成。已跑Pi1.1/1.3各10项真实Browser+WS+PTY，验证原生confirm拒绝/custom、只读、多标签、到期、在途撤权／release／hidden／timeout、最大JSON转义输入与cross-origin SW／frame／opener。桌面／手机截图已实际查看。

这是独立origin方案的隔离验证，不是生产provider、trusted identity、adapter屏障或手机完整兼容性认证；同host不同port不隔离Cookie，公网还需独立hostname+Secure/TLS。本轮不改 `hub/terminal-server.ts`，产品仍backend unavailable。详见[网页终端验证](../validation/terminal-browser.md)。

### M2b：受管 runtime/provider 集成（单独授权）

需要兼容现有 pirun/supervisor 时，再在其可编辑源码实现 opt-in PTY/broker/profile 及固定 provider；Gate 可继续只做部署审批。先明确终端流的实际所有者，不预设复用 Gate。screen renderer/headless 如需要新增依赖，先审核固定版本并经许可安装。不得覆盖镜像内 `/usr/local`。独立验收本机/远程交接、Ctrl+C/关闭、resize/重连、profile/restart admission、screen snapshot一致性和原 guard 不弱化；不把 M2a 测试当作这些边界已完成。

### M3：产品独立终端 listener与手机入口（仍待生产接线）

接入 terminal独立认证、session/lease/WS、固定静态页面，聊天只提供非特权跳转；真实Browser验证恶意聊天HTML/SW/opener不能读取/写入/配对终端，OSC/自动report不注入输入；桌面/手机、中文IME、网络中断、多标签/本机抢控。

**先行切片（本地已实现）**：因 M2 外部源码不可见，先实现不依赖 PTY 的 Hub 配置、第三 listener 及独立配对权限，仍在同一 WebUI 包／Hub 进程。`terminal?:{port,publicUrl?}` 缺省不监听，local/public origin均与chat/admin交叉检查，公网terminal URL必须HTTPS。只有 `GET /api/terminal/status`、同源 `POST /api/terminal/unlock`／`logout`；status始终 `available:false, reason:terminal_backend_unavailable`。没有页面、输出流、attach、WS/CONNECT或输入路径，不制造假终端。

认证为独立state/cookie/session/CSRF/epoch，30分钟cookie，会话绑定精确run/runtime/session/terminalEpoch及read|write；只读不能升级写。可信CLI `pair-terminal` 显式传入scope、生成10分钟单次码；这只能证明管理员选择的scope及现有grant未撤销，**不证明目标child存活或具备PTY**。终端网关自动登录尚未实现，不能套用已有management.gateway。签发／兑换／撤销共享跨进程事务锁；碰撞明确失败，不自动重试。崩溃残锁须管理员确认所有相关进程停止后处理，不按PID/年龄抢锁。

此auth切片尚未调用租约模型，也不实现连接撤销推送；每次HTTP读取/操作重核session/epoch/grant。未来接输出流前必须增加主动撤销、provider身份证明、绑定及sink侧重核，不能把当前HTTP认证绿测当成流式终端验收。

### M4：原扩展兼容与小范围启用

真实 Pi 1.1/1.3、合成标准 dialogs/custom component、记忆独立临时存储、MCP无真实凭据fixture，验证原预览与同一进程。之后才分别申请 push、Hub/Gate发布、新runtime镜像、独立DNS/TLS/隧道、安装、单个容器迁移；这些不是用户本次设计/本地开发的隐含授权。旧运行中 Pi不能在线加PTY；迁移必须明确确认退出并恢复准确会话。

## 8. 验证状态与待决事项

### M1 实际验证（上轮切片）

- `NODE_OPTIONS='' node --import ./tests/register-ts.mjs --test tests/terminal-lease.test.ts`：12/12。包括精确字段／UTF-8预算、身份四元组、local让出／收回、单writer、连续sequence／replay、旧connection／authorization隔离、撤销、新lease、精确deadline、时钟异常、freeze及防御性复制。
- 完整 `NODE_OPTIONS='' npm run test:unit`：521项，520 pass／1条件skip／0 fail。原始日志 `/tmp/pi-terminal-contract-unit.log`。
- 前端与连接两套 TypeScript检查通过；`npm run check` 检查258文件，0 error／既有30 warnings／1 info；`git diff --check`通过。
- `NODE_OPTIONS='' npm run build:web`、`npm run verify:dist`通过，新增 dormant hub源码进入source inventory，仍有既有大chunk提示；版本保持1.0.1。构建hash对应性不代表真实性或新终端可用。日志 `/tmp/pi-terminal-contract-{build,biome}.log`。
- 首次定向运行因Node strip-only不支持参数属性而失败，已改成普通字段赋值；首次类型检查因项目ES2022 lib不声明 `isWellFormed` 失败，改用Unicode surrogate类别拒绝孤立代理项，定向／完整／types均已重新通过。未通过安装依赖或改编译器消除错误。
- 独立只读代码复核在新增契约／状态模型范围未发现可证实缺陷，未运行测试；不覆盖未来网络、PTY、sink或真实权限。
- M1没有新增UI／产品WebSocket可见状态，未运行浏览器/截图/真实Pi终端E2E。没有安装依赖、提交、推送、生产Gate申请、reload、重启或部署。当时模块无产品调用方；后续auth切片复用schema，lease模型仍未接线。

### M3 先行 auth/listener 切片实际验证

- `NODE_OPTIONS='' node --import ./tests/register-ts.mjs --test tests/hub-terminal.test.ts tests/terminal-lease.test.ts`：37/37（本轮新增25项）。真实临时Hub／HTTP验证第三origin、禁代理/Upgrade/CONNECT/worker、Host/Origin/CSRF、关闭中的请求与socket、监听失败清理和default-disabled。包含配对scope/只用一次/过期/拒绝/撤权、独立Cookie/read-vs-write/四元组，以及真实构建CLI init/pair/revoke。
- 独立复核发现并修复两项P2：原子rename不足以防CLI撤权被旧epoch回写；已撤权session仍占满64名额。加入共同跨进程事务锁及容量前清理epoch/grant失效项。测试子进程在文件读取同步点发起竞争撤销，覆盖正确/错误码和CLI issue；64session后不触碰旧cookie直接重配。复审确认根因在限定范围被覆盖，未自行运行测试，也未穷举进程调度。
- 完整单元546项，545 pass／1条件skip／0fail；两套TypeScript、build/dist、diff whitespace通过；Biome262文件0error，保留30warnings／1info。原始日志 `/tmp/pi-terminal-auth-{targeted,unit,build,biome}.log`。
- 测试首次尝试用Node fetch伪造Host未实际发出该Host，断言失败；改用真实 `http.request` 后仍验证必须403，没有放宽产品Host检查。中间测试import被格式器转成type-only导致ReferenceError，恢复value import并全套重跑。新增源码未引用或修改安装中的runtime/SDK/memory。
- 本轮无浏览器UI/可见WS状态修改，未做Browser视觉或浏览器跨origin/SW/opener验收；没有真实Pi PTY、手机输入、网关TLS或生产部署验证。没有安装依赖、提交、推送、申请Gate、reload或重启；版本仍1.0.1。仅临时测试Hub启动并已关闭，生产配置没有terminal字段，运行行为不变。

本文件的源码检查支持设计选择，**没有执行完整新增终端产品验证**。上一轮数学/等待提示的绿测不是本方案证据。独立只读架构复核确认新增 profile 方向可行，但强调 no-PTY 旧裁决不能解释掉、必须双执行点拒绝 restart、guard 不能覆盖所有终端效应；以上已纳入本设计。该复核未运行程序或检查 Gate 源码，不是运行验收。

进入生产 runtime/provider 集成或浏览器终端前必须落实（不作为 M2a 本地试验前置）：

1. 若接入现有受管启动，提供 runtime 可编辑源码，确定固定 provider transport 的实际所有者和挂接点；Gate 源码仅在另行决定修改其集成时需要。不得从已安装文件反向直接覆盖生产。
2. 用户接受新增终端权限、第三 origin、显式控制交接，以及首版 terminal profile不支持安全远程重启/不保证自动返回聊天写入的限制；若不接受，需先做宿主SDK统一生命周期而非放宽守卫。
3. xterm 三个固定依赖已审核安装并用于隔离 framebuffer／只读 fixture；仍需解决实验性 serialize fidelity、预算／性能和真实浏览器授权输入集成，不能据此宣称产品终端可用。
4. 管理员选定公网 terminal hostname、网关身份/权限策略；文档不预先占用真实域名/端口或改路由。

设计的可逆点：默认关闭、旧 profile不变、无迁移即可保留全部旧行为。撤销 terminal scope立即断开终端，不影响普通聊天读取；不清理用户工作区/会话/挂载，不以回滚为名删除终端尚未完成的工作。
