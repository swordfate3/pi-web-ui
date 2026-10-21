# 真实 pirun 网页终端接入设计

日期：2026-10-21。开发分支：`codex/trusted-terminal-runtime`。

状态：用户已确认实现可选网页终端模式。2026-10-21 实施审查发现普通网页消息缺少可关联的完成回执；用户随后明确确认修改产品约定：仅此模式从启动起禁用普通网页聊天写入，所有电脑/手机输入走同一个原生终端，普通 pirun 不变。该确认取代原先“首次远程接管后才禁用聊天”的时点约定。不修改现有服务、不部署或迁移现有容器；实现及验收仍按计划进行。

## 1. 已确认的效果与范围

手机操作当前 Pi 的真实 TUI，而不是另开 Pi、另开 shell 或重放任务。首版覆盖原生确认、select/input/editor 和 custom 面板的键盘操作，重点验证记忆确认及 `/mcp` 类面板。不是所有第三方扩展的全面兼容承诺。

- 普通 `pirun` 行为不变；网页终端仅对显式选择的新容器启用。
- 电脑与手机显示同一个 Pi 子进程；任一时刻只有一个终端输入所有者。
- `web-terminal-v1` 从启动起禁用该 Pi 进程的全部普通网页聊天修改入口，电脑与手机只通过同一个真实 Pi 终端输入。聊天页面可只读观察；首次取得远程控制不是关闭聊天的触发条件。释放控制、断线、等待、退出面板或 `/reload` 都不恢复写入；正常退出并重新启动普通模式才恢复。
- 新终端 profile 从启动起不具备 Hub 安全刷新 Pi 进程的资格。更新共享安装与刷新正在运行的 Pi 是两回事；不得把新 profile 当作可安全刷新目标。
- 已运行的普通 Pi 不热接管、不补挂载、不重启。现有 Pi 配置、模型、会话、项目、凭据不迁移、不清理。
- 本轮交付是可本地验证的真实接线、构建入口和上线说明。公网 DNS、Caddy、隧道切换、真实登录信息及现有容器迁移必须单独确认。

## 2. 已核实的基线

| 部分 | 当前事实 | 接入要求 |
| --- | --- | --- |
| 本地 main | `fa25b7adbd59fc65b1985bf4deedefc49067653c`，含有界 Hub 与按需历史 | 不以较旧实验分支替换 main |
| 实验分支 | `9e45efa545b6194306b7b4178fdc56aa20dbbb61` | 复用经过审阅的契约、认证、租约与画面代码，不能把测试 fixture 当生产 broker |
| 产品 terminal listener | 仅认证/status，报告 `terminal_backend_unavailable`，拒绝 Upgrade | 实际接入 provider、网页和 WS 后才可声明可用 |
| pirun | `/home/fate/docker_files/pi-docker/scripts/pi-pirun` 调用 Compose | 显式 profile、标签、环境与预检；不读取 `.env` |
| supervisor | `runtime/pi_supervisor.py` 的 child 继承外层 TTY | 新 profile 必须从启动就持有 PTY；旧 profile 原样保留 |
| 扩展运行管理 | `extensions/runtime-control.ts` 与 mirror 的准备屏障 | 增加独立终端屏障，不清除已有 stdin taint |
| Gate | 已持有 Docker 管理能力；生命周期接口是有界短请求 | 终端流是独立、默认关闭的权限域，不扩成任意执行接口 |
| 宿主配置源 | `/home/fate/docker_files/pi-docker` 与 `pi-deploy-gate`，前者不是 Git 仓库 | 改动前保留精确基线与补丁；不能假称这些文件已包含在 Web 仓库提交中 |

实验测试曾发现干净安装缺少显式 `esbuild` 依赖，以及锁定的 Pi/codemode 组合不兼容。实施时先复现并消除可重复安装障碍，再以最终集成分支重新跑测试，不沿用旧测试数字作验收结论。

## 3. 接线与职责

```text
只读聊天页面 ── 现有 Hub chat ── mirror ────────┐
                                             │ 同一个 Pi TUI
独立终端页面 ── Hub terminal ── terminal provider │
                                  │          │
                         固定镜像内终端客户端    │
                                  │          │
                         supervisor / broker ─ PTY
                                  │
                           电脑终端仅作 relay

管理页面 ── 现有管理接口 ── Gate 生命周期管理（保持独立）
```

### 3.1 运行层与固定 broker

