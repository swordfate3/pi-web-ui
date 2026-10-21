# Pi Web Hub：一个包，多个 Pi，一个网页入口

扩展包现在有两个角色：每个 Pi 内的 Web 扩展，以及独立运行的
`pi-web-hub` 总管。总管提供登记、会话列表和 HTTP/WebSocket 转发；
**不负责启动 Pi、Docker、SSH 隧道或修改服务器密码。** 普通单会话使用
仍然不需要启动总管。两者均不要求 WSL 专属服务或注入适配器。

可选的“运行管理”可以向独立门禁提交 Pi **进程**重启申请，应用已安装的
更新；Hub 自身仍不持有 Docker socket，也不能执行任意命令。此能力需要
管理员预先部署受管启动器和独立生命周期策略，普通安装扩展不会自动启用。

## 有界状态与并发预算（源码实现，部署需先升级 Hub）

**默认最多 8 个并发浏览器 WebSocket 配对，不是 8 个 Pi 容器或登记会话。**
一个打开聊天的手机页面通常占一个配对；多个页面访问同一 Pi 也分别计数。
尚未完成证明/握手的连接也占名额，第九个返回 503，关闭连接后释放。
登记能力另有 **512 个未撤销 grant** 上限；离线 grant 仍计入，不按 TTL 失效。
五个独立 Pi 可同时登记和路由，不受浏览器配对数限制。

固定源码默认值如下，目前没有新增运行时调参接口：

| 资源 | 上限 |
| --- | --- |
| Hub 逻辑持久状态 | 8 MiB（8,388,608 bytes） |
| 普通写入保留的安全余量 | 64 KiB；撤销等安全写入可使用 |
| 未撤销 grant | 512 |
| 浏览器 WebSocket 配对（含等待握手） | 8 |
| 聊天及管理监听器合计原始 HTTP 连接 | 128 |
| 登记 IPC 连接 / 已接纳操作 | 64 / 32；断开的排队操作仍占操作名额直到结束 |
| 并发后端身份证明 | 4；过载拒绝，不把在线路由误判为退役 |
| WebSocket 压缩 / HTTP 静态资源压缩并发 | 2 / 2 |
| 每方向等待转发 | 512 KiB（524,288 bytes），且最多 512 条 |
| 每方向正在发送 | 仅一条，最多 16 MiB（16,777,216 bytes） |

完整未压缩消息字节在保留/发送之前计费，保持 FIFO；发送回调完成且出站缓冲
排空后才释放名额。大于 512 KiB 的第二条消息不能排队。慢消费者以 1013
`Slow consumer; reconnect` 关闭，停滞五秒也会关闭；关闭握手最多再等250毫秒。
正常排空的连接保留显式 1 MiB 文件预览。HTTP 上传/下载继续流式传输，Hub
没有持久响应缓存；HTTP 压缩名额用尽时流式返回 identity。

每个配对最多接纳双向 **33 MiB** 转发 payload，8 个是 **264 MiB**。
在用户提供的512 MiB容器预算内，算术上余下248 MiB还需容纳入站消息、解析/
序列化副本、压缩、HTTP及运行时；**264 MiB不是RSS上界，也不是已经完成的
512 MiB cgroup压力验证**。历史完整信封的256 KiB限制不因16 MiB传输槽而放宽。
部署时继续保留容器memory/tmpfs限制，Docker日志预算为2 MiB × 3；本改动
不修改运行中的Compose、日志驱动、主机或服务。

### 登记兼容与升级次序

先升级/暂停所有CLI管理写入入口，再升级Hub，最后升级Pi扩展；不支持旧CLI
和新写入器混用，也不支持旧/新Hub用不同runtime目录共同服务同一state。
新版扩展首先做经过身份认证、nonce关联且带HMAC的协议协商。只有明确签名的
`UNSUPPORTED_PROTOCOL`并允许`legacy-v1`才回退；旧Hub的通用拒绝、认证失败、
超时或坏回复都不能回退。未修改的旧Hub因此不能自动登记新版扩展。

新Hub继续接受尚未采用有界协议的旧扩展，保留所有旧32hex generation账本，
包括已撤销run的墓碑（防止另一run占用旧URL）。有界generation为
`b2-<32hex boot>-<16hex slot>-<32hex nonce>`；run ID、重启/更新操作ID仍是32hex。
每run只保存一个有界记录，至多包含一个current和一个pending；pending固定五秒，
重试不续期。每次Hub启动持久化新boot，旧current/pending不能恢复权限。
已采用有界登记的run拒绝旧协议重新登记。没有删除旧墓碑的迁移或自动降级。

### 存储、诊断与保守回收

CLI issue/revoke、登记、管理认证、重启回执及执行时钟共用canonical state下的
`.writer.lock`，短事务内重新读取、计费并原子替换；后端证明不占写锁，证明后
在写锁内再次核验grant/boot/revision并发布内存路由。`.serving.lock`保证同一
canonical state只由一个新版Hub服务，原runtime `hub.lock`仍保留。
崩溃遗留锁不自动抢占、不根据PID猜测存活。恢复必须由可信管理员先确认所有
相关服务和写入者已退出，再只处理已核实的具体锁；不要递归删除state。

扫描包括state内未知普通文件和遗留暂存文件，最多32,768目录项、深度4；遇到
不安全权限、链接或无效状态拒绝写入，不删除它们。原子替换的暂存副本也计费。
正常写入不耗尽64 KiB安全余量；既有超额/不安全state不会在升级时被清空，
可能拒绝启动或写入，需要独立受审查的容量恢复，不能保证超额旧状态仍可撤销。

`issue`先持久化权威grant和export字节预留，随后以独占创建发布外部凭据文件。
导出失败或结果不确定时保留可能已生效的grant；不能通过删grant“回滚”。
每个新grant保留`exportBytes`记账，即使启动器后来删掉外部export也不扣回。
这会保守高估占用；升级前外部export没有此字段，不会自动扫描其他目录补账。
普通新写入超额时明确拒绝且不改变既有grant；失败应检查可信管理状态，不要
盲目循环issue。有限存储不承诺无限次创建/撤销run或旧协议generation。

