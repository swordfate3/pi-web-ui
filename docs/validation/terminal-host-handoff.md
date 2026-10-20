# 宿主机 Codex 协作测试交接

## 分支与目的

- 仓库：`https://github.com/swordfate3/pi-web-ui`
- 测试分支：`experiment/trusted-terminal-host-test`
- 基线：`53bb63f0363eec0b39459633f70dda35b6c1b423`（已发布的 1.0.1）
- 包版本仍为 1.0.1，本分支不是发布，不等于生产已部署。精确测试 commit 请用本次交接消息中的完整 SHA，并在测试前 `git rev-parse HEAD` 核对。

本分支保留基线之后累计的中文教程、数学渲染修复、终端等待提示、默认关闭的第三 listener/auth、单writer lease、隔离真实PTY、私有transport、headless快照及独立网页终端试验。不要仅 cherry-pick 页面文件，也不要把 `e2e` fixture 直接接到生产 Pi。

**当前能力：**真实 Browser→WS→Unix→worker→同一隔离Pi PTY，可以操作原生合成confirm/custom面板。**当前不能：**直接接管正在使用的Pi、替代pirun/supervisor、宣称已有生产网页授权或adapter交互屏障。产品 terminal status 仍 backend unavailable。

## 先守住边界

请宿主机 Codex：

1. 先读本仓库 `AGENTS.md`，保留现有未提交修改；已有源码 checkout 就在其内部切分支，不擅自新增兄弟项目／worktree。工作区不干净先报告，不 reset／clean／强制切换。
2. 只做源码调查和隔离测试。**不重启当前Pi、Docker、Hub、共享隧道，不改生产配置，不更新个人Pi包，不reload，不申请／批准Gate，不合并main，不npm publish或创建发布tag。**
3. 不索取／打印 `.env`、API key、Cookie、配对码、Authorization、会话正文或管理员凭据。测试只加载合成fixture，不加载个人memory/MCP/模型认证。
4. 缺依赖先说明并向宿主用户确认安装；不要为测试默认apt／全局升级Pi／安装浏览器。若在容器中，先核实持久挂载再选安装路径。
5. 不把 ACK、释放lease、终端空闲、网页reload当作异步副作用已完成／取消的证明；未知输入不得自动重放。网页按钮只申请已有scope内的单writer，不是新的可信人工批准。

## 取得精确分支

在已有且干净的宿主机仓库中（remote名仅示例，先核实URL）：

```sh
git remote -v
git status --short
git fetch <指向swordfate3/pi-web-ui的remote> experiment/trusted-terminal-host-test
git switch --track <该remote>/experiment/trusted-terminal-host-test
git rev-parse HEAD
```

若本地分支已经存在，用其现有跟踪关系核对／快进，不强制覆盖。没有checkout时，另行由宿主用户选择源码落点；不能据此覆盖现有项目。

## 环境与依赖

- Linux（原生／WSL Linux），Python ≥3.11：PTY、`waitid(WNOWAIT)`、pidfd和测试subreaper使用Linux能力。原生Windows／macOS不在本轮支持矩阵。
- Node ≥22.19，推荐24；本地 dev dependency Pi1.1.0，可通过 `PI_E2E_BIN` 指向另一个**已安装**Pi（容器已测1.3.0），不要指向管理生产会话的包装器。
- xterm固定：headless6.0.0、serialize0.14.0、browser6.0.0；浏览器只作为dev dependency，生产依赖为ws和headless/serialize。
- 依赖已获宿主用户许可后：`npm ci --legacy-peer-deps --ignore-scripts`。该命令不会运行项目prepare或第三方安装脚本；然后显式执行下面的verify/build/tests。不要使用生产only依赖运行e2e。
- 浏览器使用已安装Chromium：设置 `PI_E2E_BROWSER_EXECUTABLE` 为其可执行文件。若使用Playwright已有缓存，也可以不设置。Linux动态库用当地环境，不复制容器特有绝对路径；没有可用浏览器应报告，不能伪造通过。
- esbuild由现有Vite工具链提供；禁安装脚本时若平台二进制不可用先报告，不静默开启所有脚本。

`NODE_OPTIONS=''` 仅用于这些独立测试命令，避免继承当前进程stdin guard；**不修改生产guard配置**。测试harness对子Pi用临时HOME／agent目录和env白名单，faux模型不联网；配置隔离不等于OS网络沙箱。

## 建议测试顺序

以下命令均从仓库根执行。先静态，再PTY，再browser；异常先检查是否残留测试进程，不自动无限重试。

```sh
# 0. 核对已提交源码与预构建产物（hash一致性，不是安全认证）
node scripts/web-dist.mjs

# 1. 单元与静态
NODE_OPTIONS='' npm run test:unit
NODE_OPTIONS='' ./node_modules/.bin/tsc --noEmit
NODE_OPTIONS='' ./node_modules/.bin/tsc --noEmit -p tsconfig.connection.json
NODE_OPTIONS='' npm run check

# 2. 原生PTY／worker（只启动临时合成Pi）
python3 -B e2e/harness/test-isolated-pty.py
python3 -B e2e/harness/test-pty-stream-worker.py

# 3. 真实私有transport（含30秒lease）
NODE_OPTIONS='' node --import ./tests/register-ts.mjs --test e2e/pty-transport.integration.ts

# 4. headless＋只读browser恢复
NODE_OPTIONS='' node --import ./tests/register-ts.mjs --test e2e/terminal-screen.integration.ts

# 5. 独立origin真实browser双向交互（含30秒lease）
NODE_OPTIONS='' node --import ./tests/register-ts.mjs --test e2e/terminal-browser.integration.ts
```

