# 工作区附件上传验证

## 范围与状态

在 `main@11eba89` 上实现通用文件／图片附件落盘。开发与测试使用隔离目录、独立真实 Pi／预构建 Hub 和 faux provider，不读取真实用户对话／凭据、不操作生产服务。代码实现与生产部署分开；本轮没有自动更新启用包、重载当前 Pi、重启现有 Hub 或改变阿里云链路。

源码、匹配的预构建 `dist/`、本地功能与视觉验证已完成，改动留在未提交工作树。不能将某层通过解释为其他层通过；本轮未执行需要 npm 安装的生产安装生命周期，也未上线。

## 最终验证汇总

| 层级 | 本轮最终结果 |
| --- | --- |
| Node 单元／逻辑／本地 HTTP／IPC | **213/213 通过**，含 31 项分发清单与 13 项上传客户端／scope 测试 |
| 真实 Pi 后端，离线 tarball 解包 runtime | **15/15 通过**，包括精确 50 MiB 直连／Hub、compaction 与真实异步拒绝 |
| 真实 Pi 浏览器，离线 tarball 解包 runtime | **60/60 通过**，3.8 分钟；七项上传场景、四组中文下载及两组 Hub resume 均通过 |
| Python gateway | 16 项中 **15 通过、1 条件跳过**；未运行可选真实 Caddy 集成 |
| 前端 TypeScript／构建／Biome | `build:web`、`check` 通过，检查 174 文件，Biome 无警告／错误 |
| 连接与新增 E2E／客户端／scope 类型 | 严格检查 **0 diagnostics**；复用既有 `@types/ws` 路径映射，见环境边界 |
| source/dist、离线 pack、Node-only 校验 | 通过；128 源输入、673 输出，702 tarball 文件、4,891,126 压缩字节、25,243,809 解包字节 |
| 安装生命周期 | **未运行** npm Git install/update/tarball install，不冒充生产安装结果 |
| Browser 可见检查 | 最终包桌面 1440×900、手机尺寸 390×844 的选择／进度／取消画面已直接查看；不是实体手机验证 |
| 独立源码审查 | 后端提前消费与前端三项 P2 已修，复核限定快照未发现剩余可证实问题；不保证无缺陷 |

完整后端和浏览器命令均使用：

```sh
LC_CTYPE=C.UTF-8 \
PI_E2E_RUNTIME_DIR="$PWD/.tmp/upload-release/package" \
PI_E2E_BIN="$PWD/node_modules/.bin/pi" \
  <后端 Node 命令或 Playwright test -c e2e/playwright.config.ts>
```

Pi peer 和测试框架来自已有开发环境；被测扩展／静态页／Hub CLI 来自解包 runtime，里面只复制已有 `ws`，没有源码或开发依赖回退。该方式证明打包内容可运行，**不证明 npm 或 Pi 安装／更新生命周期**。SDK 接收拒绝集成也显式使用该 runtime 的扩展路径。

## 验收与证据

- 每文件 50 MiB、最多选择 5 附件；中文名和原字节保留，零字节合法。
- 保存到当前工作区 `.pi-uploads/<session>/<upload>/<filename>`；路径由服务端生成，不覆盖或穿越目录；会话切换使旧授权失效。
- HTTP 流式上传，聊天只传收据／路径；17 MiB 二进制证明不依赖 16 MiB WebSocket 大帧。
- 失败、取消、断连处理有明确结果；部分文件清理，已完成文件保留；不自动重放 Pi 提示。
- UI 展示附件、进度、取消、错误；真实 Pi 按服务器生成的路径调用 `read`。
- 直连与 Hub 分别验证；桌面／手机尺寸视觉检查是独立证据，不等于实体手机或公网部署验证。
- 新后端模块纳入 source/dist inventory、安装拒绝负例与 tarball 必需项，生产依赖仍仅 `ws`。

### 后端与接收确认

主代理在接收确认修复后运行：

