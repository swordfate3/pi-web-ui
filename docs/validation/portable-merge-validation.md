# 连接分支集成与审查修复验证

## 范围与结论

将 `main@1eb2ac8` 的预构建安装方案集成到 `codex/portable-web-connection@7826fb2` 的独立开发 worktree，解决冲突并修复审查发现的失败边界。当前源码／产物已完成合并候选验证。维护者随后明确授权提交及 GitHub 发布；实际提交、main 合并与推送状态以 Git 历史为准，本报告不预先宣称发布成功，也不授权生产部署。运行中的用户 Pi、启用包、WSL 挂载、阿里云网关和共享隧道未修改。

## 修复内容

- 保留 main 的 Node-only prepare、仅 `ws` 运行依赖、tracked dist 和安装／更新回归。合并 package 发布文件清单，开发日志保留双方记录并重新编号。
- HTTP／WS 无条件经过路由 guard。登记关闭或 capability 加载失败时，携带任一路由头（包括空值）返回 409；identity HTTP 返回 403；无路由头的本地访问仍可用。
- capability 的 `run_id`／`token` 必须为字符串再校验 hex，拒绝单元素数组等隐式转换，不将异常类型传给 HMAC。
- Caddy 原子替换在非 root 路径也保持并复核 UID/GID/mode；无法保持时在替换前拒绝，rollback 使用相同规则。补描述符与临时文件失败清理。
- 远程计划／材料通过 reducer 统一管理。用户改过的端口不被迟到的运行时默认值覆盖；实际自动端口变化清空旧材料；过期计划的材料结果不应用。
- 构建输入清单覆盖连接模块，以及位于 extension 目录、却被浏览器 bundle 导入的 `plan.ts` 和 `gateway.py`。
- 普通浏览器 harness 和独立后端 integration 均支持 `PI_E2E_RUNTIME_DIR`，产品扩展／资产来自生产安装，测试 fixture 仍来自开发仓库。CI 后端集成移到安装之后。

## 实际验证

| 检查 | 本轮结果 |
| --- | --- |
| Biome／前端 TS build／connection TS | 通过；Biome 检查 139 文件 |
| Node 单测 | 109 通过，无跳过 |
| 真实 Pi 后端 integration | 默认运行时及生产安装副本均 8/8 通过 |
| Python／真实 Caddy | 19 项中 18 执行通过、1 跳过 |
| 普通 Pi Git install／changed-commit update | 通过；仅 1 个生产依赖 |
| 真实 prepare 过期输入拒绝 | `src/web/index.html`、`plan.ts`、`gateway.py` 三种安装负例均拒绝 |
| production-only tarball consumer | 通过；仅根包与 `ws` 两个包 |
| 完整真实 Pi 浏览器 E2E | 最终 42/42 通过，约 2.8 分钟 |
| 正常 npm pack（含 prepack/prepare） | 通过；692 文件、约 4.84 MB 压缩／25.08 MB 展开 |
| 构建及包重建一致性 | pack 后 source/output manifest 与已测试安装副本完全相同；672 输出文件、112 源输入 |
| 源码 diff 空白检查 | 通过；排除未经手工编辑的生成 dist，dist 另由 SHA-256 清单验证 |

命令采用项目现有工具环境，没有安装新依赖。主要入口：

```bash
npm run check
npx tsc --noEmit -p tsconfig.connection.json
npm run test:unit
npm run build:web
npm run verify:dist
PI_E2E_BIN="$PWD/node_modules/.bin/pi" node --import ./tests/register-ts.mjs --test e2e/portable-connection.integration.ts
CADDY_TEST_BIN=/path/to/caddy python3 -m unittest discover -s tests -p 'test_gateway*.py' -v
PI_INSTALL_TEST_BIN="$PWD/node_modules/.bin/pi" node scripts/test-git-install.mjs --keep
# 设置上一步输出的 PI_E2E_RUNTIME_DIR 后，复跑后端集成及浏览器 E2E。
npm run e2e:gen
npx playwright test -c e2e/playwright.config.ts
npm pack --pack-destination .tmp/package-check --json
```

