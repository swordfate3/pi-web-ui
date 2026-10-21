# 隔离真实 Pi PTY 验证

日期：2026-10-19。范围：ADR 0018 M2a，仓库内基础链路试验；**不是网页终端或生产 runtime 验收**。

## 实现范围

- `e2e/harness/isolated-pty.py`：Python 3.11/Linux（内核支持 pidfd）标准库 `pty.fork()` 创建 controlling terminal，启动唯一测试 Pi；有界收集原始输出，测试句柄/序列检查、resize、子进程组清理。
- `e2e/fixtures/pty-ui-extension.ts`：仅测试 launcher 显式加载，原生 `ctx.ui.confirm` 和 `ctx.ui.custom`，只写临时 workspace 中的合成事件与 `approved.txt`。UI 输出仅 `setStatus/notify`，不替换 resolver、不开批准旁路。
- `e2e/harness/test-isolated-pty.py`：真实 TUI 按键验收；不调用 RPC UI response，不 monkeypatch SDK。

启动使用临时 HOME/agent/cwd、显式环境变量白名单、`PI_OFFLINE=1`、关闭扩展发现/skills/prompts/context/tools。只显式加载仓库 faux provider 和合成 PTY fixture；不加载当前用户配置、认证、MCP、memory、Web mirror 或 runtime guard。测试不发模型请求，不启动网络 listener，不使用生产凭据。

隔离意指配置和测试数据隔离，**不是 OS 安全沙箱或对恶意扩展的隔离**。faux 是本地合成模型，不是远端模型服务。此 launcher 不接现有 supervisor，因此没有现有安全重启机制，也不宣称新 profile 已获得重启资格。

## 可复现命令

从仓库根运行；只使用已存在的二进制，不安装：

```bash
python3 -B e2e/harness/test-isolated-pty.py
PI_E2E_BIN=/home/node/.local/bin/pi python3 -B e2e/harness/test-isolated-pty.py
PI_E2E_BIN=/home/node/.local/bin/pi PI_PTY_TUI_MODE=fullscreen \
  python3 -B e2e/harness/test-isolated-pty.py
```

本机前两种分别选择项目 SDK 1.1.0 和个人已安装 SDK 1.3.0；绝对路径是本机环境，不是普通克隆的依赖要求。

## 本轮实际结果

初轮三个组合各6/6；独立复核发现清理风险并修复后，三个组合均 **7/7 通过**：1.1.0 regular、1.3.0 regular、1.3.0 fullscreen。新增一项专门检验leader先退出与顽固同组后代清理。

| 验收 | 实际断言 |
| --- | --- |
| 原生确认 | PTY 输出包含完整合成预览起止标记、动作说明、中文和 emoji 字节；按方向键选择 No 后无副作用，重新打开并按 Enter 选择 Yes 后仅写合成文件 |
| 同一 Pi | 事件 PID 等于 forkpty 子进程 PID；真实 `mode=tui`、hasUI、stdin/stdout isTTY；会话/前台进程组为该 PID，stdin/stdout 指向同一 slave；确认与面板不另开 Pi |
| custom 面板 | Down/Down/Up/Enter 得到 BETA，重开 Esc 得到 CANCELLED；窗口改为64×24后，真实 render 观察到新 columns/rows |
| 拒绝路径 | 原生 timeout 和 AbortSignal 都返回未批准，不写测试文件 |
| 不重放 | 测试句柄断开后旧句柄不能发送 Enter；新句柄不自动发字节、不提交仍开着的面板；显式新 Enter 才提交，重复 sequence 被拒绝并 fence |
| 退出 | `/quit` 返回0并触发 shutdown，最终子进程 waitpid 回收、PTY master关闭；重复close不再发送信号；打开确认框时给测试Pi进程组SIGTERM，不产生批准文件并回收 |
| 后代清理 | 单独临时Python helper使用subreaper，真实fork leader和同组grandchild；leader先退出且保留未reap身份，忽略SIGTERM的grandchild最终由SIGKILL终止并回收 |

合成测试通过代码发送 Yes **仅验证测试 fixture 的真实 TUI 输入链路**，不是模型可批准真实记忆、安装、知识库或任意扩展操作的授权。

原始日志（临时产物，容器重建可丢失）：

- `/tmp/pi-isolated-pty-1.1.log`
- `/tmp/pi-isolated-pty-1.3.log`
- `/tmp/pi-isolated-pty-fullscreen.log`
- `/tmp/pi-isolated-pty-unit.log`：现有完整单元546项，545 pass / 1条件skip / 0 fail。

前端与连接两套 TypeScript（含新增 fixture）、Biome263文件（0error / 既有30warnings / 1info）、`git diff --check` 和 `verify:dist` 通过。仅修改测试/文档及测试类型检查入口，不改变构建清单输入，无需为本轮重新生成 dist；版本保持1.0.1。

独立只读复核发现1项P2：旧实现poll先reap leader、close重复向裸PGID发信号，存在编号复用误杀风险。已改用Linux `waitid(WNOWAIT)`观察退出、保留leader直至最后一次组信号之后才reap，关闭标志使再次close无副作用。回归测试同时核对重复sequence未增加PTY写入字节且连接被fence。复审又发现测试helper的两条异常清理风险：已reap后断言失败仍保留裸PID、helper超时被杀可遗留永久等待的后代。已将待清理身份在断言前清除；grandchild持有helper生命线pipe读端，helper死亡即EOF退出，并有10秒上限。外层pidfd仅观察该合成后代；针对复核发现的“helper打印PID后抢先reap”竞态，新增取得pidfd后的显式握手，并刻意延迟外层150ms再观察。normal/wrong-exit/hang三种子场景都实际通过，hang直接杀helper绕过finally。复核不等于独立执行；动态结果来自上述实际命令。

## 证据边界与后续

- 断线测试是**进程内测试连接句柄**的围栏，没有 WebSocket/TCP 断开、实际授权撤销、Hub session/lease 接入或 broker sink 重核。
- 输出测试是原始 PTY 字节/合成事件，不是屏幕截图、完整 ANSI 终端状态、snapshot 或重连画面恢复；有界输出尾部不能作为未来产品重放方案。
- 只有64×24的尺寸事件验收，不证明手机布局、IME 光标、中文/emoji 实际字形或任意面板适配。没有新增网页UI，不运行 Browser 视觉验收。
- 未测试真实 memory/MCP、实际人工确认、浏览器跨origin隔离、真实本机TTY relay/raw-mode恢复、Ctrl+C/EOF/SIGHUP语义、子扩展后台任务完成或外部编辑器。
- 清理只覆盖本次测试进程组：不追踪另行setpgid/setsid逃逸的后代。SIGTERM测试针对Pi组，不证明Python harness被杀、崩溃或清理被中断后的行为。未reap的leader用于固定信号目标身份，不将一个已释放的PGID继续当成所有权。
- 未接 runtime guard，不清 guard taint；本轮不能作为修改旧 no-PTY 裁决或开启新 profile 安全重启的证据。
- 本页记录M2a初轮。后续已补真实Unix socket/私有worker pipe、单writer与实际断线试验，见[真实私有终端连接](pty-transport.md)；没有因此补齐完整画面状态或浏览器入口。已有第三listener仍报告backend unavailable，不假装可用。

未安装依赖、提交/push、申请 Gate、修改生产配置/SDK、reload、部署或重启当前 Pi。