```sh
node --import ./tests/register-ts.mjs --test --test-timeout=70000 \
  e2e/portable-connection.integration.ts e2e/session-hub.integration.ts \
  e2e/date-history.integration.ts e2e/file-download.integration.ts \
  e2e/file-upload.integration.ts
```

**15/15 通过**。包含真实 Pi 直连和预构建 Hub 的精确 **52,428,800 字节**上传、原字节核对和路径-only 消息；另包含真实 compaction 拒绝后同一收据可重试、凭据解析失败预检拒绝，以及 `input` 阶段移除合成 provider 后真正发生 Pi 异步拒绝。最后一种不能回报成功，也不能自动重发。

独立后端审查发现 Pi `sendUserMessage()` 返回 `void` 但实际异步失败，旧实现会提前消费收据。修复为异步 preflight 前原子预留、精确匹配当前 scope 的 user `message_start` 后确认；8 秒未确认则明确状态未知并保留禁止重发状态。ACK 仅证明用户消息已进入 agent loop，不保证后续模型生成成功。

### 浏览器阶段记录

真实文件选择器，原始 PNG／中文 TXT／17 MiB 二进制；CDP 仅限制上传速率以看见进度，不 mock HTTP、WebSocket 或 Pi 工具。首轮新增场景 **3 通过、2 失败**：

1. 目录 symlink 在 PUT 阶段而非 prepare 阶段拒绝，修正错误的“0 PUT”测试假设。
2. Playwright 内存 picker 自身拒绝超过 50 MiB buffer；改用真实稀疏文件验证 50 MiB + 1 字节的 UI 拒绝，不改变产品上限。

修正后这两场景 **2/2 通过**。另加真实第二网页 `/new` 取消旧上传：开始的“应有两个 JSONL 文件”断言错误（空会话延迟写 JSONL），改比真实 `state_sync` 身份后 **1/1 通过**；已经完成的两文件仍保留，未发旧附件 prompt。

随后完整浏览器初跑 **54/58 通过**；四组已有下载场景均收到 `download` 而非中文文件名。独立调查用同一 Chromium/HTTP 响应对比确认，原因是运行进程 POSIX locale 而非上传改动；`LC_CTYPE=C.UTF-8` 下四组 **4/4 通过**，非 UTF-8 下四组重复失败。未更改下载业务逻辑或放宽断言；CI 与测试说明显式设置 UTF-8 进程 locale。

此轮也触发独立前端审查，三项 scope／handoff 缺陷已修并补回归：旧请求失败写入新会话状态、handoff 期间 form drop 可添加文件、跨 scope 提交锁误将新提交当成功。使用 scope/attempt token、输入按 scope 重挂载、上下文 add/remove 锁及迟到状态写入防护；独立复核未发现这三项的可证实遗漏。逻辑测试不冒充 React 实际接线的动态覆盖。

又增加“两个文件已保存后取消第三个，再重试只重传第三文件”场景 **1/1 通过**。最后重新构建、解包并使用 UTF-8 locale 跑完整套件，**60/60 通过**，包含新增七项上传；先前失败尝试保留，不改写为从未失败。

### 分发验证细节

`npm pack --ignore-scripts` 使用已验证的最终 `dist`，解包后 manifest 与工作树完整一致。Node-only `scripts/web-dist.mjs --install` 校验通过；解包 runtime 仅复制既有 `ws`，Hub 构建 CLI `--help` 和随后完整套件通过。全源隔离快照依次修改 HTML、remote-access plan、Python gateway、Hub server、bin、Hub build config 与新上传模块，七类 stale-input 均被 Node-only 校验拒绝。

tarball 按既有契约不包含 `src/`，其 `--install` 验证输出哈希，而非完整源 inventory。本轮最初临时验证脚本错误期待无 `src` 的包仍检查 stale source，得到退出 0 后修正为全源快照负例；没有更改产品校验契约。分发 31 项测试覆盖其既有安全边界。此处不把临时脚本执行解释为真实 npm prepare 生命周期。

### 可见 Browser 检查

