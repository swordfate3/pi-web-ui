# 独立隔离终端入口与受控浏览器输入

## 结论与范围

本轮完成 **Browser → 真实 WebSocket → Unix socket → 私有 worker pipe → 同一个隔离 Pi PTY** 的双向集成。区别于上一轮把选定 frame 注入只读页面，这次画面与输入均走真实连接。代码仍是仓库中的测试 fixture，**不是已接入产品的终端入口，不是当前生产 Pi 的远程控制功能**。

- 唯一开发目录不变，没有新 worktree、项目副本、安装依赖或修改 SDK／个人扩展。
- 没有提交、推送、申请 Gate、改公网域名／TLS／代理、更新个人包或重启当前 Pi。
- `hub/terminal-server.ts` 完全未接流，产品 listener 继续 `available:false / terminal_backend_unavailable`。没有生产 provider、adapter 交互屏障、本机 relay 或 trusted child 身份验收。
- 终端读／写授权只由测试管理员对唯一合成 Pi 预先签发；网页“取得控制权”只在该已有写授权内申请单 writer，**不是可信人工授权来源**。没有真实记忆／MCP／其他扩展批准。

## 文件与边界

| 文件 | 职责 |
|---|---|
| `e2e/harness/terminal-browser-server.ts` | 临时独立 loopback origin、真实 HubTerminalAuth、固定 PTY target、HTTP／WS 边界与撤权检查 |
| `e2e/fixtures/terminal-browser-page.ts` | 固定中文 HTML／CSS，默认禁输入，桌面／手机换行控件 |
| `e2e/fixtures/terminal-browser-client.ts` | 显式配对／连接／控制、单条在途输入、unknown 锁存、完整 screen 串行恢复 |
| `e2e/terminal-browser.integration.ts` | 两版真实 Pi + Chromium + HTTP／WS／跨源／故障验证 |
| `e2e/harness/pty-transport.ts` | 仅新增 test-only `runId` 选项，绑定真实临时 run grant；默认行为保留随机 runId |

测试启动临时 0700 目录，用现有 `initializeHub / issueSession` 建真实 grant；再用该 runId 启动唯一合成 Pi，授权精确绑定 run/runtime/session/terminalEpoch 和 read/write。浏览器看不到 Unix 凭据、socket 路径、PID 或任意 command/path 参数。生产 Hub 的配置与入口不变。

## 协议与控制

### HTTP／WebSocket

- 固定静态路由 `/`、`/app.js`、`/xterm.css`、`/mono.woff2`，固定 `/api/status`、`/api/unlock`、`/api/logout`、`/ws`；未知路径／query 不做别名或代理，拒绝 Service-Worker 请求／CONNECT。
- Host 精确匹配。POST／WS 必须精确同 Origin，跨 site 拒绝，无 CORS。所有 HTTP 返回 no-store、no-referrer、nosniff、COOP same-origin、CORP same-origin、CSP frame-ancestors none；脚本／字体／连接限制同源，未开放任意外部内容。
- 配对使用原 HubTerminalAuth 的单次码、HttpOnly SameSite=Strict Cookie、session epoch／run grant／scope。未登录状态下发启动级 bootstrap CSRF，用于首次 unlock；登录后改用 session CSRF。码不进 URL、storage 或日志，提交后清空文本框。
- POST 仅 JSON、Content-Length ≤1024、禁 transfer encoding，2 秒读取期限，按完整 byte buffer 严格 UTF-8 decode。WS attach 也必须携带 session CSRF，两秒未完成即关闭。
- WS 连接最多 3 个、HTTP 连接最多 32 个；WS encoded message ≤64 KiB（容纳最大 8 KiB decoded 文本的最坏 JSON 转义），decoded PTY input 仍 ≤8192 bytes；输出 bufferedAmount／单 frame 发送预算 256 KiB，有界失败关闭，不截尾伪装完整画面。
- 每个动作、每个输出和 100 ms 主动 timer 重新核对原 session／epoch／run grant／target。fixture revoke／logout 立即重新检查；授权失效 destroy Unix socket，引发 broker 同步删除独立 sink lease marker。已过最后 sink 准入线性化点的输入仍可能 in-flight，不承诺撤回。

### 显式输入、断线与未知

