# 隔离终端 framebuffer 与重连画面验证

## 范围与状态

本轮把隔离测试 Pi 的真实 PTY 输出接入持续存在的 headless parser，并增加只读浏览器画面 fixture。仍是同一个 `pi-web-ui` 仓库中的本地试验，**不是生产终端入口**。没有接当前运行中的 Pi、Hub terminal listener、真实扩展授权或个人配置，没有重启、提交、推送、申请 Gate 或部署。产品版本保持 1.0.1；本地 dist 因源码 inventory / package 变化重新构建，不代表已发布。

## 依赖和持久化

经本轮继续开发确认，固定安装三个 MIT 包：

| 包 | 版本 | 用途／声明 |
|---|---|---|
| `@xterm/headless` | 6.0.0 | 服务端 parser，runtime dependency |
| `@xterm/addon-serialize` | 0.14.0 | ANSI framebuffer snapshot，runtime dependency |
| `@xterm/xterm` | 6.0.0 | 只读浏览器 fixture，dev dependency；未来可编入静态页面 |

安装使用 `--ignore-scripts --save-exact --no-audit --no-fund`，没有执行安装脚本，也没有升级其他包。独立安装根为 `$HOME/.local/share/pi-web-ui-terminal-deps/`，项目 `node_modules/@xterm/*` 链接到该根。实际复核 `$HOME/.local` 为 `pi-runtime` ext4 卷，约 424 GiB 可用；项目本身位于持久 bind。完整 lock 保留 registry URL 和 SHA-512 integrity；对比安装前备份，所有既有非根 lock entries 逐项不变，仅追加三个包并更新根声明。不是全面供应链／漏洞审计。

浏览器测试复用已经安装的 Chromium，以及既有 KaTeX Typewriter 字体，不下载浏览器或字体、不进行宿主字体安装。三包上游元数据同指向 commit `f447274f430fd22513f6adbf9862d19524471c04`，这不是安全认证或恢复可靠性证明。serialize 上游仍标记实验性。

## 数据路径与一致性

```text
唯一隔离 Pi TUI → PTY master → 私有 worker JSONL pipe
  → Node 串行 TerminalScreen → 完整 ANSI framebuffer
  → 已认证测试 Unix socket reader

选择的真实 framebuffer → 隔离浏览器 fixture → 新 xterm 实例
```

- `hub/terminal-screen.ts`：write / resize / capture 同一串行队列，必须等 xterm write callback 解析完成；write / resize 才推进 sequence，capture 不推进。回调只证明输出被解析，**不是命令执行或扩展完成 ACK**。
- 每次 write 独立拷贝字节，跨 chunk UTF-8 / CSI 由持续 parser 维护。尺寸 20–240 列／5–120 行，scrollback 1000 行；单 write 32 KiB，pending 1 MiB／128 操作，序列化结果 1 MiB。超限或错误永久拒绝，dispose 立即拒绝 active / queued promise，不依赖可能被取消的 xterm timer。
- `startPtyTransport({screen:true})` 显式启用；默认 raw 试验仍 `screenAvailable:false`。启动 barrier 之前 worker 发完已收集的 startup prefix，Node 等 prefix 解析后才监听。startup buffer 若曾截断，拒绝启动，不拿尾部伪装完整屏幕。
- worker resize 后在同一输出管道发 geometry，再 ACK；Node 按接收顺序处理旧输出／geometry／新输出。首次 attach 的 capture、认证生效和广播都在同一 parser work 链，避免首次快照前先发 live frame。
- screen 模式只发完整 `screen`，**不混 raw delta**。更新合并约 50 ms；每帧可独立恢复。旧 parser 未结束 UTF-8 / CSI 不包含在快照内，因此消费者每次新建 terminal，以原尺寸恢复，不允许在该快照上续接原始流。
- broker 另有 1 MiB 待处理 output bytes 预算和每 peer 256 KiB socket 发送预算；大于发送预算的合法 screen 会断开 reader，不截断或假报可恢复。尚未为大屏／大量 history 做性能与洪泛验收。
- 吞掉标题、链接、剪贴板等敏感 OSC；`disableStdin`，不订阅 onData / onBinary 作为输入，不安装链接／剪贴板／图像／下载 addon，不自动 DA / DSR / Ctrl+L。不是任意 ANSI sanitizer，也不替代独立 origin／授权。
- 浏览器 fixture 只接测试选定的完整 frame，没有 WebSocket、真实 cookie、配对、终端输入或真实权限；新实例恢复避免残留 parser 状态。dispose 在 write 过程中主动拒绝 promise，不挂起。

## 实际测试

### 单元与构建

- `tests/terminal-screen.test.ts` **16/16**：真实 normal / alternate buffer roundtrip，cells／颜色／属性／cursor，受限 history，中文／emoji、split UTF-8 / CSI、resize、预算与永久失败、迟到 callback／dispose、OSC／query 不回送。部分故障通过局部测试 mock 注入，不冒称真实 OS 故障。
- 完整 `NODE_OPTIONS='' npm run test:unit`：**562 项，561 pass／1 optional skip／0 fail**。
- 前端和连接两套 TypeScript 通过，Biome 269 文件 0 error／既有 30 warnings／1 info，`git diff --check` 通过。
- `NODE_OPTIONS='' npm run build:web` 与 `npm run verify:dist` 通过；保留既有大 chunk 提示。manifest 是源码／产物 hash 对应性，不是安全或发布证明。

### 真实 Pi backend 与浏览器 fixture