独立 Browser MCP 打开临时合成会话：`http://127.0.0.1:45961/s/<合成 generation>/`，使用最终离线包。桌面 **1440×900**、手机尺寸 **390×844**：

- 选择态可见中文 TXT、原 PNG、17 MiB 文件卡片及大小，草稿可读。
- 进度态有每文件状态、上传百分比和取消控件；保存路径单行截断并通过 `title` 保留全文，页面不横向溢出（手机 scrollWidth=390）。
- 取消后可见中文提示，三个附件和草稿保留，发送按钮恢复；没有新 prompt。
- 没发现附件区重叠、取消按钮离屏或不可读文字。1px 原图夹具本身是白色小图，截图不证明真实照片解码质量。
- MCP 在可见 Chrome 的首轮普通 click 稳定性等待超时，改用真实 DOM `click({force:true})` 后完成；完整 headless E2E 使用普通 click。最后补拍“完成态”时受 CDP 截图超时阻碍，没有最终完成态截图，因此视觉结论限于已直接查看的选择／进度／取消，不借工具读取成功替代该截图。

合成 Pi／Hub 服务已停止（临时端口不可达）。未关闭／操作用户的其他浏览器页，也未触碰真实在线四会话。

## 分发与环境边界

- 当前环境已有 Node 24.21.0、Pi 1.1.0、TypeScript 6.0.3、Vite 8.0.14、Biome 2.4.15、Playwright 1.61.1；没有为本轮安装依赖。
- 主工作树缺少已声明的 `@types/ws`。连接与新增 E2E 的严格类型检查通过 TypeScript API `paths.ws` 映射到同机既有 review worktree 的声明，保留项目 `typeRoots`；无声明伪造或安装。默认连接 `tsc` 的环境缺失仍需披露。
- 当前开发授权不包含新增依赖安装，因此不运行需要 npm 生产安装的 Git install/update/tarball-consumer 脚本；修改了相应回归入口不能冒充实际执行通过。收尾采用不安装依赖的 pack／Node-only prepare 校验，并单独报告结果。

## 已知边界

- 验证平台为 Linux 容器；无 Windows/macOS 文件系统验证。
- Hub 保留 30 秒 upstream socket 空闲超时、Node 默认约五分钟请求时限；上传授权十分钟。50 MiB 是大小上限，不保证任意慢网络成功；无断点续传。未知 Content-Length／chunked 请求拒绝。
- 外部 Caddy、登录网关、隧道、公网／实体手机没有本轮上传实测。没有改它们的超时／body 配置。
- 保存不等于文件已解析；不执行、解压、病毒扫描或清理持久文件；容器重建持久性取决于工作区挂载。
- `.pi-uploads` 是隐藏目录，既有下载安全策略拒绝它；聊天出现路径不会自动放宽下载权限。
- 不保证隔离同 UID／工作区管理员，未承诺持久磁盘配额或自动 `.gitignore`。
- 后端独立复核确认原提前消费问题已解决，限定快照未发现新的确认缺陷；未动态验证 dispatch 后被异步 `input`／`before_agent_start` hook 阻塞时再 reload。Pi API 没有撤回已经 dispatch 的异步提示能力；本轮 scope fencing 不能被描述为能撤回所有已交给 Pi 的工作。

## 原始产物

日志与已直接查看的最终截图归档在工作区产物目录：

```text
../../../../downloads/pi-web-ui-visual-check/workspace-uploads/
```

相对于本报告；不随 Git 克隆分发。主要文件：`pi-web-upload-{unit-final,backend-package,browser-final,build-final,check-final,types-final,dist-final,pack-final,python}.log`、初始失败的 `pi-web-upload-browser{,-all}.log`，以及 `upload-final-{desktop-selected,desktop-progress,mobile-progress,mobile-cancelled}.png`。完整浏览器原始截图／trace 位于忽略目录 `.tmp/upload-release-results/`；生产 npm 安装、可选 Caddy 与最终完成态视觉截图没有本轮通过证据。
