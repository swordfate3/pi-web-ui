# Web v1 独立运行验收

日期：2026-10-27。分支：字面 `v1`。产品源码基线：`3db16cd`。

## 结论和范围

本轮完成单会话 Web 的本地独立验收，不依赖运行中的 Manager、Hub、Gate、Docker 或 WSL 路由服务。实际环境为 Linux、Node 22.19.0、Pi 1.1.0 和已安装的 Chromium；这不是 Windows/macOS 或任意未来 Pi 版本的兼容性声明。

没有修改产品源码、模型配置、现有扩展、真实会话、凭据、生产卷、域名或隧道；没有推送分支、合并 main、发布包或重启生产服务。`v1` 仍不是远程可安装的发布来源。独立 Manager 的更新/审批/多会话接入验收不包含在本报告中。

本轮新增可重复的 `e2e/standalone-visual.integration.ts`，并在附件上传 feature 中补上 `direct/mobile` 示例。没有将旧项目或旧提交的通过结果当成本轮结果。

## 新鲜验证结果

| 验证 | 本轮结果 |
| --- | --- |
| `build:web` 和重新生成 BDD | 通过；重建后产品文件没有差异 |
| 完整单元回归 | 460 项，459 通过、0 失败、1 项显式 opt-in 的 1 GiB 上传压力测试跳过 |
| 独立核心浏览器回归 | 45 项中 39 通过、0 失败、6 项 Manager 路由示例因未选管理器而明确跳过 |
| 补充手机直连附件上传 | 1 项通过；合成中文说明、图片和大文件通过真实 Pi/文件系统验证 |
| 补充独立桌面/手机面板验收 | 两个视口均通过；12 张截图；两屏的页面/console/请求/HTTP/WS 错误记录均为空 |
| 真实 Pi Git 安装、更新及 tarball 安装 | 通过；Git 生产依赖只有 `ws`；tarball 消费者只有根包和 `ws`；没有 Manager 可执行文件或源码产物 |
| 安装完整性负例 | 8 种过期源码输入均被真实 Pi 安装的 prepare 拒绝 |
| 类型检查 | 前端、连接项目，以及新增验收脚本的独立检查通过 |
| Biome | 249 文件、0 error，保留既有 7 warning、2 info |
| dist 清单与空白差异 | `web-dist.mjs` 与 `git diff --check` 通过；哈希一致不等于来源认证 |

核心浏览器回归包括聊天流式终态、真实工具成功/失败、技能/提示词/扩展命令、模型及思考等级面板、新建/clone/fork、恢复/统计/导出/reload、编辑/重答版本切换、公式、下载确认/取消、上传故障恢复、中英文、移动侧栏及工作区文件/git diff。

路径为浏览器 → 实际 mirror HTTP/WebSocket → 真正的 `pi --mode rpc` → 临时会话/工具/文件/git。仅模型回复和面板来源数据是合成的；不是拦截 WebSocket 或向 React store 注入状态。

补充面板验收使用明确的合成来源扩展：`/agents` 与 `/mcp-adapter` 能打开当前来源面板，代理模型/思考选项与并发值来自该来源，`/new` 后能重新发现来源。它不证明未适配的第三方扩展能自动弹窗，也不证明真实 OAuth、外部 MCP 服务或子代理任务已完成。

## 视觉检查

应用内 Browser 工具本轮不可用，采用 Playwright Chromium fallback，关键截图已作为图片检查，不以 DOM 存在代替可见性。

- 独立页面临时地址记录于忽略的 `result.json`：桌面 `http://127.0.0.1:46023`（1440×900），手机 `http://127.0.0.1:44873`（390×844）。这些临时测试服务已停止，地址不是持续运行的预览入口。
- 模型面板、MCP 按钮、中文文件下载确认可见；代理长面板可在内部滚动到任务输入和底部关闭按钮，页面没有横向溢出。
- 用户、助手、思考区公式在桌面/窄屏检查中通过；代码和价格文本仍保留原样。
- 未连接可信 Manager 时，敏感请求回到原 Pi 终端/RPC 确认，网页只显示等待提示；没有网页批准按钮，私密预览标记未出现在公开 WebSocket 帧中。原 RPC 拒绝后提示清除。此边界不能解释为“独立网页支持批准一切授权”。
- 已知非阻塞视觉限制：390px 英文页面的鲸鱼伴侣说明文字存在局部裁切；本轮未修改该装饰组件，也未宣称所有响应式细节完美。软键盘、真机 Safari、外网手机网络未在本轮实测。