如另有已安装Pi版本，将 `PI_E2E_BIN=/实际可执行文件` 放在命令前重跑2–5；不要为了凑矩阵默认安装新版本。`PI_PTY_TUI_MODE=fullscreen` 是已有1.3fullscreen额外路径，regular通过不代表fullscreen自动通过。

可另做：

```sh
# 构建可改动dist；先记录状态，结束比较，不自动提交生成差异
NODE_OPTIONS='' npm run build:web
npm run verify:dist
git diff --stat -- dist/

# 网关原有单元
python3 -B -m unittest discover -s tests -p 'test_gateway.py'
```

`node scripts/test-git-install.mjs` 是可选的完整Git安装／更新／tarball回归：会在独立设置与临时源码fixture安装生产依赖并访问npm，使用真实Pi安装流程／prepare。**先获宿主用户相应安装／网络许可**；不修改个人Pi设置，也不能只因本地单元通过就称它通过。可用 `PI_INSTALL_TEST_ROOT` 指定获准的临时或持久测试根。脚本断言生产依赖严格为ws/headless/serialize，不含browser xterm／Vite／React／SDK。

既有完整产品BDD曾有3项基线失败（旧DOM handle／Submit vs Stop状态），见[数学与提示记录](math-terminal-prompts.md)，不要把本轮终端专项目标扩大为未经解释的全部产品BDD全绿。

## 本地已执行证据（供比对，不替代宿主测试）

- 单元562项：561pass／1条件skip。
- Pi1.1/1.3 browser终端各10/10；worker各7/7；screen各3/3。
- Pi1.1 raw transport8/8／原PTY7/7；前轮Pi1.3原PTY regular/fullscreen各7/7。
- 两套types、Biome0error（既有30warnings／1info）、build／verify:dist通过。
- 独立复核修复两类预算／UTF8问题；限定复审无遗留must-fix，不是全树生产安全认证。
- 新网页截图已查看，手机控件换行，终端可横向滚动；emoji缺字、serialize缩窄折行cursor可能偏一列仍存在。

详见[隔离PTY](isolated-pty.md)、[私有transport](pty-transport.md)、[screen](terminal-screen.md)、[browser](terminal-browser.md)、[ADR0018](../adr/0018-trusted-terminal-extension-compatibility.md)。截图写到工作区downloads目录，是原始产物，不在本Git分支中；换宿主位置请先确认其实际落点，勿覆盖已有产物。CI目前只自动跑main push／面向main的PR，推送本测试分支**不会自动等于CI完成**；不自动创建PR。

## 宿主机最重要的只读调查

此前记录的候选源码目录是宿主机 `/home/fate/docker_files/pi-docker`，容器里不可见；请先确认真实路径，不相信历史路径一定存在。

只读定位／报告：

- `pirun` 入口、`pi_supervisor.py` 可编辑源码、Dockerfile／Compose构建关系、现有profile／stdin guard／restart admission执行点。
- 当前启动如何继承TTY，谁持有子进程／process group，能否由supervisor从启动持有PTY，持久socket在哪，Pi与Hub如何接固定provider。
- 新profile `web-terminal-v1` 从启动必须 `managedRestartEligible:false`，不能仅网页隐藏按钮；旧no-PTY裁决／taint不清，不能沿用旧SIGINT前台组假设。
- 如何把本机键盘relay与远程单writer互斥，恢复raw mode／信号／尺寸；聊天mirror的输入屏障和unknown锁存由哪个可信执行点持有。
- 不把Gate预设成终端流所有者；它可继续只做部署审批。只有决定修改Gate集成才需要其源码。

**本次要求是测试与调查，不是改动／重建生产runtime。** 如宿主用户另授权实现，可在真实runtime源码树做受审修改，先隔离启动新测试Pi，不热附当前Pi；先交回设计与diff，不自动部署。回传实现可用单独分支／commit，不能直接覆盖此分支或main。若只传必要源码到工作区，明确排除`.env`／key／Cookie／运行数据库与会话数据。

## 回传格式

请提供：

1. 测试完整commit、OS／Node／Python／Pi／Chromium版本（不附完整env）。
2. 每条命令的pass/fail/skip及耗时；失败用最小脱敏栈与可复现条件，不上传终端正文／凭据。
3. 桌面／手机实际截图检查结果；不要仅凭DOM匹配称视觉通过。
4. 测试后worker／Pi／socket／临时目录是否回收；异常清理失败应保留证据并报告，不能硬杀worker后假报Pi已清理。
5. runtime源码真实路径、相关文件／调用链、建议的最小接线点和仍需授权的动作。

不要用测试fixture中的合成Yes推导模型获得真实批准权限；不要对未知旧操作自动补Enter或重新发送。
