# 手机远程连接与登录管理 / Remote access and login management

入口：Pi 终端输入 `/webui-setup`，或在网页“设置”中选择“远程访问 / Remote access”“登录管理 / Login management”。`/webui-setup` 打开实际本地监听端口，不要求公网入口先可用。首次提示可跳过，不影响正常聊天。

扩展内置的是向导、部署材料生成和实际监听信息，不是服务器安装器。浏览器不会登录服务器、运行 SSH、读取管理员私钥或修改服务器密码。生成文件始终显示“待执行”，不等于部署完成。

## 选择访问方式

| 方式 | 适用场景 | 边界 |
|---|---|---|
| 仅本机 / Local | 电脑浏览器 | 默认 `127.0.0.1`，无需 WSL、Docker 或云服务器 |
| 可信局域网 / LAN | 同一个可信网络的手机 | 无认证；不要开放到公网；不自动修改防火墙 |
| 新远程网关 / New gateway | Linux 云服务器，包括阿里云 | 一个 Pi 进程、OpenSSH 反向隧道、Caddy HTTPS 和登录认证 |
| 已有网关 / Existing gateway | 已经有受保护入口或兼容多会话路由 | 保留账号密码；不安装路由服务，不猜测会话 generation |

远程表单只填写服务器地址、SSH 用户、SSH 端口、域名、手机入口、Pi 实际端口及服务器回环端口。SSH 用户与网页登录账号不同。不要填写密码、私钥或 API key。显式保存草稿仅在此浏览器保存经过校验的非敏感配置，不改 Pi 设置或服务器；存储不可用会报告失败。

## 新建单会话远程入口

1. 准备 Linux 服务器和自己的 SSH 登录方式；按官方说明安装 OpenSSH server、Python 3、Caddy 2.8+。准备域名解析和 HTTPS 所需的网络条件。向导不安装系统包、不修改 SSH 配置、防火墙或自动启动服务。
2. 选择“远程服务器 → 新部署 → Linux / Caddy”。填写根入口，例如 `https://pi.example.com/`；新部署仅支持标准 HTTPS 443 和独立域名，不支持共享路径或 8443 模板。
3. 生成并分别下载 `connection-plan.json`、`gateway.py`、`connect.sh`、`README.txt`，先阅读文件。`gateway.py` 内嵌非敏感计划，丢失网页登录密码后也能从自己的服务器管理终端运行，不依赖网页可用。
4. 在服务器准备**专用单站点** Caddy 文件目录和完整主配置。主配置必须导入该文件，例如 `import sites/*.caddy`；不要使用会读入备份／锁文件的 `import *`。Caddy 管理端必须已运行且只绑定回环地址。新文件权限为 `0640`，应事先选好 Caddy 可读的目录和组。
5. 将下载的 `gateway.py` 放在服务器上，确认目标路径及共享 Caddy 的影响，运行：

   ```bash
   python3 gateway.py setup \
     --site-file /path/to/sites/pi.caddy \
     --main-config /path/to/main/Caddyfile
   ```

   替换示例路径，不要原样执行。脚本要求确认域名、自行指定网页登录账号、在终端隐藏输入并确认密码，没有默认账号密码。校验完整配置及新账号实际包含关系后才重载 Caddy；失败回滚。
6. 在真正运行 Pi 的电脑／环境中让 Pi 只监听回环端口。例如普通 Pi：

   ```bash
   PI_WEB_UI_HOST=127.0.0.1 PI_WEB_UI_PORT=3001 pi
   ```

   如果用 Docker／`pirun`，需由自己的启动器显式传入这些变量，且从隧道所在环境可访问该监听。不要假设 Docker 自动继承所有宿主变量。以 Pi 输出的**实际端口**为准；端口被占用会递增，须回向导更新并重新生成隧道材料。
7. 在能访问该 Pi 监听的环境运行 `bash connect.sh`。OpenSSH 使用你自己已有的认证并验证主机密钥，不捆绑私钥。服务器转发只绑定 `127.0.0.1`，保留 `GatewayPorts=no`；冲突会失败，不替换其他隧道。隧道和 Pi 都要保持运行。
8. 手机打开填写的 HTTPS 根入口，输入网页登录账号密码。公共业务入口只开放 HTTPS，不公开原始 Pi 端口或服务器转发端口。另行运行下方验证，并在网页确认聊天及 WebSocket。

这是单会话模板。多个 Pi 需要分开的域名／端口，或接入自己已有的兼容路由；本版不会在新部署中自动创建多会话门户。

## 修改账号／密码、忘记密码

认证权威是服务器 Caddy，不是本地 `login.json` 或 Pi 模型配置。网页“登录管理”解释操作并提供材料入口，不接收密码，不提供无需管理员权限的公网重置接口。

在**服务器的可信终端**运行下载的脚本，替换准确路径：

