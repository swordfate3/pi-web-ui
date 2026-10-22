# Pi Web UI

给 [Pi coding agent](https://github.com/badlogic/pi-mono) 使用的浏览器界面：在电脑或手机上查看消息、工具执行、思考过程和会话分支，与终端操作同一个 Pi 会话。

> 本分支维护于 [swordfate3/pi-web-ui](https://github.com/swordfate3/pi-web-ui)，基于 [kkkiio/pi-web-ui](https://github.com/kkkiio/pi-web-ui)，上游最初派生自 [deflating/tau](https://github.com/deflating/tau)。感谢原作者，保留 MIT 许可及来源说明。
> 本分支基于 **1.0.1**，保留普通网页聊天、模型选择、数学显示与 Hub 运行管理。独立原生终端已归档至 `codex/archive-native-terminal-20261022`，不属于当前 main 的安装内容；见[归档与部署边界](docs/native-terminal-archive.md)。本 fork 未发布到上游 npm 包。

![Pi Web UI example](docs/images/pi-web-ui-example.png)

## 先选使用方式

| 需求 | 使用方式 |
| --- | --- |
| 在电脑上操作一个 Pi | 安装 Web 扩展，在 Pi 终端执行 `/webui`；不需要额外 Hub 进程 |
| 手机访问一个 Pi | Web 扩展加可信 HTTPS／登录入口；远程向导提供配置材料 |
| 多个 Pi 共用一个入口 | 单独运行 `pi-web-hub`，每个 Pi 独立登记，在 `/sessions/` 选择 |
| 从手机应用 Pi 更新 | 另行接入独立管理入口、Gate 和受管启动器；普通安装不会自动启用 |

**三个概念不要混淆：**

- **Pi 本体**：运行模型、工具和会话的 CLI。
- **Web 扩展**：加载在每个 Pi 内，提供该会话的网页与 HTTP/WebSocket 服务。
- **Hub**：同一项目／发布包中的独立总管，负责在线列表和转发。它不替你启动 Pi，也不会因更新扩展包而自动重启。

## 1. 安装与首次打开

### 环境要求

- 已安装并配置可用的 Pi；本包声明 Pi `>=1.1.0`。
- Node.js `>=22.19`，推荐 Node 24。
- 本地单会话不要求 Docker、WSL、Hub 或 SSH。Hub 使用 Unix socket，目前主要验证 Linux，原生 Windows 不支持此登记方式。

在**实际运行 Pi 的同一环境**安装；Pi 在容器中就到对应容器终端执行：

```bash
pi install git:github.com/swordfate3/pi-web-ui
```

Git 安装包含预构建资源，只安装运行依赖 `ws`；不用手动编译、安装开发依赖或设置 `npm_config_include=dev`。`prepare` 会核验随包文件。

然后：

1. 在项目目录启动 `pi`，完成模型配置。
2. 在 **Pi 终端交互界面**输入 `/webui`，不是在 Bash 中执行。
3. 打开 Pi 显示的实际地址。默认从 `http://127.0.0.1:3001` 开始，端口占用时会有界尝试后续端口。
4. Docker 或无桌面环境无法自动打开浏览器时，手动打开显示的地址；容器网络／端口可达需单独配置。

扩展通常随会话启动监听。`/webui` 还用于捕获高级会话操作所需的命令上下文；仅刷新浏览器不能替代它。新建、切换会话或 reload 后，如提示高级能力未启用，在对应 Pi 终端再次执行 `/webui`。

| Pi 终端命令 | 用途 |
| --- | --- |
| `/webui` | 显示／打开入口，启用高级会话操作 |
| `/webui-stop` | 停止当前 Pi 的 Web 服务，不退出 Pi |
| `/webui-start` | 再次启动当前 Pi 的 Web 服务 |
| `/webui-setup` | 打开本地远程访问／登录管理引导，不直接修改服务器 |

**只启用一份 Web 扩展。** 如果以前装过 npm 版、本地 release 或其他 Git 分支，先核对 Pi 的包／扩展配置，避免重复加载。`npm:@kkkiio/pi-web-ui` 是上游包，不等于本 fork，也不包含这里全部功能。

## 2. 日常使用

### 聊天、模型与文件

- 终端和网页共享同一会话，实时展示消息、思考和工具调用。
- 通过模型选择器选择模型，切换 thinking 等级；支持中英文、浅色／深色／系统主题。
- 正在生成时的后续消息按界面支持的排队方式处理；不要在连接结果未知时重复发送。
- 点击回形针“上传文件”、拖入文件或粘贴图片。默认一次最多 5 个文件，每个最多 **1 GiB**，以 **8 MiB** 分块上传，支持进度、取消及从已确认块重试。
- 刷新后需重新选择同一原文件，且仍在同一运行会话内，才可恢复上传。文件先保存在工作区 `.pi-uploads/<session>/<upload>/`，再将路径交给 Pi；图片不是自动内联进模型的图像输入。
- 回复中的受支持项目文件路径可点击确认下载，保留原文件名；直接访问和经 Hub 访问均支持。

详见[上传说明](docs/prd/file-uploads.md)、[下载边界](docs/prd/file-downloads.md)和[斜杠命令支持表](docs/slash-command-support.md)。网页不是所有终端功能的等价替代。

### 编辑问题、重答与版本翻页

1. 在已保存的用户消息下选择“编辑并重新发送”，修改问题并确认。
2. 在已保存的 AI 回答下选择“重新生成回答”，核对原问题后确认。
3. 两种操作均从原问题之前的上下文创建新分支，保留旧问题和旧回答；可能重新执行工具并消耗 Token。
4. 同一上下文位置有多个用户版本时，问题／回答下显示 `‹ 1 / 2 ›` 等翻页按钮。切换的是整个已保存会话路径，后续对话也随分支变化；版本切换本身不会再次发送问题。

**切换分支不是文件回滚。** 之前的文件修改、外部请求和部署不会被撤销。忙碌、上传、排队、断线、缺少 `/webui` 上下文或无安全目标时，相关操作会被禁用。

若出现 `Message revision dispatch is pending or unknown`：到对应 Pi 终端检查，**不要自动重发、强制解锁或把 `/reload` 当作通用清锁方式**。操作 ACK／超时并不证明问题已被 Pi 接受或已安全取消。

### Tree 与历史范围

- Tree 展示当前会话的分支；普通节点点击用于定位，不静默覆盖输入草稿。按分支操作继续已有路径或从用户消息分支。
- 默认只加载最近三个日历日，可调整日期查看更早历史；历史按窗口分页，不一次下载整个会话。
- 版本切换不解除日期筛选，目标不在范围内时先调整日期。超大条目可能仅显示预览，原始 Pi 会话文件保持不变。
- `/resume` 选择已保存会话；Hub 列的是**在线 Pi**，不是全部历史记录。

详见[消息分支说明](docs/prd/branch-message.md)。

### 可选：网页鲸鱼娘

在“设置 → 鲸鱼娘”开启并导入本地 PNG/WebP/GIF：至少一张待机图，最多五个状态，每张 ≤2 MiB、每边 ≤2048 像素。支持拖动、收起、关闭和点击反馈，互动不调用模型。

素材只保存在本浏览器当前站点，不上传给 Pi，也不随包分发。GIF 在减少动画模式下显示静态首帧。Token／费用是按会话及响应模型估算，缺少价格时显示未知，不等于实际账单。详见[鲸鱼娘说明](docs/prd/whale-companion.md)。

## 3. 多会话 Hub

已有管理员配置好的 Hub 时，直接打开该入口的 `/sessions/`，搜索项目／会话并选择“打开会话”。会话页面的“← Hub”返回同源总览；不会退出 Pi，但离开前应处理未发送草稿和附件。

### 本地最小接入示例

以下为**新建本地 Hub**示例，不覆盖已有服务配置，不创建公网登录或隧道。已有 Hub 不要重复初始化或争用同一个 runtime。

先定位已安装包。下方是普通 Git 安装的常见路径；若更改过 Pi 配置目录／安装来源，请使用实际路径：

```bash
PI_WEB_PACKAGE="$HOME/.pi/agent/git/github.com/swordfate3/pi-web-ui"
PI_HUB_DIR="$HOME/.pi/web-hub"
test -f "$PI_WEB_PACKAGE/dist/hub/pi-web-hub.mjs" || exit 1

# 初始化独立配置，并为第一个 Pi 签发独立文件
node "$PI_WEB_PACKAGE/dist/hub/pi-web-hub.mjs" init --config "$PI_HUB_DIR/config.json"
node "$PI_WEB_PACKAGE/dist/hub/pi-web-hub.mjs" issue \
  --config "$PI_HUB_DIR/config.json" \
  --output "$PI_HUB_DIR/session-a.json" --label "项目 A"

# 前台运行，保留此终端
node "$PI_WEB_PACKAGE/dist/hub/pi-web-hub.mjs" serve --config "$PI_HUB_DIR/config.json"
```

另开终端，在项目目录启动已安装扩展的 Pi：

```bash
PI_WEB_UI_REGISTRY_SOCKET="$HOME/.pi/web-hub/runtime/registry.sock" \
PI_WEB_UI_REGISTRY_CREDENTIAL_FILE="$HOME/.pi/web-hub/session-a.json" \
pi
```

在 Pi 中执行 `/webui`。默认 Hub 入口为 `http://127.0.0.1:16180/sessions/`；以 `serve` 实际输出为准。第二个同时运行的 Pi 要重新 `issue`，使用不同输出文件／标签，**不能共用 session-a.json**。

Docker 部署还需管理员配置网络与挂载：Hub 私有 config/state 不共享给普通 Pi；Pi 只读挂 runtime 目录和自己的凭据文件。新增挂载需要重建选定容器，`/reload` 无法补挂载。完整配置、持久化及手机接入见 [Hub 操作指南](docs/hub.md)。

### 怎样看版本

| 显示位置 | 含义 |
| --- | --- |
| 顶部 Hub 版本／构建 | 当前 Hub 构建的身份，不从某个 Pi 会话推测 |
| 顶部公开发布 Pi／Web 版本 | 从固定 npm／GitHub 公开源查询的参考值，不是安装命令或已审批列表 |
| 会话卡片 Pi／Web 扩展版本 | 对应 Pi 进程实际加载时捕获并上报的信息，不是磁盘现有文件版本 |

- **未上报**：旧客户端没有提供元数据，或该运行环境读取不到元数据，不代表没安装扩展。
- **更新状态未知／部分信息不可用**：公开源请求失败、限流、超时或离线。已知运行版本和公开参考版本是两回事。
- **与发布构建不同**：包版本相同但源码指纹不同，不直接断言谁更新；指纹不是 Git commit，也不证明代码真实性。
- 更新扩展文件后，旧 Pi 的登记心跳不会把显示伪装成已加载新版。刷新浏览器也不会加载 Pi 扩展。
- 发布检查至少缓存五分钟；手动刷新列表不强行绕过缓存。它不自动安装或重启，也不扫描其他扩展。

### 可选运行管理

管理能力需要管理员预先配置**独立 HTTPS 管理 origin、认证、Gate 策略及相应受管启动器**，不是安装扩展后立即可用。

- 默认模式在可信终端生成一次性管理码；显式启用可信网关登录模式后，可沿用现有网页登录，无需管理码。不要把管理码、密码或任何凭据发给模型。
- “重启 Pi · 应用已安装更新”：只申请刷新选中的合格 Pi 子进程，不下载软件、不重建容器。
- “全局 Pi 更新”：申请安装精确稳定版本的 Pi 本体，并在安全条件满足后刷新共享运行时的受管进程；不更新 Web 扩展或 Hub 镜像。
- 手动策略需管理员审批；忙碌或不能证明安全空闲时不能强行刷新。旧容器缺少 supervisor/control 时，需另行安排迁移。
- 提交后按原任务 ID 查询。响应丢失、等待、`failed` 或 `recovery_required` 都不是再次提交的理由。

具体接入方式以[当前发布分支的 Hub 管理文档](https://github.com/swordfate3/pi-web-ui/blob/main/docs/hub.md)为准；源码有功能不等于已有部署已启用。

## 4. 更新：安装与进程生效分开处理

### 更新 Web 扩展包

```bash
pi update git:github.com/swordfate3/pi-web-ui
```

使用与原安装**相同的来源字符串**。若安装时显式使用 `@main`，更新也保留；固定旧功能分支的来源不会因 update 自动切换到 `main`。

更新成功后，安排对应 Pi 安全加载新版：保存当前会话、确认没有生成／排队／上传或未知派发，再在终端正常退出并恢复该会话，或按 Pi 支持的流程使用 `/reload`，随后重新执行 `/webui` 并刷新网页。`/reload` 不升级 Pi 本体，也不重启独立 Hub，更不是 unknown 派发的恢复保证。

### 更新独立 Hub

Hub 与扩展来自同一发布包，但独立部署。通过镜像运行的 Hub，需要单独更新包含新构建的镜像并按管理员流程切换，保留原 config/state/grants 卷。

本项目维护约定：扩展更新完成并推送发布分支后，默认针对**同一完整提交**申请 `pi-web-hub` 的 Gate 更新。仅当部署环境已接入 `pi-gate` 时使用：

```bash
pi-gate services
# 将占位符替换为已验证并推送的完整 40 位提交号
pi-gate request <完整40位提交号>
pi-gate status
```

`pi-gate` 是部署环境提供的客户端，不是普通安装 Web 扩展就会附带的命令。它只能申请／查询，不能审批或直接控制 Docker。

- `pending`：等待人工审核；在宿主可信管理环境按该申请的完整 `plan_hash` 审批。
- `queued`／`deploying`：等待或执行中；不是部署完成。
- `deployed / complete`：Gate 报告部署完成；仍应核对实际 Hub API 与页面版本。
- `failed`／`recovery_required`：先检查原因，不绕过验证或盲目重复申请。

Hub 切换可能暂时断开网页连接并轮换会话链接；回总览重新选择，不把旧链接改指其他会话。**纯文档修改本身不触发扩展更新或生产部署。**

## 5. 手机访问与安全

打开 `/webui-setup` 或“设置 → 远程访问／登录管理”，可生成供管理员审阅的连接与 Caddy 配置材料；向导不接收密码，不在浏览器执行服务器管理。新建远程模板面向单会话，不是多会话 Hub 自动部署器。

```text
手机 → HTTPS + 登录网关 → 可信隧道／反向代理 → Hub → 各 Pi
```

- 默认仅监听 `127.0.0.1`。不要将 Web 扩展或 Hub 裸露到公网；聊天入口本身没有可替代外部网关的内置登录。
- `PI_WEB_UI_PUBLIC_URL` 仅声明入口和校验边界，不创建 DNS、证书、隧道或认证。
- 代理应转发完整路径及 WebSocket，保留正确的 Host/Origin。多会话入口不要只代理 `/sessions/`。
- 管理 origin 与聊天 origin 必须分离；同域名下不同路径不能代替安全隔离。
- 不在 URL、会话名、日志、共享项目或模型消息中放密码、token 或管理员凭据。

详见[远程访问与密码管理](docs/remote-access.md)、[连接配置](docs/connection.md)。

## 6. 常见问题

| 问题 | 优先检查 |
| --- | --- |
| `/webui` 命令不存在 | 是否在对应 Pi 环境安装并加载；是否装错上游包／分支；不是在 Bash 中输入 |
| 网页能看但不能分支／重答 | 在该 Pi 终端执行 `/webui`；会话替换后需重新捕获上下文；确认空闲及无挂起操作 |
| 包已更新但卡片还是旧版本 | 已运行进程仍加载旧扩展；先区分磁盘包、Pi 进程、Hub 三者 |
| Hub 自身版本缺失 | 核对运行的 Hub 构建是否含版本修复，不只看本机扩展包；旧独立 bundle 依赖相邻包信息 |
| Web 参考版本未知 | 查询源限流／超时／离线；等检查冷却后复查，不视为已是最新版 |
| Hub 没有在线会话 | Pi 是否存活、socket／单会话凭据／挂载及后端网络是否正确；历史会话不自动成为在线条目 |
| 旧链接返回 `410` | 会话或 Hub 重启后 generation 已失效，回总览重新选择 |
| 返回 `502` 或一直断连 | 分别查后端、Hub、隧道、网关及 WebSocket，不靠反复发送消息试通 |
| pending／unknown 派发 | 到同一 Pi 终端检查，停止自动重放；不强制解锁 |

## 7. 配置与开发

环境变量在**启动 Pi 前**设置，显式环境值优先于 `settings.json`，再使用默认值：

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `PI_WEB_UI_PORT` | `3001` | 单会话 Web 起始端口 |
| `PI_WEB_UI_HOST` | `127.0.0.1` | 监听地址 |
| `PI_WEB_UI_DISABLED` | `0` | `1` 禁止自动启动 |
| `PI_WEB_UI_PUBLIC_URL` | 无 | 对外 HTTPS 入口声明 |
| `PI_WEB_UI_REGISTRY_SOCKET` | 无 | 可选 Hub 登记 socket |
| `PI_WEB_UI_REGISTRY_CREDENTIAL_FILE` | 无 | 与 socket 配套的本 Pi 凭据文件 |
| `PI_WEB_UI_STATIC_DIR` | 随包资源 | 开发／排障时覆盖静态资源目录 |
| `PI_WEB_UPLOAD_MAX_BYTES` | `1073741824` | 单文件默认上限；硬上限 8 GiB |
| `PI_WEB_UPLOAD_MAX_PENDING_BYTES` | `2147483648` | 未完成上传的声明总大小，不是已保存文件配额 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi 配置目录 |
| `PI_CODING_AGENT_SESSION_DIR` | 派生目录 | Pi 会话存储目录 |

Hub 使用单独配置，可通过 `--config` 或 `PI_WEB_UI_HUB_CONFIG` 指定；`PI_OFFLINE=1` 禁止其公开版本联网检查。

Pi 的 `~/.pi/agent/settings.json` 可合并以下配置，**不要覆盖原有模型及扩展设置**：

```json
{
  "pi-web-ui": {
    "host": "127.0.0.1",
    "port": 3001
  }
}
```

开发者构建：

```bash
git clone https://github.com/swordfate3/pi-web-ui.git
cd pi-web-ui
npm ci --legacy-peer-deps
npm run build:web
npm run verify:dist
# 不要同时加载已安装版和源码版扩展
pi -e ./extensions/mirror-server.ts
```

另开终端在仓库运行 `npm run dev:web`，默认访问 `http://localhost:4444`，代理到 `localhost:3001`。若 Pi 实际用了其他端口，需同步调整开发代理。源码／构建输入变更后，重建并提交对应 `dist/` 和 manifest；普通使用者无需开发依赖。

更多资料：[文档索引](docs/README.md) · [开发日志](docs/development-log.md) · [验证报告](docs/validation/README.md) · [发布流程](docs/releasing.md)

## License

[MIT](LICENSE)。保留上游署名，详见[许可来源](docs/license-provenance.md)。
