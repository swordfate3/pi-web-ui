# 包内独立多会话总管验证（2026-10-14）

## 范围与结论

在 `codex/portable-web-connection` 本地工作区实现同包独立 `pi-web-hub`，
复用 Pi 扩展的原生登记客户端。Node 单元／后端集成、真实 Pi 浏览器回归、
CLI 和包清单均通过。未提交／推送，不等于用户现有 pirun 或阿里云已升级。

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

PI_E2E_BROWSER_EXECUTABLE=/home/fate/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome \
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