当前不自动删除离线grant、撤销grant、旧墓碑、重启回执或其时钟。有界generation
只在同一run记录中替换旧tuple，拒绝重放不依赖无限墓碑。grant回收缺少完整
在线/等待/接续/重启/在途依赖证明，回执回收缺少Gate终态及幂等保留证明，因此
不启用七天TTL；达到8 MiB或既有1000回执限制时拒绝新操作，不清除安全证据。
原Pi JSONL、模型上下文、项目文件和Gate自己的部署账本不在清理范围内。

已授权的独立管理origin可读取 `GET /api/management/storage`，复用现有管理
会话和网关检查；聊天origin不可用，未授权返回401。返回仅包含逻辑字节、文件/
grant/generation/receipt数量、export预留、预算、安全余量及`overBudget`，
不含路径、token、run ID、会话名或正文；没有新增公开诊断或CLI诊断命令。

### 浏览器历史和详情的独立预算

`state_sync`、`get_history`、`sync_request` 的**完整 UTF-8 JSON 信封**在压缩前
最多 256 KiB（262,144 bytes），包含身份、元数据和信封开销。历史每页最多
40 条、条目数组 192 KiB、单条 16 KiB；树预览最多 200 节点、32 KiB。
超大非历史元数据明确报错，不自动重复请求。日期/旧页选择替换窗口，不累加。

预览不是摘要或源文件修改。用户点击详情后，`get_entry_detail` 每个完整响应
最多 64 KiB，绑定当前 session、runtime、分支叶和条目 revision；下一块替换
上一块，不预取/拼接全文。图片/二进制不以内联 base64 返回。被工具行裁剪挤掉的
结果有单独系统预览行和详情按钮。切换 session/runtime/分支、日期/页面或断线
会清掉旧详情。浏览器保留内容最多 200 项、合计 512 KiB、单项 64 KiB，另加
一个详情块；这不是浏览器总 RAM 或 Pi SDK 历史加载 CPU/内存的上界。

原 Pi JSONL、模型上下文、项目文件、Gate 记录保持原样。首屏 JS/CSS、用户主动
上传/下载、总生命周期流量不受 256 KiB 历史限制。部署必须带重建的 `dist/`，
先协调所有写入入口和 Hub，再更新 Pi/网页；旧 tracked Hub 拒绝新客户端是
安全版本下限，不可通过降低协议校验绕过。隔离验证数字和桌面/390px 图片见
[bounded Hub validation](validation/bounded-hub-state.md)。

## 可选：从手机应用已安装的 Pi 更新

此功能随本仓库 `main` 分发；源码可用不代表既有部署已经升级或启用。

```text
浏览器管理授权 → Hub → 门禁生命周期策略 → 容器内固定管理器
                                                ↓
                           同一终端、同一容器，重启一个 Pi 子进程
                                                ↓
                            核对原会话、原分支、实际加载版本后接续
```

它**不会**运行 npm update、Docker restart、重建容器或批量重启。先通过
正常更新命令将新版本安装到持久化运行目录，再在门户选定会话并重启。
共享卷上更新的安装文件也可能影响其他会话以后的重启，但本操作只重启目标。

管理员一次性接入步骤：

1. 安装新版 pi-docker 镜像和启动器。只有新创建的、保存会话且使用交互终端的
   受管 Pi 支持此能力；旧容器、RPC、print、install/update、无会话运行不支持。
   `/reload` 不能给旧容器安装进程管理器。不要自动结束旧会话来迁移。
2. 门禁单独配置生命周期镜像摘要白名单及 `disabled/manual/auto` 策略。
   默认 disabled，Hub 镜像部署的 auto 不会继承。选 auto 后日常操作不需
   回到电脑逐次审批，但网页仍须管理授权；manual 需要在宿主机审批。
3. 把门禁专用的**生命周期申请凭据文件**复制到 Hub 私有目录，权限0600，
   不挂 Gate state/admin.sock/Docker socket，不使用普通部署申请 token，
   也不把凭据放到共享 Pi home、项目、模型配置或 URL 中。
4. 在 Hub 配置中显式加入以下可选项，重启 Hub 后生效：

   ```json
   {
     "publicUrl": "https://chat.example.com/",
     "management": {
       "port": 16181,
       "publicUrl": "https://admin.example.com/"
     },
     "lifecycle": {
       "endpoint": "http://127.0.0.1:16182",
       "credentialFile": "/hub/private/lifecycle.json"
     }
   }
   ```

   文件格式为 `{"token":"由管理员安全导出的64位凭据"}`。只接受明确的
   IPv4 loopback HTTP endpoint，不跟随重定向，不使用环境代理。
   **独立 HTTPS 管理域名、认证网关及对应转发是部署前提**，上述配置不会创建
   DNS、证书、Caddy 或隧道。管理端口固定监听127.0.0.1；不得把它转发到聊天
   域名的另一个路径。管理 origin 必须与聊天 origin 不同，管理页面只服务可信
   portal、静态资源和管理 API，绝不代理 Pi 页面、文件、WebSocket 或 Service Worker。
   公开管理 URL 要求同时设置规范的聊天 publicUrl；管理卡片链接指向聊天地址。
   本地测试可用 `"management":{"port":0}` 分配隔离端口，省略管理 publicUrl。
   `serve` 的 JSON 会返回带结尾斜杠的本地 `managementUrl`。
   没有 management 配置时**完全不提供管理权限**，即使已经配置 lifecycle；
   没有 lifecycle 时管理页显示未配置。原有聊天和路由不受影响。

   新配置也可用 `pi-web-hub init --config <新文件> --port 16180 --management-port 16181`
   创建；现有配置由管理员保留原字段后加入上述可选项，不要覆盖或删除现有 state。