1. 页面启动仅读取状态，不自动连 WS；配对后也须点“连接终端”。
2. 默认只读。已有 write scope、真实 attached、画面可用且恢复首帧后，才允许手动申请控制权。
3. 控制 grant 固定 30 秒，不因按键续期；网页约提前两秒禁输入，服务端／sink 独立过期，不相信网页计时器。只允许一个 writer，其他标签被拒绝后不自动重试。
4. 文本只从 textarea 点击“发送文本”发送，不附加 Enter；Enter 在 textarea 只是草稿换行。固定按键也必须点击按钮，不订阅浏览器键盘／xterm onData/onBinary 为 PTY 输入，不转发自动 terminal response。
5. compositionstart/end 期间禁发送；粘贴只进入草稿。不是实体设备中文 IME 认证，仅测试组合事件触发禁用的逻辑。
6. 一个动作在途就禁后续按键，不排队、不重放。written 只表示实际字节交付 PTY，不表示原命令／扩展副作用执行完成。
7. 释放、断开、页面 pagehide／hidden、撤权、错误和期限均关输入、清草稿／画面并关闭 WS。重新连接和申请必须再次显式点击。
8. **即使用户主动释放／隐藏页面，也不能抹除已发送输入的未知结果**。input pending 时任何这类断开均锁存“输入交付未知，请检查终端；不要自动重试”；本页不提供清锁按钮。reload 只是重新加载网页，绝不证明旧操作取消／完成；生产全局 adapter 屏障尚未实现，不能把本 fixture 的页面锁存当作生产未知操作生命周期方案。
9. WS 代际／异步 restore 受 generation 保护，断线 dispose view；仅合并最新一个完整 frame、串行恢复，不接 raw delta。前轮 serialize fidelity／字体／性能限制仍适用。

## 实际验证

```sh
# 浏览器使用本机已有持久 Chromium 和运行库；环境路径由调用方提供。
NODE_OPTIONS='' node --import ./tests/register-ts.mjs --test e2e/terminal-browser.integration.ts
PI_E2E_BIN="$HOME/.local/bin/pi" NODE_OPTIONS='' \
  node --import ./tests/register-ts.mjs --test e2e/terminal-browser.integration.ts
```

Pi 1.1 与 Pi 1.3 **各 10/10**：

1. 真实 browser WS 输入 `/pty-confirm-normal`，原生完整预览，方向键选 No 并确认；没有 approved marker。原生 custom 面板下选 BETA，显式 resize、释放后重连恢复 BETA，再显式 grant／Enter 完成。事件 PID 全部等于测试 Pi，未换进程。
2. 桌面／手机真实连接画面；8193-byte 草稿拒绝但控制仍可用；textarea Enter 不发 PTY；组合事件期间禁发送；read grant 画面可见但所有写操作 disabled。
3. sink 最后准入前暂停 Enter，真实授权撤销关闭 WS／Unix，marker 撤销后释放暂停，原生确认没有批准或结果，页面 unknown 不重放。
4. HTTP 错 Origin／cross-site／Service-Worker、未知路径／query、缺 CSRF、WS 错 Origin／缺 attach CSRF／read 请求 control 均拒绝；真实 run grant 撤销后 idle reader 也被主动关闭，旧 Cookie 不能重连。
5. 真实第二 origin 的 browser 在拥有同一 context Cookie 的情况下仍不能 fetch terminal 状态、打开 WS 或嵌入 iframe；该 origin 注册并实际控制页面的 service worker 也不能跨 origin 接管终端，terminal origin 无 SW registration；跨源 opener 被 COOP 断开（`window.opener === null`）。
6. 两个真实 browser context 不共享 writer，第二方被拒；pagehide 释放后方可显式申请。真实等待约 30 秒到期，不续租、不自动重连，custom 没有被自动 Enter。
7. 在途 Enter 主动释放也保留 unknown，未批准。
8. 在途 Enter hidden 事件也保留 unknown，未批准。visibilityState 由测试显式设置／派发事件，**不是移动操作系统后台冻结测试**。
9. 真实 sink 等待超时引发连接冻结，网页 unknown 不自动重试。该异常用例不额外声称已经证明任意在途操作均未产生副作用。
10. 8192 个反斜杠／8192 个控制字符经两倍／六倍 JSON 转义仍收到实际 PTY 8192-byte written ACK；持有 lease 时 8193-byte decoded 输入被拒绝。畸形、>64 KiB 和第二条在途 WS 命令被关闭，服务端仍能返回状态，不排队后续 Enter。