```bash
python3 gateway.py change --site-file /path/to/sites/pi.caddy --main-config /path/to/main/Caddyfile
# 无法登录网页时：通过自己的 SSH / 服务器管理权限恢复，不需要旧网页登录密码
python3 gateway.py recover --site-file /path/to/sites/pi.caddy --main-config /path/to/main/Caddyfile
```

选择要替换的现有账号及新账号，输入新密码。密码要求 12–72 UTF-8 字节；通过终端输入，不放命令参数、网页或模型对话。Caddy 保存 bcrypt 哈希。重命名默认移除旧账号，只有显式 `--keep-old` 才保留；其他账号和代理内容保留。共享该网关的所有 Pi 会话会受影响。

脚本仅支持独立、未加引号的单域名文件，且有一个直接、不带 matcher 的 `basic_auth` 块。有效执行路径必须是简单的直接认证、可选 Origin 拒绝及最终代理，认证／Origin 保护不得被全局顺序或前置共享路由绕过。复杂共享文件、额外处理链、认证导入、多个认证块等会拒绝自动修改，需要管理员拆分或手动审查。维护时不要同时使用其他配置编辑器。

脚本使用维护锁、原子替换、原权限／属主／属组保留、`0600` 备份、完整配置校验和有效配置账号检查，再重载现有 Caddy。非 root 维护也会在替换前尝试并复核原 UID/GID；无法保留则明确拒绝，不静默改变 Caddy 的读取权限。校验／重载失败恢复原文件；回滚重载也失败会明确要求管理员检查，不报告成功。文件备份是敏感哈希资料，应限制访问和保留期限。

完整配置中的其他监听器必须只使用与目标域名不相交的普通 host 匹配。catch-all、通配或复杂匹配可能绕过认证，脚本会保守拒绝（即使监听端口不同），要求管理员审查；不会仅凭一个受保护站点就断言所有公共入口安全。

目标服务器的 `handle_errors` / error routes 也会被拒绝，避免认证失败后转入未认证代理。需要这类自定义错误页面／路由的已有部署，必须由管理员人工审查，不能用此工具自动修改。

如果已有 Caddy 在 Docker 中运行，额外指定 `--docker-container YOUR_CADDY_CONTAINER`。Python 在服务器宿主机执行，`--site-file` 是宿主路径、`--main-config` 是容器可见路径；需要**目录挂载**，单文件挂载无法可靠看到原子替换。脚本不会创建／重启容器。管理用户需要已获得相应文件／Caddy 权限；先审查，不盲目提权。

## 验证与故障区分

Pi 和隧道运行后，从可达该 HTTPS 入口的可信客户端执行：

```bash
python3 gateway.py verify
```

此命令交互输入账号密码，使用有效 TLS，拒绝重定向，检查匿名请求 `401`、新登录请求 `200`。`APPLIED` 只表示配置已验证并重载；`VERIFIED` 表示上述实际 HTTP 登录检查通过，不代表 WebSocket 或会话登记成功。

同时在手机打开网页确认资源、WebSocket、收发消息；另测旧凭据是否失效。浏览器缓存 Basic Auth 时，用隐私窗口或清理该站点认证。网页上的监听端口、浏览器入口及 WS 状态来自当前连接；“登记已配置”不等于租约已成功。

接入已有多会话网关时，使用路由实际发出的 generation URL；原生登记需要 `PI_WEB_UI_REGISTRY_SOCKET` 与 `PI_WEB_UI_REGISTRY_CREDENTIAL_FILE` 配套，凭据由已有路由签发。Docker 内使用容器可见路径并提前配置挂载。`/reload` 不能增加挂载，且原生登记与旧源码注入适配器不能同时启用。不要仅修改公网地址就认为隧道／路由已经建立。

## English quick reference

Open `/webui-setup` locally or Settings → Remote access / Login management. Generate and review nonsecret materials; nothing is executed remotely by the browser. New deployments support a Linux/OpenSSH/Caddy single-session gateway, not an installer or multi-session portal. Local use does not require WSL or Docker.

Run `gateway.py setup/change/recover` in your trusted server terminal with explicit site/main-config paths. Choose your own account and password; no defaults or browser password fields. Recovery uses your server administration access, not the old web password. A dedicated single-site Caddyfile is required; ambiguous/shared authentication is refused. Docker Caddy requires a directory bind mount. Other accounts are preserved, and failures roll back.

Use `gateway.py verify` for actual anonymous-401/authenticated-200 checks over validated HTTPS. This does not verify WebSockets, leases, mobile reachability, or old-credential revocation. Keep Pi and the SSH tunnel running and use the actual Pi port, regenerating after a port change. Maintenance preserves the site's mode, owner and group; if these cannot be preserved, replacement is refused rather than silently changing Caddy's read permissions. Existing gateways keep their existing authentication and need their own compatible registry and mounts.