手机使用（默认配对模式；启用下面的网关登录模式后无需管理码）：

1. 保留原有聊天 HTTPS/网关登录，点击“打开运行管理”进入**独立管理 origin**。
   管理员另在可信终端执行
   `pi-web-hub pair --config <Hub配置文件>`，把一次性32位管理码**直接输入
   门户的“运行管理”**，不要发给模型或放进链接。
2. 管理码10分钟有效、只能消费一次、最多10次错误尝试。解锁后管理会话
   30分钟有效，使用 HttpOnly/SameSite=Strict Cookie；HTTPS 配置要求 Secure。
   不需要日常每次操作都回终端，但到期需重新配对。
3. 在对应卡片选择“重启 Pi · 应用已安装更新”。页面先检查当前身份和空闲状态，
   再确认项目、会话、版本与影响范围。未保存、忙碌、有排队消息、切换/上传/导出
   或压缩中的会话应等待空闲，不会强制停止。
   另有一类不可逆的保守限制：终端按键、粘贴、`!`/`user_bash`、未知 Web 命令，
   或缺失/失效的 stdin guard，使当前进程不能证明可安全重启。此时不是“忙一会儿”：
   等待、取消、会话切换和 `/reload` 都不恢复资格，需管理员在本地正常退出并启动
   新的 Pi 进程。正常终端使用和 `/quit` 不受影响。prepare 期间输入直接抑制、不缓存重放。
4. 保留进度页。重复查询或提交后断网不会再执行一次；未知结果需要查询/检查，
   不应换一个操作编号盲目重试。首次成功必须核验原会话/分支的准确后继。
   已持久化的成功结果不会因后续会话进展、切换、退出或 Hub 重开变成失败；
   但恢复链接仍需当前准确身份和原 generation 的在线证明，不满足时省略链接并说明不可用。
   此时从在线列表明确选择当前会话；历史结果不延长接续期限，也不绕过 run 撤销。
   原聊天网页从旧 WebSocket **实际关闭**起有独立最长120秒接续预算，普通断线仍是15秒。
   手动审批/排队不消耗重启时间。Hub 的恢复核验从 Gate 不可变 `started_at` 起最多210秒；
   管理交接从旧登记退役/断线起最多210秒，轮询或重连不得续期。
5. “锁定管理”只撤销当前浏览器授权，不取消已提交工作。管理员可运行
   `pi-web-hub revoke-management --config <Hub配置文件>` 撤销全部管理授权。
   Hub 重启也会使内存中的浏览器管理授权失效，原操作记录仍可在重新解锁后查询。

关闭预算30秒，不强杀；新进程就绪预算120秒。失败保留会话文件，不自动降级、
重复拉起或重放消息。版本未变化的重启只显示实际版本，不能当作升级成功。
网页显示成功必须同时满足门禁结果和 Hub 的新进程登记，而不是只看 Docker running。
停机前本地检查/prepare 预算15秒，超时禁止发送 SIGTERM；模型同步和启动另有10秒
开销预算，不借用120秒就绪时间。无法中断的 OS 阻塞不保证恢复成功，失败需管理员检查。

guard 是镜像中 root 所有、不可由共享卷替换的固定 Node preload（与 supervisor 同目录）。
它先于 SDK/扩展监听 stdin data；仅验证了 Pi/pi-tui 1.1.0 的此传输路径，其他版本/传输
默认不具备重启资格，直到完成审计。只豁免整包最多4条完整的 `ESC[1;1R`/`ESC[?1;2c`
终端报告（最多28字节）；未知、用户数据混入或分片立即永久锁存不确定性。
不依赖禁用扩展、不读 `.env`、不模拟按键，也不声称隔离同进程恶意代码或任意直接TTY读取。
继承的 Node 预加载/loader 参数会被拒绝；目前仅允许显式的 V8 内存上限选项与固定 guard 共存。

管理状态在 Hub 私有 `state/management.json`，操作回执在
`state/restarts/<幂等编号>.json`；回执只含内部身份，不保存消息或凭据。
回执最多1000个，另受公共8 MiB预算约束，当前不自动清理。仅停止管理操作或
保存审计副本不构成安全删除证明；缺少Gate幂等保留证明时保留回执并拒绝新操作。
首次观察到的执行时间保存在同目录 `<幂等编号>.started.json`，跨 Hub 重启也不会续期。
期限内已核验的恢复保存在 `<幂等编号>.verified.json`，后续查询不会仅因时间流逝改报失败；
仍须通过同一后继的实时身份核验，并且不会延长已激活的浏览器交接租约。
门禁的独立策略和生命周期账本位于门禁自己的 state 卷，不能由普通 Pi 修改。
同 UID、共享 home 和共享运行卷仍不构成恶意 Agent 的完整隔离或多租户授权。

## 本地快速开始

### 可选：沿用网页登录，无需管理码

单用户自托管可以显式信任已有 HTTPS 登录网关：持有该网关有效账号密码的
用户都可申请管理操作，但实际执行仍由 Gate 的独立策略决定。**这不是移除
认证，也不会把手动审批改为自动审批。** 默认不配置此项时保留原有管理码流程。

保留独立的聊天与管理 origin，在现有 Hub 私有配置的 `management` 中加入：

```json
{
  "management": {
    "port": 16183,
    "publicUrl": "https://pi-admin.example.com/",
    "gateway": {
      "credentialFile": "/hub/private/gateway.json"
    }
  }
}
```

`gateway.json` 是由管理员安全生成的0600私有文件，内容为
`{"token":"64位随机小写十六进制网关凭据"}`。这与 Gate 的普通申请或生命周期
凭据都不同；仅登录网关和 Hub 持有，不能放在共享 Pi home、浏览器、链接或日志中。
开启后管理监听器对 HTML、静态资源及 API **逐请求**核验
`X-Pi-Hub-Gateway` 和 `X-Pi-Hub-User`；仅设置用户名、Authorization、cookie
或声称来自 loopback 都不能替代网关证明。轮换该凭据会使旧浏览器管理会话失效。
用户标识限1–128个 Unicode 字母、数字和 `_.@+-`，不接受空格、逗号或控制字符。