### 失败尝试与归因

- 初次生产安装后端检查 7/8 通过，占用端口场景失败且旧诊断为空。不能凭旧日志断定根因。修正测试预先确认连续两端口可绑定，保留首端口占用、释放第二端口给 Pi；依然断言只前进一端口。失败诊断延迟读取真实输出，退出清理有强制终止兜底。复跑 8/8 通过，不放宽启动超时。
- 初次完整浏览器尝试被外部命令时限中断；第二次完整运行 41 通过、1 失败，不计为全套通过。Markdown link-safety modal 打开后，实时聊天行被 settled history 同步替换，弹窗状态丢失。测试现观察真实 `sync_request` 对应响应，并等非 streaming 且包含正文 marker 的历史后再操作，未 mock WS 或跳过原断言。最终完整运行 42/42 通过。
- 新端口 E2E 最初引用默认 fixture Page，而初始化使用了独立 Page；已统一到实际导航的 Page，定向及完整场景通过。

## 可见 Browser 检查（独立于 E2E）

使用 Browser MCP 打开生产安装副本的隔离真实 Pi，入口 `http://127.0.0.1:46309/#remote-access`。该临时服务已停止，URL 仅供证据定位。

- 桌面 1440×1000：新部署表单与材料预览可读，生成／保存按钮有文字，真实端口与 `connect.sh` 内容一致，待执行提示明确；长内容在 modal 内滚动。
- 手机尺寸 390×844：登录管理两项切换有可见文字，账号操作说明与边界可读、长说明内部滚动，没有横向挤出。本次不是实体手机公网访问验证。
- 先前截图按钮为空；本次等待字体加载完成后可见。没有据此改动按钮或重新设计布局。
- 共享可见 Chrome 被切到其他用户页时 `document.visibilityState` 为 hidden，常规 click／scroll 稳定性等待超时。仅为准备视觉状态使用 DOM 点击与即时滚动，然后以实际截图检查；这些 DOM 操作不算正常功能 E2E。额外手机材料截图未成功，不以 DOM 存在冒充截图通过。

可见证据：`portable-merge-desktop-materials.png`、`portable-merge-mobile-login.png`。原始证据在此目录相对的 `../../../../downloads/pi-web-ui-visual-check/`；不随仓库发布。

## 独立复审与未验证边界

独立 reviewer 分别检查登记／安装、Python 事务、前端状态／测试修复。其指出的测试运行时选择和 Page 引用问题已修并复核，最终覆盖范围内未报告其他必须修复项。reviewer 只读源码，没有独立执行上述测试；动态结果来自本轮执行，不保证系统无缺陷。

- Python 的不同原 GID 成功替换／回滚测试因当前非 root 用户没有可用的不同组而跳过。权限不足、属性未生效、rollback 拒绝路径以 mock 覆盖；未修改系统账号以制造权限。
- 真实 Caddy 2.10.2 验证了首尾空白及 Unicode 合成密码的直接 stdin 散列、应用和 HTTPS 登录；不能扩大为特殊密码走完交互 CLI 全链路。PTY 交互保持普通合成密码。
- 迟到默认端口和重连端口变化由纯 reducer 单测覆盖；浏览器 E2E 验证手动改端口使材料失效和重新生成，未冒充真实网络重连全链路。
- 外部 TLS／认证、路由 lease expiry 仍属部署网关责任；proof 不是人类认证。header-free 本地 Web 不提供内置认证，原始 Pi 监听不可直接公开。
- 未执行真实阿里云／WSL 集成、原生 Windows／macOS、实体手机、远端 GitHub CI。没有更新用户 Pi 包或自动 reload。
- 保留既有 chunk-size 构建警告和 Node module-type 提示，未自动升级依赖或修开发依赖审计。

## 原始日志

`portable-merge-static-final.log`、`portable-merge-unit-final.log`、`portable-merge-installed-integration-final.log`、`portable-merge-python.log`、`portable-merge-install-final.log`、`portable-merge-e2e-settled.log`、`portable-merge-pack.log`。失败尝试日志及 language trace 也保留，不能作为最终通过证据。