每个浏览器 context 计数 `pageerror`（包括未处理拒绝），最终为 0。预期的 CSP／iframe／跨源网络拒绝不冒充页面崩溃。

回归：Pi1.1默认 raw transport **8/8**；完整单元 **562 项，561 pass／1 optional skip／0 fail**。前端／连接两套 TypeScript、Biome273文件（0 error／既有30warnings／1info）、`git diff --check`、`verify:dist` 通过。仅 e2e fixture／types/doc变化未进入产品 source inventory，本轮无需改 dist／package 版本；仍1.0.1。

原始临时日志 `/tmp/pi-terminal-browser-{1.1,1.3,unit,biome,transport-regression,input-budget,unknown,origin}.log`。测试结束关闭临时 browser／listener／worker／Pi／socket，未留下人工使用的服务 URL。

## Browser 视觉检查

临时 loopback `http://127.0.0.1:<test-port>/`，桌面 **1440×1000**／手机 **390×1100**，实际使用 Chromium，截图已逐张读取查看：

- `terminal-browser-confirm-desktop.png`：完整原生合成确认正文、中文、Yes/No 和通用按键控件；无网页专用批准按钮。
- `terminal-browser-panel-desktop.png`／`terminal-browser-panel-mobile.png`：实时自定义面板选中 BETA，控制状态／倒计时、文本框、方向／Esc／Enter／resize 控件可见。
- `terminal-browser-read-mobile.png`：只读状态明确，控制与输入禁用。
- `terminal-browser-unknown-desktop.png`：黄色 unknown 警告，画面清空，连接与输入禁用，不拿旧屏幕当当前状态。

截图在工作区 `downloads/pi-web-ui-visual-check/`（相对本报告 `../../../../downloads/pi-web-ui-visual-check/`）。页面控件在小屏换行，document 没有横向溢出；终端维持原始列宽，只允许 terminal 容器内滚动。长屏页面必须纵向滚动到输入区，**未宣称手机软键盘遮挡／单手可达已解决**。中文可读但沿用已有 Typewriter fixture 字体；emoji 仍缺字占位，未下载字体。截图是视觉证据，不自动证明 terminal 每个 cell／属性完美一致。

## 审查与修复

独立只读复核发现 P2：原先 WS16KiB 上限容不下合法8KiB文本的JSON转义；提高 encoded-frame预算到64KiB同时保留 decoded8KiB，两种最坏输入真实 ACK、超预算拒绝、畸形／overlap生存回归。限定复审确认原根因覆盖、无新增可证实must-fix。复审没有自行运行测试，也不是全工作树／生产安全认证。

开发中另修复：deliberate release／hidden 原先可绕开 pending-input unknown、本地 send 抛错前未置 pending、旧 restore unwind可能搁置新代 frame、连接握手无本地deadline、组合输入断开后的标记未清、正常动作后旧校验提示残留。针对在途释放／hidden／timeout 增加真实故障测试，不以 ACK／空闲解释旧副作用已排空。早期两个委派任务因上游响应中断无文件产出，未安装或改写用户资源；后端由主开发实现，前端另一代理完成后实际集成验证。

## 未完成／非证明范围

- 同host不同port是不同origin，**Cookie不按port隔离**。上述测试证明服务端Origin／CORS／CSP／COOP／SW边界，不证明生产hostname Cookie隔离；loopback fixture Cookie没有Secure，不能直接作公网部署模板。
- 初始scope由测试进程可信生成，不验证外部provider身份或当前Pi热附。没有真实聊天mirror，因此没有adapter交互屏障，不能宣称生产并发输入安全。
- 未验证慢消费者洪泛、持续大快照、解码总内存、服务worker／Pi不可中断／SIGKILL／宿主崩溃或逃逸后代；沿用前轮异常清理限制。100ms轮询撤销存在观测间隔，最后sink检查后的在途写无法原子撤销。
- 未确定性注入延迟restore跨generation；已有防御代码不是完整调度证明。最大输入ACK不是语义执行成功或输入内容完整业务效果证明。
- 未测试真实移动设备／Safari／网络切换／软键盘／OS后台、物理IME、当前个人扩展批准；没有自动网络重试。
- 生产前仍需 runtime/supervisor可编辑源码、从启动即PTY的明确迁移许可、可信provider+本机relay、两侧restart admission拒绝、真实第三hostname/TLS与主动授权失效、adapter unknown屏障；不从测试server直接接当前运行会话。