- profile 名称为 `web-terminal-v1`；旧模式称 `inherited-tui`。选了新模式但能力不足时明确失败，绝不悄悄回退成不可连接的普通 Pi。
- Python 标准库持有 PTY、controlling terminal 与前台进程组，启动唯一 Pi 子进程。Node broker 维护有界 screen、授权租约和协议。两者属于镜像维护代码，不从可写的扩展安装目录执行控制代码。
- broker 的源文件在 Web 仓库的 `runtime/terminal/` 下版本管理，构建到独立 `dist/runtime/`。Docker 构建从校验后的包制品复制到 root-owned `/usr/local/lib/pi-runtime/terminal/`；禁止运行时覆盖 `/usr/local`。
- 宿主 supervisor、entrypoint、Dockerfile、pirun 仍在集中 `docker_files` 目录修改。其基线摘要、精确补丁与验证方法归档在本仓库 `docs/validation/`，实际文件与仓库提交范围分别列出。
- Pi 与 broker 进程以 UID/GID `1000:1000` 运行，保留 cap-drop ALL、no-new-privileges、无 sudo。每个 child 有随机 `terminalEpoch`；旧连接不能跟随新 child。
- 本机终端进入 raw relay 后必须恢复 termios；控制字符、EOF、Ctrl+C、SIGTERM/HUP、关闭终端和 resize 按 PTY 的真实语义处理，不能复用旧模式“不转发 SIGINT”的假设。
- broker 不接受浏览器提供的 argv、cwd、PID、容器名、环境、可执行路径或 socket 路径。终端输出解析失效时撤销终端能力并继续排空 Pi 输出，不能堵住 Pi 或本机终端。

### 3.2 固定 terminal provider

选择 Gate 侧独立 provider，而不是赋予 Hub 或普通 Pi Docker 权限。provider 是新增、默认关闭的协议域，拥有单独凭据、策略、连接限制和 Unix socket；部署、生命周期批准及 runtime-update token 都不能用于终端。

Hub 只挂 provider 的专用 IPC 卷与只读的专用凭据文件；Pi 不挂 provider 管理卷或凭据。provider 按受信 run grant 对应的 runId 查找唯一运行容器，校验不可变 container ID、允许的 image ID、`1000:1000`、固定 entrypoint、安全参数和挂载，以及 `cn.swordfate.pi.runtime-profile=web-terminal-v1`。自报 capability 或登记凭据不等于通过运行层核验。

核验通过后，provider 只启动固定镜像内终端客户端，以有界标准输入/输出连接该容器内固定 broker。客户端不能接受任意命令或目的地；请求仅包含经过验证的身份元组与闭合协议动作。终端连接复用一个受限 exec 流，不为每个按键创建进程。关闭客户端不能杀死 Pi。固定客户端使用绝对解释器路径与隔离模式，禁止继承任意 Python/Node loader、预加载及动态库注入设置；profile 标签、entrypoint 分派和实际运行层身份必须一致。

不复用现有 `lifecycle_control` 的 16KiB 请求格式承载长连接，不开放 shell、通用 Docker API、任意 TCP/WS 转发。Docker 流必须严格解帧，stderr、帧超限、身份变更或协议异常导致撤权及关闭，不把诊断输出当终端数据。

这是 provider 的新实现范围，不能仅因 Gate 原有权限而默认为所有目标开放终端。Linux 同 UID 或恶意已安装扩展不在完整隔离承诺内；固定镜像代码与窄协议用于约束入口，不是假称能隔离同进程内任意恶意代码。

### 3.3 Hub 第三个 origin

- terminal 的 listener、origin、cookie、session、CSRF、scope、撤销 epoch 与 chat/admin 分离。不同路径不算 origin 分离；公网使用独立 HTTPS hostname。
- 不自动选择真实公网域名或端口；通过显式配置和空闲端口预检启用。没有 provider、认证或实际 PTY 时显示 unavailable，不展示虚假的已连接状态。
- 首版沿用独立的一次性配对 read/write scope。网页登录现有聊天站点不隐式获得终端写权限。配对值不进入 URL、聊天、日志或永久配置；网关登录自动映射不属于首版。
- Host、Origin、同源 CSRF 严格校验；WS 必须在 2 秒内提交绑定 session/attach 的首帧，最多 8 个待认证连接。建连及每次动作都校验 scope、撤销与目标身份；撤权主动断开，不仅在握手检查。
- 只提供固定终端静态资产与闭合 API/WS，不代理项目 HTML、Pi HTTP、任意上游或 Service Worker。CSP、frame-ancestors none、COOP、noopener、no-referrer；不授予 chat/admin CORS。
- 实验认证模块改用 main 的 `withStateWriter` 共同跨进程 writer 和 8MiB 逻辑状态预算，不保留独立 `terminal-auth.lock` 或绕过预算的直接写盘路径。

