# 包内独立多会话总管验证（2026-10-14）

## 范围与结论

在 `codex/portable-web-connection` 本地工作区实现同包独立 `pi-web-hub`，
复用 Pi 扩展的原生登记客户端。Node 单元／后端集成、真实 Pi 浏览器回归、
CLI 和包清单均通过。此处描述最初本地实现阶段；随后用户授权推送同一
功能分支，整合后的新鲜验证见下文。仓库交付不等于现有 pirun 或阿里云已升级。

环境：Linux、Node 22.19.0、仓库依赖和本地 Chromium。测试使用临时项目、
凭据、IPC socket、随机端口和 faux provider；真实 Pi 运行，但不向真实
模型或用户会话发送测试消息。尚未验证 macOS；原生 Windows 总管不支持。

## 新鲜执行记录

以下命令从仓库根执行，部分网络／浏览器检查经批准在沙箱外运行：

| 检查 | 结果 |
| --- | --- |
| Node 单元及真实 Pi 集成 | 78/78 通过，约 33 秒 |
| 完整 Playwright-BDD 浏览器回归 | 44/44 通过，约 3.5 分钟 |
| `just check` | Biome 146 文件通过 |
| `npx tsc --noEmit -p tsconfig.connection.json` | 通过 |
| `npm run build:web` 及打包生命周期构建 | 通过，既有大 chunk 提示仍存在 |
| Python 网关回归 | 共 13 项：10 通过，3 跳过 |
| `npm audit --omit=dev` | 0 漏洞；不是开发依赖审计 |
| `npm pack --dry-run --json` | 清单 695 文件，预计压缩 4532330 字节 |
| `git diff --check` | 通过 |

```bash
node --import ./tests/register-ts.mjs --test --test-timeout=70000 \
  tests/*.test.ts e2e/portable-connection.integration.ts e2e/session-hub.integration.ts

PI_E2E_BROWSER_EXECUTABLE="$PI_BROWSER_BIN" \
  npx playwright test -c e2e/playwright.config.ts

python3 -m unittest discover -s tests -p 'test_gateway*.py'
```

Python 的三个可选实际 Caddy 测试因本轮环境未提供其运行条件而跳过，不记为
通过。本轮不是实际远程网关、实体手机或 Docker Compose 部署验证。

初次打包清单解析失败：npm 构建将 Vite 文本混入 JSON 输出；随后捕获输出并
只解析末尾 JSON，命令成功。没有因此改变包生命周期或跳过必要构建。
核验文件包括 CLI（0755）、`hub/config.ts`、`hub/server.ts`、`hub/portal.ts`、
`hub/package.json`、`docs/hub.md`、两个运行扩展模块与 `dist/index.html`。
仅 dry-run，没有安装或发布包。

## 功能与生命周期覆盖

- 两个真实 Pi 登记后在同一入口呈现，分别打开和发送消息；退出一个，另一个
  仍可使用。桌面和手机尺寸以及空列表分别验证。
- HTTP／WS 后端证明、Origin 拒绝、伪造凭据／过大登记、独立管理员目录。
- 过期、撤销、注销、总管重启后旧 URL 失效，存活 Pi 更新 generation 并续租。
- CLI 初始化不覆盖已有配置、按会话签发且不打印 token、SIGTERM 正常退出。
- 陈旧 socket 并发启动只有一个胜者；证明等待跨越租约不能错误报告续租成功；
  未登记 generation 的注销同样终止其后续登记；半关闭升级连接不能阻碍退出。

四个审查发现均先用失败测试复现，再修复；定向 11/11 通过后才运行完整回归。
复审未发现这四处及上游错误处理器修改的残留 P1／P2 问题。审查不是完整安全
审计；跨 capability 注销与启动失败锁清理仍可补更多独立回归。

## 可见界面检查

实际通过 Chromium 生成并直接打开截图：

- 桌面 1440×900：
  `test-results/features-session-hub.featu-38397-入口-总管连接两个真实-Pi-并保持会话隔离-例子-1-chromium/hub-desktop.png`
- 手机 390×844 viewport（full-page 截图）：
  `test-results/features-session-hub.featu-6782a-入口-总管连接两个真实-Pi-并保持会话隔离-例子-2-chromium/hub-mobile.png`