网关须先完成原有登录验证，再**覆盖**上游专用头。Caddy 结构示例如下；
凭据用占位符表示，不要把真实值提交到仓库：

```caddyfile
pi-admin.example.com {
    route {
        basic_auth {
            <现有用户名> <现有密码哈希>
        }
        reverse_proxy 127.0.0.1:13002 {
            header_up X-Pi-Hub-Gateway <独立网关凭据>
            header_up X-Pi-Hub-User {http.auth.user.id}
            header_up -Authorization
        }
    }
}
```

管理员应复用现有账号/密码哈希而非设置默认密码；专用头必须由网关覆盖，不能
透传客户端提供的同名值。HTTP 无登录、仅任意注入身份头或依靠来源 IP 的部署
不受支持。不要记录专用头，不向普通 Pi 反向代理传递它们。

若网关在远程服务器，新增独立的**远端回环**反向转发，例如
`-R 127.0.0.1:13002:127.0.0.1:16183`；保留原聊天的13001转发不变。
独立管理域名的 DNS、HTTPS 证书、登录配置和隧道须先验证，再交付手机链接。
Hub 配置本身不会创建这些资源；不得为省去 DNS 而把管理 API 合到聊天 origin。

手机从“打开运行管理”进入管理站点后，页面自动把**已验证的网关身份**交换为
30分钟的 HttpOnly、SameSite=Strict、HTTPS Secure 浏览器管理会话和 CSRF token，
不再显示管理码表单。不同 origin 的浏览器可能再次询问**同一套**账号密码；
这不等于新增密码，也不保证两个站点共享浏览器的 Basic 登录缓存。
会话过期或点击“锁定管理”后，使用“使用网页登录解锁”按钮即可重新进入；
退出后不会后台自动解锁，也不会重发未确认的更新申请。

`POST /api/management/gateway` 只在此模式启用，只接受同 origin 的空 JSON对象，
且必须携带网关证明；该会话建立接口不提交任何管理任务。
其他管理写接口仍同时要求浏览器会话、精确 Origin 和 CSRF。
浏览器会话还绑定网关用户，不能换一个账号继续使用原 cookie。
`pair` 和配对解锁接口在此模式下禁用；`revoke-management` 仍可撤销全部现有
浏览器授权，但不撤销网关账号本身，重新进入仍受网关登录控制。

### 可选：从管理页申请全局 Pi 更新

“重启 Pi · 应用已安装更新”只刷新单个进程，不下载软件。新增的“全局 Pi 更新”
则由 Hub 向 Gate 的 runtime API 申请安装精确版本，再由 Gate 在安全空闲时刷新
共享 `pi-runtime` 的受管 Pi 子进程。它不更新 Web 扩展、Hub 镜像或系统依赖，
也不重建 Docker 工作容器。

管理员先在 Hub **私有配置**中显式配置另一项能力：

```json
{
  "runtimeUpdates": {
    "endpoint": "http://127.0.0.1:16182",
    "credentialFile": "/hub/private/runtime-request.json"
  }
}
```

保留现有 `management`、`publicUrl`、`lifecycle` 等字段。管理页仍须使用独立的
管理监听器/HTTPS origin，以及默认配对或上面显式配置的网关登录；普通聊天 origin 不能调用此接口。
`runtime-request.json` 使用 Gate 的**普通申请凭据**，格式为私有的
`{"token":"64位申请凭据"}`；由管理员通过已有安全渠道配置0600文件并只读挂载。
它与 `lifecycle.credentialFile` 的生命周期凭据用途不同，不能互换，
更不能传入 Gate 管理员凭据、state 卷、Docker socket 或共享 Pi home。
省略 `runtimeUpdates` 时此功能保持未配置，不影响原来的重启或聊天。

使用步骤：

1. 打开独立管理入口，解锁“运行管理”，在“全局 Pi 更新”输入精确稳定版本。
   不接受 `latest`、范围、预发布或构建后缀；公开发布检查不是 Gate 已审核版本列表。
   Gate 当前审核支持哪些 SDK，仍由部署管理员维护；格式正确不代表一定获准。
2. 确认此次影响所有共享运行时的受管 Pi。页面只提交申请，不代替批准。
   Gate runtime 策略为 `manual` 时，在可信宿主终端核对并运行
   `gatectl runtime-approve <任务ID>`；`auto` 也不会跳过镜像、版本和空闲检查。
   Hub 部署的自动策略不自动继承到 runtime 更新策略。
3. 页面展示任务编号、精确版本、安装阶段和逐会话刷新状态。
   正在生成、有排队输入或无法证明安全空闲的会话继续等待；安装完成不等于所有进程
   已刷新。旧容器缺少镜像内的 supervisor/control 时，需先正常退出并使用受信新镜像
   迁移一次；此按钮不绕过兼容检查，也不强行关闭旧容器。
4. 提交前页面在当前浏览器标签的 `sessionStorage` 保存任务ID和版本，不保存管理码、
   CSRF或任何 Gate token。提交响应丢失时只按原ID查询，不自动重复POST。
   Hub重启后需重新解锁，任务仍保存在Gate自己的状态卷；不要换编号盲目重试未知结果。
5. `failed`、`recovery_required` 等状态不显示为更新成功，也不从网页提供强制停止、
   自动回滚、批准、改策略或解除恢复阻塞的功能。锁定管理不会取消已经提交的任务。