## 4. 人工控制与聊天屏障

每个 child 的输入所有者是 `local | none | remote(lease) | fenced`。初始为 local，网页终端默认只读。终端 profile 的普通聊天修改请求从启动起一律拒绝，与远程终端是否接管无关。启动时可显式指定 remote 初始方式，但不能从浏览器自行改变启动策略。

本机保留 Ctrl+] 前缀：随后按 `w` 明确让出控制，按 `l` 明确收回；双 Ctrl+] 发送一个原始 Ctrl+] 给 Pi。前缀由固定 relay 消费，不转发成 Pi 命令。帮助必须显示真实手势。普通用户输入不会悄悄转移控制权。

网页显式取得 30 秒固定 writer lease；不自动续期、不因输入延长、不刷新抢占。第二标签只读。撤权、到期、隐藏页面、断线或电脑收回都先 fence，在 sink 确认旧写入通道停止后才能授予下一 owner。在途操作标记 unknown，不重放、不用 ACK 推断命令或记忆提交已完成。

终端 profile 初始化时、任何网页修改入口可能执行之前，就建立 child-global 的只读聊天屏障。网页修改不得进入 SDK、异步预处理、上传或操作队列；原生终端产生的 agent/tool/dialog 工作不受此网页屏障限制。普通模式不建立该屏障。

取得远程控制前，supervisor 与扩展 adapter 仍完成同一身份元组的交互屏障并检查未结束或未知的工作，再锁存 `terminal_untracked`，成功后才能开启远程输入。现有 `latched` 字段仍表示成功的终端准备，不可把“启动即聊天只读”伪报为已取得终端控制。不清除任何原有 unknown、taint 或已提交 latch；若确有无法证明结束的工作仍拒绝接管。失败不会改变终端 profile 本来就只读的聊天策略。

启动屏障覆盖全部浏览器客户端和所有修改入口，不只是隐藏发送按钮：prompt/steer/follow-up、abort、扩展命令、模型/thinking、配置、session/fork/tree/compact、终端 response、上传和 host opener 等均拒绝。只允许明确列举的只读查询；未知方法不能通过 get_ 前缀绕过。保留异步队列实际执行前的检查作为纵深防御，不再把“普通网页聊完后接管”当作受支持路径。

锁存属于当前 child，不属于可重载模块；adapter 重新加载不能清除。`latestCtx`/`latestExecuteCtx` 规则继续遵守。adapter 丢失、session 身份改变、child 替换或 reload 都 fence 当前 lease，旧授权不能自动跟随；新身份需要重新确认并授权。

## 5. 安全刷新与升级

新 profile 从启动即为 `managedRestartEligible:false`，原因 `terminal_profile_unaudited`，不等待第一次按键再判断。

执行点有两处独立拒绝：

1. supervisor 拒绝 terminal profile 的 restart prepare/执行。
2. Gate 根据可信容器 profile 校验拒绝生命周期刷新；不能只相信扩展状态或网页按钮。

全局 runtime 更新可以按原流程安装指定版本，但不得刷新 terminal profile 的现有 Pi；返回明确的“需退出后重新启动”，不无限排队，不伪报成功。普通 inherited-tui 的资格、taint 与现有刷新测试不变。

## 6. 传输、资源及画面

- 一个 child 最多 2 个 reader、1 个 writer。终端不持久化画面、按键、输入草稿、确认预览或输出正文。
- 输入 UTF-8 解码后最多 8KiB，连续 sequence，严格绑定 session/socket/run/runtime/session/terminalEpoch/lease。未知、重复或乱序输入拒绝并 fence，不自动重试。
- 原始输出帧最多 32KiB；每连接队列最多 256KiB；broker 解析积压最多 1MiB。慢读者关闭，不阻塞 PTY。
- screen 最大 240 列 × 120 行、scrollback 最多 1000 行，序列化 snapshot 最多 1MiB。完整画面使用大于 32KiB 的 snapshot 时，必须分成不超过 32KiB 的传输帧，并只允许一个有界重组中的 snapshot；不将多个 snapshot 无界排队。
- snapshot 与增量共享同一水位和串行队列，不用任意 ANSI 尾部伪装完整画面。重组不完整、epoch/尺寸不匹配或解析状态不可靠时拒绝可交互 attach。
- 只有当前 writer 可以 resize，范围 20..240 列、5..120 行并节流。reader 缩放、滚动不能改写 Pi 终端尺寸。
- xterm 禁 stdin 自动回传、自动终端查询回写、OSC52、自动链接、下载、通知及动态标题覆盖可信身份。输入来自独立人工输入框与固定按键枚举，不使用 innerHTML。
- 中文 IME 结束后显式发送；多行粘贴单独确认；首版无 TUI 鼠标协议，不承诺所有窄屏布局完美。
- 日志只有身份、动作类别、字节计数和结果，不记录凭据或内容。provider、broker 的进程/CPU/内存及 Docker 日志均有上限；终端身份和租约过期记录有容量与清理规则。
- main 的历史 256KiB、详情 64KiB、浏览器历史 200 项/512KiB、Hub 8MiB、512 active grants、既有 WS FIFO/连接上限及 tombstone 规则保持不变。终端独立预算不能扩大聊天历史预算。

