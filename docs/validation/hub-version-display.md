# Hub 版本与更新展示

## 范围与产品行为

本轮为 Hub 增加只读版本总览，并在各会话名字下显示运行中 Pi 与 Web 扩展的版本。
只检查 Pi CLI 和本包的 Web 扩展／Hub，不扫描其他已安装扩展，不读取会话正文、
提示词、模型配置或凭据；不是更新器，也不改变现有 Gate 和进程重启的授权边界。

- Pi 使用数值稳定语义版本比较；发现更高的公开稳定版本时显示目标版本。
- Web 扩展同时显示包版本与 source SHA-256 的前八位，完整 fingerprint 在 tooltip 中。
  当前包版本不能区分所有 Git main 更新，因此相同包版本仍检查构建指纹。
- 相同版本、不同构建仅显示「与发布构建不同」，不声称一定落后，也不猜 Git 祖先关系。
- 旧客户端不报告软件元数据时明确显示「未上报」；已存在的受管 runtime 版本仅作 Pi
  展示兼容回退，不虚构 Web 扩展版本，也不据此授予重启资格。
- 上报的是扩展加载时捕获的元数据，不是磁盘实时安装清单，更不证明实际机器代码来源。
- 公开源不可用、只获得部分发布信息或未上报构建时，显示对应未知状态，不显示虚假的
  「已是最新」。版本检查不阻塞会话列表，不在每五秒列表轮询时重复请求公开源。

## 视觉检查

使用独立 HTTP 合成 fixture，真实浏览器访问 `/sessions/`，并非生产会话。
桌面 1440×1000 与手机 390×844 截图均检查了以下状态：

- Pi 可更新、Web 构建不同、公开版本一致、旧客户端未上报；
- 长项目与会话名截断，Pi 多位版本数字、构建标识与徽章可换行；
- 手机文档无横向溢出（innerWidth 390，clientWidth 与 scrollWidth 同为 375，
  差值来自桌面 Chrome 滚动条），打开会话按钮仍完整可见。

截图：

- `downloads/playwright-mcp/hub-versions-desktop.png`
- `downloads/playwright-mcp/hub-versions-mobile.png`

这是合成数据的浏览器交互与视觉检查，不是完整 Pi 浏览器 E2E、触屏验收或线上部署证据。
本轮不升级 Pi、不自动刷新用户会话、不部署 Hub、不变更 Gate 策略。

## 回归入口

```bash
PI_OFFLINE=1 npm run test:unit
npx tsc --noEmit -p tsconfig.connection.json
npm run build:web
npm run verify:dist
PI_OFFLINE=1 node --import ./tests/register-ts.mjs --test \
  e2e/portable-connection.integration.ts e2e/session-hub.integration.ts
```

实际结果（2026-10-18）：

- 完整默认单测 447 项：446 pass、1 个可选大流 skip、0 fail；日志
  `.tmp/hub-versions/unit.log`。覆盖运行快照不随磁盘改变、未知／预发布／非法上报、
  软件续期不改变路径身份、不授予受管控制、API 不泄露内部控制身份／凭据；
  固定公开源的不可变 revision、单飞、缓存、立即失败、同步 throw、独立请求超时、
  关闭取消、超大响应、重定向和非法结果。
- Pi 1.3.0 的 portable、session-hub、message-revision 后端 integration 共 11/11 pass；
  Pi 1.1.0 的 portable 与 session-hub integration 共 9/9 pass。
  真实非受管 Pi 经本机隔离 IPC 登记，实际 Hub 预构建 CLI 返回其自有构建和各 Pi 的
  上报软件版本；reload／Hub restart／单会话退出／失效链接继续保持原边界。
  日志 `.tmp/hub-versions/integration-{1.3.0,1.1.0}.log`。
- 两套 TypeScript 检查、生产 Web／Hub 构建、manifest source/output 对应性通过；
  全仓 Biome 检查 239 文件，0 errors，保留原有 30 warnings／1 info。
- 两轮有限只读审查分别检查前端和后端快照，找出的运行时 fixture 来源不一致及
  单源超时丢弃健康来源问题均已修复；新增后者回归动态通过。审查未取得完整 Git diff，
  不作为全项目或完整变更无缺陷保证。
- 默认公开源实查返回 `partial`，仅取得 Pi 1.3.0；Web 来源在当前网络环境不可用，
  不声称真实 GitHub 发布查询成功。完整成功路径用固定源的注入响应验证，不切换
  其他端点或降低失败校验。日志 `.tmp/hub-versions/public-source.log`。

单元和 integration 的注册与版本源测试使用临时授权、合成元数据或固定源注入假响应；
测试设置 `PI_OFFLINE=1`，不访问真实公开源。单独的公开源实查不发送生产登记、
会话正文或凭据。不运行安装／更新命令；不把本轮检查等同于包已安装或线上已部署。