受保护接口：`GET/POST /api/management/runtime-updates` 和
`GET /api/management/runtime-updates/<ID>`。Hub只向固定的Gate `/v1/runtime-updates`
路由转发白名单字段；不接受任意地址/命令，不跟随重定向，响应有大小及时间上限。
任务回显不包含镜像策略摘要、凭据、容器身份、会话路径或安装助手内部记录。
读取 Gate 的每次响应限时5秒、最多16 MiB；历史保留最近100个任务。
目标记录会跨容器退出和更替累计，不按128个在线使用者的限制拒绝合法历史。
单个任务在页面最多展示128条目标记录，优先非退出目标，超出会明确提示总数及展示上限；
这不改变 Gate 的任务执行、完成判断或历史记录。超过响应预算时显示查询不可用，
不能据此认为任务已失败、取消或可重新提交。

### 从 main 安装与更新

本仓库 `main` 包含 Web 扩展和独立 Hub，未发布到上游 npm 包。
在**运行 Pi 的同一环境**中安装；Pi 在 Docker 中时，以下命令
应在对应容器终端执行，而不是宿主机的另一个 Pi 配置环境：

```bash
pi install git:github.com/swordfate3/pi-web-ui@main
```

仓库已整合预构建发布改造：普通 Git 安装只需生产依赖，`prepare` 使用
Node 核验随源码交付的网页资源，无需 `npm_config_include=dev`。
后续更新同一来源可执行：

```bash
pi update git:github.com/swordfate3/pi-web-ui@main
```

更新命令应与 Pi 中登记的来源一致：未带 `@main` 安装的来源，更新时也不带后缀。
仍固定到旧功能分支的来源需要显式迁移到 `main`，不能靠更新旧分支获得新代码。
如果之前启用了本地 release 或 npm 版，应检查 Pi 的 packages/extensions
配置，只启用一份 Web 扩展；安装 Git 源不会自动替你停用另外的本地副本。
Hub 的独立 JavaScript 构建内嵌包版本和与 `dist/build-manifest.json` 相同的源码指纹；
即使镜像只携带 Hub 构建文件，也不再依赖附近的 `package.json` 报告自身版本。
该信息描述构建，不是代码真实性证明。源码直接运行仍读取包目录元数据。
公开 Web 参考版本先通过 GitHub REST 查询 `main` 的提交号；失败时只尝试固定仓库的
Atom 提交源，随后仍按同一个不可变提交读取版本和构建清单。限流或两个来源均失败时
如实显示检查不可用；不会把本机 Hub 版本当作公开最新版。

更新后重新启动 Pi 最稳妥。拉取扩展不会自动更新或重启独立 Hub/Gate 容器、
重建 Pi 容器、启用生命周期策略、启动总管或增加 Docker 挂载，
也不会修改现有 WSL 服务或公网网关。通过镜像部署的 Hub 仍需单独部署包含
新产物的镜像；运行管理还需完成上面的独立授权与受管启动器接入。
保留旧服务时，新总管须另选空闲端口，
并使用独立 runtime/state，不能与旧路由同时占用默认 16180。

### 启动总管与登记 Pi

需要 Node.js >=22.19、Linux 和已安装的 Pi。总管使用 Unix socket，
设计也支持 macOS，但本次仅验证 Linux；原生 Windows 暂不支持总管。
在安装了依赖、已构建的扩展仓库内执行：

```bash
PI_WEB_PACKAGE="$PWD"
PI_HUB_DIR="$HOME/.pi/web-hub"
node "$PI_WEB_PACKAGE/dist/hub/pi-web-hub.mjs" init --config "$PI_HUB_DIR/config.json"
node "$PI_WEB_PACKAGE/dist/hub/pi-web-hub.mjs" issue \
  --config "$PI_HUB_DIR/config.json" \
  --output "$PI_HUB_DIR/session-a.json" --label "项目 A"
node "$PI_WEB_PACKAGE/dist/hub/pi-web-hub.mjs" serve --config "$PI_HUB_DIR/config.json"
```

`serve` 是前台进程，会显示入口和 socket 路径；不要关闭这个终端。
默认入口为 `http://127.0.0.1:16180/sessions/`。另开终端，在项目目录启动 Pi：

```bash
PI_WEB_UI_REGISTRY_SOCKET="$HOME/.pi/web-hub/runtime/registry.sock" \
PI_WEB_UI_REGISTRY_CREDENTIAL_FILE="$HOME/.pi/web-hub/session-a.json" \
pi
```

Pi 须已安装本分支的 Web 扩展。开发时可用 `pi -e` 显式加载仓库的
`extensions/mirror-server.ts`，不要同时加载安装版与仓库版。
Pi 的 Web listener 随进程启动并自动登记；`/webui` 仍用于启用需要新鲜
命令上下文的高级操作。网页刷新不会替代这一步。

第二个 Pi 要再次 `issue`，用不同输出文件和名称，把新的文件传给它。
**每个同时运行的 Pi 都必须有独立凭据；不能所有容器共用 session-a.json。**
不论从哪个项目启动，都在同一个 `/sessions/` 页面选择会话；无需记端口。
CLI 被安装到 PATH 时可直接使用 `pi-web-hub`，否则使用上述脚本路径。

## 版本与更新展示

入口页增加只读的「版本与更新」区域；每张会话卡片在名字下单独列出 **Pi 版本、
Web 扩展包版本与构建指纹**。非受管 Pi 也可上报，显示版本不授予任何重启权限。
旧客户端未上报时显示「未上报」；仅上报旧 runtime 元数据时保留其 Pi 版本显示。

- 版本由 Pi SDK 的 `VERSION` 与扩展初始化时读取的包元数据组成。后续登记续期不重读
  磁盘；更新共享卷文件后，旧进程不会仅因心跳而显示新版本。扩展 reload 会重新捕获
  Web 元数据，但不会升级 Pi CLI 本体；Pi 本体需独立进程刷新。
- 本包的包版本可能不随每次 Git 提交变化，因此同时展示 manifest `source.sha256`
  的前八位（完整值在 tooltip）。它是包声明的构建指纹，不是 Git commit，也不是
  对已加载机器代码、完整性或真实性的证明。缺少 build manifest 时仍显示已知版本。
