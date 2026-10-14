# 多会话总管分支二次合并验证

## 范围

基线 `main@847079e`，远程候选 `codex/portable-web-connection@22ba8c7`。该候选新增同包、手动启动的多会话 `pi-web-hub`，并已整合 main 的生产预构建分发方案；Git 历史允许快进。本轮在独立开发 worktree 审查、修复和验证，不部署总管、替换 WSL 路由或启动真实用户 Pi。最终本地／远程分支状态以 Git 为准，本报告不预先宣称推送成功。

## 审查发现与修复

1. **必需总管产物未强制要求（P2）**：原 manifest 只要求 `index.html`，缺少 `dist/hub/pi-web-hub.mjs` 仍可写出有效清单并通过安装。将两者纳入固定必需输出，校验实际文件和清单条目；回归覆盖 write/default/install/assets-only，以及重算摘要后遗漏 bin 的拒绝。
2. **未知命令可能误启动（P3）**：普通对象白名单可读取继承属性，`toString`／`constructor`／`__proto__` 等无额外参数会落入启动分支。改为 Map，启动分支显式要求 `serve`；回归检查未知命令失败退出、不输出和不生成 runtime 资源。
3. **生产总管测试证据不足**：原 browser/backend integration 直接导入仓库 hub 源码，环境变量只影响 Pi 扩展和静态资源；消费安装脚本也只验 CLI help。新增 CLI fixture 真正从选定 runtime 的预构建 executable 执行 init/issue/serve/revoke；缺失 runtime 不回退源码。Git update 和 tarball consumer 分别验实际生命周期与 SIGTERM 清理。

两个独立 reviewer 分别审查服务端和分发／CLI。服务端范围未发现可证实的新增缺陷；分发上述两项问题修后再次只读复核未报告剩余必须修复项。reviewer 未执行测试；动态证据来自本轮运行，不能视为完整安全审计。

## 本轮实际执行

| 检查 | 结果 |
| --- | --- |
| 初始候选单测／后端 | 123 单测、9 真实 Pi 集成通过 |
| 修复后单测 | 132/132 通过，无跳过；不包含单独的 9 项后端集成 |
| 修复后生产安装后端 | 9/9 通过；总管与 Pi 扩展均消费安装目录 |
| 生产安装完整浏览器 E2E | 45/45 通过，约 2.9 分钟 |
| Python／真实 Caddy | 19 项中 18 执行通过、1 因不同原 GID 的环境能力不足跳过 |
| Biome／connection TS／前端 build | 通过；Biome 150 文件 |
| 普通真实 Pi Git install／update／tarball | 通过；Git 仅 `ws`，tarball consumer 仅根包＋`ws` |
| 真实 prepare stale-input 拒绝 | 六类源码输入全部拒绝 |
| 安装 CLI 生命周期 | Git update 与 tarball 内 init/issue/serve/HTTP/revoke/SIGTERM 均通过 |
| 正常 npm pack（含构建生命周期） | 699 文件、4,871,208 压缩字节、25,168,829 展开字节 |
| 产物一致性 | pack 后 manifest 与已完整测试的安装副本相同；118 源输入、673 输出 |
| 源码 whitespace 检查 | 通过；生成 dist 独立 SHA-256 校验，不手工改第三方 minified 字节 |

采用 Node 24、已有 Pi 开发 runner、Chromium 和 Caddy 2.10.2。新锁文件新增 `@types/ws`；第一次复用旧依赖目录造成 TS 缺声明，随后在独立 worktree 正常 `npm ci --legacy-peer-deps` 完整安装分支锁文件，再复跑成功。没有改变生产依赖模型或用户启用包。

CLI 未修复的旧预构建产物会使继承属性命令回归失败；重建后转绿。缺失 hub 输出负例直接拒绝。没有扩大超时、忽略失败断言或 mock WS 来制造成功。测试使用合成标签、单独私有目录、临时 capability、IPC、loopback 与 faux provider；不读取或控制真实用户会话。

主要命令（从仓库根执行，runtime 指向隔离安装结果）：

```bash
npm ci --legacy-peer-deps
npm run check
npx tsc --noEmit -p tsconfig.connection.json
npm run test:unit
npm run build:web
npm run verify:dist
PI_INSTALL_TEST_BIN="$PWD/node_modules/.bin/pi" node scripts/test-git-install.mjs --keep
PI_E2E_BIN="$PWD/node_modules/.bin/pi" node --import ./tests/register-ts.mjs --test --test-timeout=70000 e2e/portable-connection.integration.ts e2e/session-hub.integration.ts
npm run e2e:gen
npx playwright test -c e2e/playwright.config.ts
CADDY_TEST_BIN=/path/to/caddy python3 -m unittest discover -s tests -p 'test_gateway*.py'
npm pack --pack-destination .tmp/package-check --json
```

## Browser 可见验证

通过 Browser MCP 打开隔离生产安装总管 `http://127.0.0.1:44881/sessions/`，两个真实测试 Pi 通过各自临时凭据登记。桌面 1440×900 和手机 viewport 390×844（full-page）截图直接查看：卡片标签、在线状态、搜索、刷新、打开会话按钮可见；手机单列，无横向挤出或重叠。手机 full-page 需要纵向滚动，不等同所有内容同时在 844 像素内可见。

原始截图 `hub-merge-desktop.png`、`hub-merge-mobile.png` 位于从本目录出发的 `../../../../downloads/pi-web-ui-visual-check/`，不随仓库发布。临时入口与两个 Pi 均停止，URL 仅作证据定位。可见检查不是 E2E；45 项真实浏览器功能验证另行运行。

## 限制与部署边界

- 总管是可选独立进程，扩展不会暗中启动它；现有单 Pi 仍无需总管。不会自动安装系统服务、SSH、Caddy、登录或改 Docker mount。
- 初始中文总入口不具备主聊天 UI 的完整双语／主题设置；本轮没有扩大功能做翻译重构。
- 默认回环监听；公网仍需要可信 TLS、认证与隧道。Host/Origin 和 proof 不替代人类认证或同 UID 强隔离。
- 文档披露的身份核验与连接之间 TOCTOU、持久 ledger 增长和异常退出后手动恢复锁仍保留；不宣称可隔离敌对同 UID 工作负载。
- 未验证实体手机公网、阿里云、真实 pirun／WSL 配套、macOS 或 Windows IPC。远端 CI 不在本轮结果内。
- 不为补不同 GID 成功测试修改系统用户。当前 Python 该项跳过；负向权限及 rollback 有既有 mock 覆盖。
- 开发安装有 npm install-script 提示，既有 chunk-size／Node module-type 警告仍存在；未自动改审计依赖。

原始日志：`hub-merge-static-final.log`、`hub-merge-unit-fixed.log`、`hub-merge-installed-integration.log`、`hub-merge-e2e.log`、`hub-merge-python.log`、`hub-merge-install.log`、`hub-merge-pack.log`。本轮实际验证不以分支历史报告中的通过数替代。