```sh
NODE_OPTIONS='' node --import ./tests/register-ts.mjs --test e2e/terminal-screen.integration.ts
PI_E2E_BIN="$HOME/.local/bin/pi" NODE_OPTIONS='' \
  node --import ./tests/register-ts.mjs --test e2e/terminal-screen.integration.ts
python3 -B e2e/harness/test-pty-stream-worker.py
PI_E2E_BIN="$HOME/.local/bin/pi" python3 -B e2e/harness/test-pty-stream-worker.py
```

浏览器命令另通过 `PI_E2E_BROWSER_EXECUTABLE` / `LD_LIBRARY_PATH` 选择本机已有持久 Chromium 和运行库。无需把机器绝对路径写入源码。

- Pi 1.1 与 1.3：screen 集成各 **3/3**。包括中文／emoji JSONL 所有二段字节边界及逐字节流式解码；真实确认画面、独立 reader 首次 attach、断 reader 后进入 custom 面板再重连、选中 BETA、64×24 resize、事件 PID 等于唯一测试 Pi；screen 模式断线仍能 fence 暂停在最后 sink 准入检查前的 Enter，继任 lease 只能显式申请，未产生 approved marker。
- Pi 1.1 与 1.3：直接 worker 各 **7/7**。新增 startup prefix 在 barrier ACK 前、geometry 在 resize ACK 前的真实私有 pipe 断言；保留 EOF／TERM／schema／尺寸／partial deadline／sink fencing。
- Pi 1.1：默认 raw transport **8/8**，包含真实 30 秒固定 lease、sink paused disconnect 和 SIGSTOP cleanup；旧隔离 PTY **7/7**。不以这两组替代 Pi 1.3 screen 的专项检查。
- 浏览器对选定真实 frame 恢复后读取公开 buffer 核对标记，检查 dispose 不悬挂并保存桌面／手机截图。它不是 Browser→WebSocket→PTY 的实时产品 E2E，也未比较每一个 browser cell／属性，不能把 direct `page.evaluate` 注入 frame 当成生产连接证据。

原始日志：`/tmp/pi-terminal-screen-{1.1,1.3,worker-1.1,worker-1.3,raw-regression,base-pty,unit,build,biome}.log`。仅临时原始产物，容器重建可能丢失。

## Browser 视觉检查

检查的是临时 loopback URL `http://127.0.0.1:<test-port>/`；测试结束即关闭。视口 **1440×1000／390×844**。截图已实际读取查看，不仅保存或检查 DOM：

- `terminal-screen-confirm-desktop.png` / `terminal-screen-confirm-mobile.png`
- `terminal-screen-panel-desktop.png` / `terminal-screen-panel-mobile.png`

原始文件在工作区 `downloads/pi-web-ui-visual-check/`（相对此报告 `../../../../downloads/pi-web-ui-visual-check/`）。桌面可见完整确认预览及 Yes／No、custom 选中 BETA；中文有字形，未出现遮挡按钮的覆盖层。本轮复用已安装等宽字体改善初始 fallback 的过宽字距。

**手机还不是最终交互方案**：保持原列宽、容器内横向滚动，右侧长行初始不全可见；页面已明确提示横向滚动，不宣称自动适配列宽或所有预览一屏可读。现有环境缺 emoji 字体，鲸鱼仍显示缺字占位；解析／传输中原码点保留不等于字形已正确渲染。未验证实体手机、Safari、IME、软键盘、手势滚动或连续全帧重建的性能／可访问性。

## 审查与失败尝试

独立只读复核发现测试 client 逐 chunk `toString("utf8")` 会损坏分片中文／emoji；已改每条连接一个持续 `StringDecoder`，新增所有字节边界与逐字节完整对象比较，限定复审确认根因覆盖、无遗留 must-fix。复审未自行执行测试，动态结果由主开发命令提供，不当作全树安全认证。

首轮错误调用不存在的 `npm test`，随后改文档中的 `test:unit` 并完整执行；首轮连接类型检查发现 ES2022 没有 `findLast`，改显式 reverse/find，不升级编译器。首次 Biome 仅新文件格式错误，定向修复后通过；package / hub source 改动使旧 dist inventory 验证如预期失败，按完整 build:web 重建后再核验，未只改 manifest 伪装产物。

## 已知边界／后续

1. serialize 0.14.0 在长折行内容缩窄后可能恢复 cursor 偏一列，已用回归测试记录，不能声称任意状态完美恢复。全帧策略规避 partial parser 衔接，不修复 addon 本身的 fidelity 问题。
2. 每次新建 browser terminal 是可靠性验证策略，不是完成性能／focus／滚动位置／无闪烁的产品策略。
3. pending bytes 不是总内存上限：未结束 OSC／DCS 使用 xterm 自身约 10 MB payload 限制；serialize 先生成字符串再检查预算。
4. startup 截断的拒绝分支、持续输出 backlog 下首次 attach 的确定性竞态、洪泛／慢 reader／大快照尚未直接故障注入；startup barrier 不是扩展执行屏障。escape-set 字形覆盖也不是完整终端兼容认证。
5. 真实 terminal origin、主动权限撤销、trusted child/provider 身份、本机 relay、adapter 交互屏障、生产 profile／restart 拒绝仍未实现；Hub status 继续 backend unavailable。不能直接把测试随机凭据或文件 marker 接生产。
6. 并发撤权最后 sink 检查后仍可能 in-flight／unknown；不撤回承诺、不重放。旧 unknown 不会因 parser 空闲／lease 释放而解除。