- Hub 自身版本来自其启动时捕获的包元数据，不从某个 Pi 会话推测。Hub 与扩展同包
  分发，但各自独立启动，更新磁盘上的包不代表 Hub 已重新加载。
- Hub 在首次读取会话列表时异步查询固定公开源：npm registry 的
  `@earendil-works/pi-coding-agent/latest`，以及 GitHub `swordfate3/pi-web-ui` 的 `main`。
  Web 的包版本与 manifest 始终绑定同一次 ref 解析得到的 commit。只发送固定公开
  GET 请求，不发送任何会话、工作区、模型配置或凭据；不跟随重定向。
- Pi 发现更高的公开稳定语义版本时显示「可更新至…」；本地版本高于发布版则单独
  提示。Web 相同包版本、构建不同只显示「与发布构建不同」，不判定一定落后；本地
  修改、其他分支或较新开发版也可能不同。预发布版本不猜测升级顺序。
- 成功与失败均至少缓存五分钟；手动「刷新」只更新会话列表，不强行绕过缓存。
  请求独立限时、整体有截止，列表不等待外部检查。单源失败保留当次另一源的有效信息，
  全部失败则明确显示「更新状态未知」，不拿旧结果冒充最新。`PI_OFFLINE=1` 可禁止
  Hub 的公开源访问。检查不扫描其他扩展，也不调用 Gate／自动安装或重启。

需要新版 Hub **和**目标 Pi 内加载的新版扩展才能完整显示；旧客户端不会自动补出
缺失版本。[验证记录](validation/hub-version-display.md)区分单元、真实 Pi 后端与合成浏览器检查。

## 会话卡片名称

卡片显示项目／文件夹标签，第二行显示 **Pi 会话名字**，不再展示内部随机 ID。兼容旧启动器的 `文件夹 · 8位十六进制ID` 标签：仅在卡片标题、tooltip 和搜索中去掉该精确后缀（大小写均支持）；原始 API label、grant 和路由保持不变。其他分隔符、非十六进制／不同长度后缀不改，剥离后为空则保留原标签。未命名或旧版 Pi 未上报名字时显示「未命名会话」。可以在 Pi／会话网页中用 `/name 名字` 命名。网页 `/name` 或设置改名后立即请求登记刷新，正常本地链路在改名确认前完成；等待预算最多 250ms，超时不把成功改名报成失败，后台请求与每 15 秒续期继续补偿。终端改名仍由续期读取。总管页面每 5 秒刷新，也可手动刷新；慢链路不能承诺返回时名字必已同步。搜索同时匹配项目标签与会话名字。

会话名字仅是显示元数据（最多 256 个 UTF-16 code units，控制字符规范化），不用于认证、链接或路由。同名会话仍以项目标签区分，各自链接保持独立；改名不轮换 generation，不改变 `since`。Hub 不读取会话正文、不以提示词生成名字。名字是本总管入口可见的会话元数据，不应在名字中放密码或密钥。

需要加载新版 Pi 扩展和新版 Hub 才能看到此行为；只更新磁盘上的包不等于运行中的总管已重新加载。维护者不自动重启用户 Hub 或 Pi。包内 Hub 兼容旧客户端省略 `sessionName`；未验证包外旧 registry 是否接受此可选字段。

## 进入会话与返回总管

Hub 会话路径 `/s/<generation>/` 顶栏有「← Hub」链接，始终回同源 `/sessions/`，不依赖浏览器历史中上一页是谁；普通独立 Pi 入口不显示该链接。它不停止 Pi 或取消正在运行的模型回复。未发送文字、排队消息、已选附件及上传交接存在时，普通点击先确认，取消保留当前页；确认离开会丢失这些浏览器临时状态，已落盘文件不删除。浏览器原生后退／刷新不在这个按钮确认的保证内。

进入链接立即显示「正在打开…」，入口 HTML 提供静态加载提示，未变化的列表轮询保留卡片及焦点。从浏览器历史缓存恢复时重新拉取列表，已有请求执行中则合并一次后续刷新；不缓存真实会话内容、不跳过 backend proof，不承诺公网零等待。会话切换通过显式路由事件同步前端 scope，不再每 100ms 轮询；旧上传仍按 identity／scope 失效。首次 Git 刷新合并到快照后的 debounce，保留 bounded history 同步及重连逻辑。

详见[Hub 导航体验验证](validation/hub-navigation.md)。扩展、网页资源和独立 Hub 均需更新才完整生效，不自动重启生产实例。

## 集中配置与持久化

默认配置是 `~/.pi/web-hub/config.json`，支持 `--config` 指定位置。
也可设置 `PI_WEB_UI_HUB_CONFIG`；显式 `--config` 优先于该环境变量。
`init` 不覆盖已有配置，`issue` 不覆盖已有凭据；文件不输出 token 原文。
配置文件示例：

```json
{
  "host": "127.0.0.1",
  "port": 16180,
  "leaseMs": 45000,
  "stateDir": "state",
  "runtimeDir": "runtime",
  "publicUrl": "https://agent.example.com/"
}
```

`publicUrl` 可省略，只是浏览器地址与 Host/Origin 白名单，不建立隧道。
它必须使用域名根路径。目录路径相对配置文件所在目录解析。
普通 Pi 每 15 秒续期，使用默认 45 秒租约；不要把生产租约设得比续期间隔短。
配置、凭据为 `0600`；state/runtime 目录为 `0700`，必须属于运行用户。

| 内容 | 用途 | 哪个进程读取 | 是否持久化 |
| --- | --- | --- | --- |
| `config.json` | 端口、地址、目录设置 | 总管 | 是 |
| `state/grants/` | 签发/撤销记录 | 仅总管管理员 | 是 |
| `state/generations/` | 已使用链接的归属与失效记录 | 仅总管 | 是 |
| `runtime/registry.sock` | Pi 登记通信 | 总管和获授权的 Pi | 运行时入口 |
| `runtime/hub.lock/` | 总管独占启动锁 | 总管；Pi 不应改动 | 正常退出删除 |
| `session-a.json` | 单个 Pi 的凭据 | 管理员及对应 Pi | 是，单文件只读传入 |
| 在线会话列表 | 活跃租约 | 总管内存 | 否，由 Pi 重新登记 |