## 7. 启动、构建与迁移体验

拟新增启动方式：`PI_PIRUN_WEB_TERMINAL=on pirun`。默认 local owner；如确需远程初始控制，显式增加 `PI_PIRUN_WEB_TERMINAL_CONTROL=remote`。这些是本次要实现并测试的接口，当前尚不可用。

pirun 在启动前检查交互 TTY、Hub 登记、支持终端的镜像/provider 与配置；维护命令、print/RPC、无扩展或非交互启动不自动进入终端模式。显式开启而条件不满足时退出并给出原因。

新容器标签声明 profile，entrypoint 按严格 allowlist 路由到新 supervisor 分支。普通 Pi 不增加 provider socket、Docker socket、Gate 凭据或公网监听。`pi-dockerctl` 增加预检/帮助，仍统一调用集中 Compose 配置。

终端页面明确展示当前 run/session 身份、控制所有者、租约剩余、只读状态和两项限制。终端 profile 的聊天侧从首次显示起就说明“本模式聊天只读，请通过终端输入”，并提供非特权新窗口链接；不嵌入终端或持有其配对权限。普通模式不显示此限制。

最终分开交付：仓库代码与 dist、宿主集中配置补丁、新镜像隔离验证、公网上线待办。合并 main 不等于已经更新 Hub 镜像或完成手机连接。现有服务未授权不重启。

## 8. 实施顺序和验收门槛

1. 干净安装与 main 基线：明确固定依赖，复现并解决测试环境不一致；保留主线有界存储/历史改动。
2. 合并实验分支的源代码：逐项审查数学、等待提示与终端模块；冲突在源码解决，重新构建 dist，修正统一 state writer。
3. runtime 接线：真实新 Pi + PTY + 本机 relay + 镜像 broker；先以临时项目、临时 HOME、无个人凭据验证。
4. adapter 启动只读屏障与生命周期拒绝：首次接管前后的全部修改入口、排队中修改纵深检查、reload/session 变化、Gate 双执行点；普通模式可继续网页输入。真实验收必须包含被拒绝的普通网页 prompt 无任何实际执行，随后可取得终端控制并回答原生交互。
5. provider：可信镜像/profile 唯一定位、独立凭据、固定 exec、有界流、退出与异常清理；拒绝 arbitrary argv/path/container。
6. Hub 产品 terminal 页面与 WS：使用真实 runtime/provider，不将 `e2e/harness` 测试宿主当产品服务。
7. 整体真实路径：浏览器 → Hub → provider → 新 Pi，原生确认拒绝无副作用、确认恰好一次、custom 面板操作、中文/IME、resize、Ctrl+C、终端关闭；核对同一 PID。
8. 安全及资源：错 origin/CSRF/scope/epoch、恶意聊天 HTML/SW/opener、自动 ANSI query、两标签、到期断线撤权、在途 unknown、本机收回、慢连接、超限画面、输出洪泛和异常进程清理。
9. main 全量单元、两套类型检查、格式检查、构建/dist 校验、Git 生产安装回归、有界 Hub 回归；UI 做桌面和手机尺寸真实截图检查。手机模拟尺寸不当作手机实机验证。
10. 文档和审查：分别记录通过、跳过、未测与遗留限制；独立代码审查后才合并 main。没有真实 runtime/provider 证据不得宣称生产可用。

## 9. 回滚与未授权事项

回滚只停用新 terminal 配置并回到普通启动方式，保留 Pi 状态卷与项目。不删除 tombstone、不清 taint、不把旧链接改指新 Pi、不重放 unknown 输入。

本设计不授权修改真实 DNS、阿里云 Caddy、SSH 隧道、密码或现有容器；不授权把 Docker socket、管理员密钥、主机根目录或整个 Hub/Gate 私有目录挂给 Pi。宿主 `docker_files` 不在当前工作区写权限内，实施这些改动时通过相应权限流程处理，不绕过沙箱。