会话卡片、状态、搜索／刷新和进入按钮可见，未观察到遮挡、溢出或空白页面。
临时入口为 `http://127.0.0.1:<测试临时端口>/sessions/`，不作为运行地址。
截图在忽略的测试产物目录，单独克隆不包含；不是实体手机网络实测。

## 安全、持久化及部署边界

- config、grants、generation ledger 由独立总管持久化；不能挂进所有 Agent
  共享 home。Pi 只读取得 runtime 目录和自己的凭据，在线列表不持久化。
- 同 UID 共享 IPC 不构成完整安全隔离；后端证明与转发之间仍有 TOCTOU 窗口。
  不用于敌对同 UID 工作负载的强隔离保证。
- 异常退出残留独占锁会失败关闭；可信管理员确认无旧进程后才能恢复。没有
  按猜测 PID 自动删锁；generation ledger 本版本不自动压缩。
- 手机公网访问仍需可信 TLS／登录网关和通道。总管没有自动安装 SSH、Caddy
  或修改密码；已有单会话向导没有变成多会话自动部署器。
- Docker Compose 仅给出经过说明的片段，镜像／UID／目录／挂载需部署时
  配置和验证。未修改实际 pirun、WSL 路由、容器、共享卷、隧道或阿里云。

操作入口与详细恢复步骤见 [hub.md](../hub.md)。

## 远程分支整合与分发回归（2026-10-14）

本地功能提交 `5976ef7` 与远程安装／路由修复 `847079e` 整合，两侧功能
均保留。旧 WSL 服务、实际 Pi 安装、共享卷和阿里云配置均未迁移。
用户授权将整合结果推送 `codex/portable-web-connection`；实际推送结果
以远程 Git 提交为准，此报告不是部署记录。

生产分发回归先发现：源码内总管 CLI 可用，但 npm 包落在 `node_modules`
后，Node 拒绝直接剥离其中 TypeScript。先在真实安装测试中复现失败，
再把总管构建为 `dist/hub/pi-web-hub.mjs`，由 package bin 引用。Node 内置
模块与 `ws` 保持外部依赖，不引入用户侧编译步骤或运行时 TS 加载器。
源码清单新增 hub、CLI 和构建配置，过期源码拒绝测试覆盖这三类输入。

重新执行的结果：

- 132 项 Node 单元／真实 Pi 集成通过，0 跳过；其中真实 Pi 后端 9 项。
- 完整源码环境浏览器回归 45/45 通过，包含桌面／手机总入口和单会话页面。
- 生产依赖 Git 安装副本的真实 Pi 后端 9/9 通过；显式指定宿主 Pi 程序，
  扩展、静态网页资源从安装副本加载，不把宿主 Pi 装入扩展依赖。
- 同一生产安装副本的完整浏览器回归 45/45 通过，约 2.8 分钟；不是只测
  仓库源码或仅测静态 HTML。
- 普通真实 Pi Git install、update、npm tarball 安装通过；六类过期源码
  经真实 prepare 拒绝。Git 运行依赖只有 `ws`，tarball consumer 只有包本身
  和 `ws`；`.bin` 是入口目录，不计为第三个依赖。
- npm 安装后的可执行入口 `pi-web-hub --help` 可用。CLI 生命周期测试使用
  构建后的入口，覆盖初始化、签发、撤销、HTTP 入口和 SIGTERM 退出。
- `build:web`、`verify:dist`、`just check`（149 文件）、连接模块类型检查
  通过；pack dry-run 699 文件，压缩估算 4,871,141 字节，包含预构建总管。
- Python 网关 19 项中 16 通过、3 项可选真实 Caddy 检查跳过。未实测阿里云。
- 手写源码的 Git whitespace 检查通过；tracked dist 的第三方生成代码
  含既有行尾空白提示，未手工改写构建输出。大 chunk 提示仍存在。

失败尝试也保留在本地测试日志：一次沙箱禁止监听导致源码测试无法完成；
授权临时测试端口后重跑通过。首次对生产副本跑浏览器时漏设
`PI_E2E_BIN`，测试误在只含扩展的目录找 Pi；修正为与 CI 相同的两变量
配置再验证，不改安装模型。桌面／手机截图使用 Chromium 并直接查看；
本轮工具未提供 in-app Browser，不冒充完成该入口的检查。