聊天内容和 Pi 历史仍由 Pi 自己保存，不复制到总管。generation 记录会随
会话累积，本版本不自动清除，防止旧链接复用；管理员需监控卷大小。
撤销能力用 `revoke --run-id <签发时的 runId>`；最迟在下一次路由访问或
租约扫描时关闭其会话。不要删除 generation 记录来“清缓存”。

**不要将总管管理员 state 放进所有 Agent 共享的 home 卷。** Docker 中
可以使用一个总管专用卷持久化 config/state，但该卷只能挂给总管。
Pi 只需 runtime 的只读目录挂载和自己的凭据文件。只读 socket 目录
仍可发送 IPC 请求，需数字 UID 对齐；它不是跨同 UID 的完整安全边界。

## 独立 Docker 总管示例（不依赖 WSL 服务）

以下是可供管理员调整的 Linux Compose 片段，**不是自动部署脚本**。
先准备与容器 UID 1000 对齐的私有配置和 runtime 目录，按前述方式
初始化配置、为每个 Pi 签发文件。示例配置使用
`runtimeDir: "/run/pi-web-hub"`；不要使用宿主绝对路径作为容器内路径。
镜像需含 Node、扩展包、`ws` 运行依赖和已构建资源，并明确指定标签或 digest。

```yaml
services:
  pi-web-hub:
    image: ${PI_WEB_HUB_IMAGE:?Set a reviewed image tag or digest}
    user: "1000:1000"
    network_mode: host
    entrypoint: ["node"]
    command: ["/opt/pi-web-ui/dist/hub/pi-web-hub.mjs", "serve", "--config", "/hub/private/config.json"]
    volumes:
      - ./hub-private:/hub/private
      - ./hub-runtime:/run/pi-web-hub
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 512m
    cpus: 1
    logging:
      options: { max-size: "2m", max-file: "3" }
```

普通 Pi 容器额外只需：

```text
./hub-runtime -> /run/pi-web-hub （只读目录）
./credentials/session-a.json -> /run/secrets/pi-web-session.json （只读文件）
PI_WEB_UI_REGISTRY_SOCKET=/run/pi-web-hub/registry.sock
PI_WEB_UI_REGISTRY_CREDENTIAL_FILE=/run/secrets/pi-web-session.json
```

默认 `backendHost=127.0.0.1` 要求总管与 Pi 位于同一个网络命名空间；
本例 Linux host networking 满足这一条件。bridge 网络里，不能把容器
loopback 当作宿主地址：需要管理员规划可达地址、监听与网关安全边界，
并在 `issue --backend-host` 中授权具体目标。登记客户端不能自行指定主机。
示例不挂 Docker socket，不使用 privileged、host PID 或宿主根目录。
新挂载必须重建容器；`/reload` 不能增加挂载。

## 手机、阿里云和登录边界

```text
手机 → HTTPS + 登录网关 → 反向隧道 → pi-web-hub
                                        ├─ Pi A
                                        └─ Pi B
```

将已有经过认证的网关和隧道指向**总管端口 16180**，转发所有路径和
WebSocket，保留浏览器的 Host/Origin；不要只转发 `/sessions/`，也不要
再为每个 Pi 手动开公网端口。总管配置的 `publicUrl` 应与网关域名一致。
**总管没有自己的登录认证，不能直接公开到互联网。** 登录、TLS 和隧道
仍需可信外部设施；扩展内的登录管理引导并未自动部署这个总管。
现有远程向导的新部署模板仍是单会话，不要把它当多会话安装器。

本次仅新增本地包能力，不关闭旧 WSL 服务、不迁移线上密码、不更新
实际 pirun 挂载。切换真实部署前先在隔离端口验证登记、HTTP、WS、
手机可达、认证，再替换旧路由；不要启用两个登记适配器。

## 慢隧道下的传输与浏览器缓存

Hub 在本机、HTTPS 网关在远端时，网关开启压缩仍可能太晚：未压缩的文件
已先经过慢隧道。Hub 现在在发送到隧道**之前**流式压缩明确匹配
`/assets/<名称>-<至少8位版本哈希>.js` / `.css` 的静态资源，按浏览器
`Accept-Encoding` 协商 Brotli（质量4）或 gzip（等级6）；不支持时保留原字节。
压缩遵循背压，不把整个文件收集到 Hub 内存。

只有 GET/HEAD、200、匹配 JS/CSS MIME、无查询参数/Range、后端未声明缓存策略、
未设置 Cookie/下载标记/已有编码的版本化资源，才返回
`Cache-Control: private, max-age=86400, immutable` 和 `Vary: Accept-Encoding`。
这只允许浏览器私有缓存一天，不创建 Hub/CDN 共享缓存。HTML、API、下载、错误、
旧 generation、查询参数路径和后端声明不缓存的内容仍是 `no-store`；会话挑战、
Origin 校验和 generation 失效规则不变。已缓存的前端程序不代表仍有会话权限。

浏览器方向的 WebSocket 协商 `permessage-deflate`，两端均禁用跨消息 context
takeover，窗口12位、压缩并发2、阈值1024字节；未协商压缩的客户端继续工作。
不兼容上述窗口参数、未协商或未识别的压缩提议会退回普通WebSocket连接，
不会因可选压缩阻止客户端接入。本地Pi连接移除浏览器的扩展协商头，不额外压缩；
JSON/二进制消息解压后的字节不变，16 MiB单消息上限保留；转发改为每方向
512 KiB等待队列加一条最多16 MiB在途消息，并保留排空/超时检查。
不会修改、删除或重新压缩磁盘上的会话记录。
这能减少传输量，但不保证消除网络吞吐、浏览器渲染或大型会话的全部延迟。