忽略的原始证据位于 `.tmp/web-v1-acceptance/`：`unit-permitted.log`、`browser-core.log`、`mobile-upload.log`、`install.log`、`standalone-visual.log`、`standalone-visual/result.json` 和面板截图。公式及下载截图在本轮 `test-results/`；这些临时原始文件不随包分发。

## 可重复执行

使用隔离临时 HOME、空模型密钥环境和现有依赖；不要对共享开发 node_modules 重新安装，也不要使用真实用户会话作为 fixture。

```bash
npm run build:web
npm run e2e:gen
node --import ./tests/register-ts.mjs --test --test-concurrency=4 \
  tests/*.test.ts tests/*.test.mjs src/web/src/core/i18n.test.ts \
  src/web/src/components/pi-web-ui/sidebar-tree.test.ts

PI_E2E_BROWSER_EXECUTABLE=<已安装的兼容Chromium> \
  node_modules/.bin/playwright test -c e2e/playwright.config.ts \
  chat-lifecycle daily-commands message-revision math-formatting \
  file-download file-upload left-sidebar workspace-status language

PI_E2E_BROWSER_EXECUTABLE=<已安装的兼容Chromium> \
  node --import ./tests/register-ts.mjs e2e/standalone-visual.integration.ts

PI_INSTALL_TEST_ROOT=<新建的临时目录> \
  PI_INSTALL_TEST_BIN="$PWD/node_modules/.bin/pi" \
  node scripts/test-git-install.mjs

node_modules/.bin/tsc --noEmit
node_modules/.bin/tsc --noEmit -p tsconfig.connection.json
node_modules/.bin/tsc --ignoreConfig --noEmit --types node \
  --module esnext --moduleResolution bundler --target es2022 \
  --allowImportingTsExtensions --esModuleInterop --skipLibCheck \
  e2e/standalone-visual.integration.ts
npm run check
npm run verify:dist
git diff --check
```

## 排障记录与限制

最初受限沙箱中的 Chromium 被 `setsockopt: Operation not permitted` 拦截；同环境的 broad Node test 只报告文件级失败并挂起，已中止，不能计为通过。取得临时浏览器/loopback/子进程权限后，用隔离环境重新执行，才得到上述命名断言和浏览器结果。

新增脚本初版错误地对包裹 select 的 label 做精确匹配，并把独立模式的终端等待提示误当成带 Manager 的 broker notice；根据真实 DOM、RPC 和 broker 创建条件修正了验收断言，没有放宽授权或变更产品逻辑。最终两屏重新跑完才记录通过。

独立静态审查另外指出三个验收脚本问题：上下文初始化/关闭失败时需保证停止测试 Pi；私密预览检查需覆盖请求结束与切换会话后的帧；重新发现面板不能只比较相同的显示内容。均已补强并重新完成两屏验收：清理采用独立 finally，最终再次检查所有已收到的公开帧，并根据真实 state_sync 与面板响应确认会话 ID 和 registrationId 均更新。

同一审查者复查后确认上述三个修订范围无剩余 P1/P2。该审查为只读静态检查，实际最终运行结果由主执行者另行核对，不将审查意见冒充独立复跑。

保留现有 Node `MODULE_TYPELESS_PACKAGE_JSON` 和 Vite 大 chunk 警告；未为消除提示而改变模块模式或在本轮扩展性能重构范围。

本报告只意味着 Web 独立验收已完成，不代表 Manager 已完成，也不代表用户容器已经安装此分支。下一步上线需单独确认远程分支发布、当前安装来源和替换时机。
