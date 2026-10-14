# Pi Web Hub：一个包，多个 Pi，一个网页入口

扩展包现在有两个角色：每个 Pi 内的 Web 扩展，以及独立运行的
`pi-web-hub` 总管。总管提供登记、会话列表和 HTTP/WebSocket 转发；
**不负责启动 Pi、Docker、SSH 隧道或修改服务器密码。** 普通单会话使用
仍然不需要启动总管。两者均不要求 WSL 专属服务或注入适配器。

## 本地快速开始

### 从当前功能分支安装

本实现目前位于 `codex/portable-web-connection`，未合并 main，也未发布到
上游 npm 包。在**运行 Pi 的同一环境**中安装；Pi 在 Docker 中时，以下命令
应在对应容器终端执行，而不是宿主机的另一个 Pi 配置环境：

```bash
pi install git:github.com/swordfate3/pi-web-ui@codex/portable-web-connection
```

该分支已整合预构建发布改造：普通 Git 安装只需生产依赖，`prepare` 使用
Node 核验随源码交付的网页资源，无需 `npm_config_include=dev`。
后续更新同一来源可执行：

```bash
pi update git:github.com/swordfate3/pi-web-ui@codex/portable-web-connection
```

如果之前启用了本地 release 或 npm 版，应检查 Pi 的 packages/extensions
配置，只启用一份 Web 扩展；安装 Git 源不会自动替你停用另外的本地副本。
更新后重新启动 Pi 最稳妥。拉取扩展不会自动启动总管、增加 Docker 挂载，
也不会修改现有 WSL 服务或公网网关。保留旧服务时，新总管须另选空闲端口，
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
      options: { max-size: "10m", max-file: "3" }
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

## 停止、重启、异常恢复

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