仅静态压缩优化可只更新 Hub；本版有界登记/历史/详情须遵循上面的全写入器、
Hub优先和Pi/网页更新次序，不需要改变隧道/登录配置。Hub 重启会短暂
断开网页、轮转会话链接，部署后从总入口重新选择在线会话。代码构建通过不等于
线上已部署；按既有发布和 Gate 审核流程更新，不用本地 bundle 绕过审批。

## 停止、重启、异常恢复

- `/new`、`/resume` 等替换同一个 Pi 的会话时，旧链接仍然失效，但已打开
  的新版网页会凭 Hub 发给它的短时交接凭证，自动等待并连接这个 Pi 的
  第一个新登记；地址随之更新，不用返回总管，也不重发会话切换操作。
  凭证仅在内存中，断线后最多有效 45 秒，网页自动等待最多 15 秒。
  撤销、超时、总管重启或新登记再次失效时，需返回总管重新选择。
  旧书签、新标签页不会继承交接权限，也不会被引到别的 Pi。
- 退出一个 Pi：它的登记和 WebSocket 消失，其他 Pi 不受影响。
- Pi 异常退出：租约过期后消失，不从磁盘复活在线条目。
- 总管正常退出：关闭转发与登记连接，删除独占锁，不结束 Pi 进程。
- 总管重启：先显示空列表；仍在运行的 Pi 随续期生成新链接并重新登记。
  默认客户端轮转可能需要两个 15 秒续期间隔。旧链接返回 `410`。
- 两个总管争同一个 runtime：只允许一个启动，不抢占现有 socket。
- 总管被强杀/机器断电：锁可能残留，启动**拒绝自动抢锁**。管理员先
  确认旧总管确实不在运行，再处理配置对应 runtime 内的
  `hub.lock/owner.json` 和空 `hub.lock/`；不要只凭 PID 消失或复用自动清理。
  之后启动总管，它会检查并回收已无监听进程的旧 socket。

backend 挑战与请求证明用来防误登记和失效链接复用，不保证抵御拥有
同一 OS UID、管理员卷或目标网络控制权的攻击者。两个后端 TCP 连接
间仍存在端口/目标变化的时序边界；不要据此承诺绝对防逃逸或零泄露。
总管的 portal 不显示 token、宿主绝对路径或对话内容。

## 开发中：独立终端授权入口（不等于终端可用）

同一 WebUI 包的 Hub 新增可选 `terminal` 配置；默认不启动第三监听器。当前仅实现独立、绑定精确目标的授权与状态，**尚无终端页面、PTY/provider、输出流或按键输入**。即使配对成功，`GET /api/terminal/status` 也返回 `available:false` 和 `terminal_backend_unavailable`；不能用它批准正在等待的记忆确认或操作 `/mcp`。

隔离开发环境可在新配置中显式选择，以下不是生产启用指令：

```json
{
  "port": 16180,
  "publicUrl": "https://chat.example/",
  "management": { "port": 16181, "publicUrl": "https://admin.example/" },
  "terminal": { "port": 16182, "publicUrl": "https://terminal.example/" }
}
```

本地测试可省略所有publicUrl并将三个port设为0取得空闲端口；终端固定绑定127.0.0.1，local/public origin均不能与chat/admin重复。公网终端必须独立HTTPS origin；不能把 `/api/terminal` 通过已有聊天origin转发。未配置公网入口时不自动配置DNS/TLS/隧道；终端暂不支持management.gateway自动登录。

可信Hub CLI新增：

- `init --terminal-port <port> [--terminal-public-url <HTTPS root URL>]`：只在新配置中记录，不打开监听器。
- `serve`：显式配置时在现有Hub进程内启动terminal listener，ready JSON增加 `terminalUrl`。
- `pair-terminal --run-id <32hex> --runtime-id <id> --session-id <id> --terminal-epoch <32hex> --access <read|write>`：由管理员选择准确child scope并生成10分钟单次码；stdout含配对秘密，**不可粘到模型聊天/日志/URL**。现阶段没有broker提供真实terminalEpoch，只有合成fixture可以端到端验证这条命令；不要为当前生产Pi编造epoch。grant存在不证明child存活/可接终端。
- `revoke-terminal`：撤销全部terminal浏览器会话与未消费配对码，不撤销management登录或普通Pi登记。

终端认证使用Hub私有 `terminal-auth.json`（0600）和独立cookie/session/CSRF，session最长30分钟；read权限不会升级write，授权不自动跟随新Pi或会话。Cookie不按端口隔离，聊天转发仍剥离Cookie/Authorization/`x-pi-hub-*`。配对／签发／撤销使用同一 `terminal-auth.lock/` 保护完整读改写；竞争直接失败，不假报撤销成功。进程异常退出可能留下锁，须管理员确认Hub及相关CLI已停止后处理**该配置stateDir下的这个空锁目录**，不自动抢锁或删除授权state，不靠等待清除权限。

目前所有Upgrade/CONNECT、Pi静态资源/HTTP代理、Service Worker、attach/write接口均拒绝。接入真实终端前仍须完成runtime/Gate源码开发、主动流式撤权、同进程证明与真实Browser边界验证；本段不是上线承诺。设计、实际测试和未测范围见 [ADR0018](adr/0018-trusted-terminal-extension-compatibility.md)。

### 应用会话交接修复

自动交接需要同时更新独立 Hub 和 Pi 提供的网页资源。只更新 Pi 扩展或
只刷新浏览器无法补齐旧 Hub 的交接接口。由管理员安排重建／更新 Hub
并重启它，保留原配置、私有 state/grants 和 runtime 挂载；不要删卷。
Hub 重启会断开现有网页连接，完成后先从总管重新打开会话。再按原安装
来源更新 Pi 扩展并重新启动／重载，刷新网页取得新版资源。此文档和本地
测试不会自动执行这些生产操作，也不要求改变现有 SSH／Caddy 转发目标。
