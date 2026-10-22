# 本机 Pi 原生终端：启动、手机接入与维护

已部署：2026-10-22。本机专用说明，不是所有安装默认启用的配置。

## 1. 在项目目录启动一个新的原生终端 Pi

```bash
PI_PIRUN_IMAGE=sha256:3603564462e1b5b6f3912239aff3605074c2b1f430f068d58809e5b7f242501d \
PI_PIRUN_WEB_TERMINAL=on pirun
```

普通 `pirun` 不变。旧的普通 Pi 容器不能通过 `/reload` 变成原生终端；
要使用此模式，另开一个终端按上述方式启动，不必先退出旧会话。
镜像中的终端组件固定，但启动的 Pi 仍来自共享 `pi-runtime` 中的安装。
它不是冻结的第二份 Pi；全局更新安装后，需要正常退出并重新显式启动，
不能把运行中 Pi 的版本变化当成已经实现的热更新。

原聊天入口仍为 `https://pi.swordfate.cn/sessions/`。
新终端入口为 `https://terminal.swordfate.cn/`，不是聊天页面的另一个端口。
此模式下普通聊天页从启动起只读，操作通过独立原生终端进行。

## 2. 在可信宿主终端取得准确身份并配对

先列出原生终端容器：

```bash
docker ps --filter label=cn.swordfate.pi.runtime-profile=web-terminal-v1 \
  --format 'table {{.Names}}\t{{.Status}}'
```

在下面第一行填入**自己准备接入的实际容器名**，不要随意选“最新一个”。
后续只读查询通过 Hub 已有的私有 provider 通道取得准确身份；不会显示 provider Token。

```bash
PI_TERMINAL_CONTAINER='填入实际容器名'
PI_TERMINAL_RUN_ID=$(docker inspect --format '{{index .Config.Labels "cn.swordfate.pi.run-id"}}' "$PI_TERMINAL_CONTAINER")
docker exec -i --user 1000:1000 pi-web-hub node - "$PI_TERMINAL_RUN_ID" <<'NODE'
const fs = require('node:fs');
const net = require('node:net');
const runId = process.argv[2];
if (!/^[a-f0-9]{32}$/.test(runId)) process.exit(1);
const socket = net.createConnection('/run/pi-terminal-provider/provider.sock');
let text = '';
const timer = setTimeout(() => { socket.destroy(); process.exitCode = 1; }, 2000);
socket.on('connect', () => socket.write(JSON.stringify({
  v: 1, op: 'status', runId,
  token: fs.readFileSync('/run/pi-terminal-credentials/provider.token', 'utf8')
}) + '\n'));
socket.on('data', chunk => {
  text += chunk;
  if (text.length > 65536) { socket.destroy(); process.exitCode = 1; return; }
  if (!text.includes('\n')) return;
  try {
    const reply = JSON.parse(text.split('\n')[0]);
    if (reply.type !== 'ready' || reply.target?.runId !== runId) throw Error();
    console.log(JSON.stringify(reply.target, null, 2));
  } catch { process.exitCode = 1; }
  clearTimeout(timer);
  socket.destroy();
});
socket.on('error', () => { process.exitCode = 1; });
socket.on('close', () => { clearTimeout(timer); if (!text) process.exitCode = 1; });
NODE
```

把输出的 `runId`、`runtimeId`、`sessionId`、`terminalEpoch` 填入现有受信 CLI。
以下 `<...>` 都是占位符，替换时不要保留尖括号：

```bash
docker exec --user 1000:1000 pi-web-hub node \
  /opt/pi-web-ui/dist/hub/pi-web-hub.mjs pair-terminal \
  --config /hub/private/config.json \
  --run-id '<runId>' --runtime-id '<runtimeId>' \
  --session-id '<sessionId>' --terminal-epoch '<terminalEpoch>' \
  --access write
```

输出含 `code`：它是 **10 分钟内有效、单次使用的秘密**。只在自己的手机终端
页面手动粘贴，不发到模型对话、URL、截图或日志。只看画面可将 `write` 改为
`read`，只读配对不能申请写入。该命令签发新码会替换尚未兑换的旧码。
目前没有把上述步骤伪装成一键配对；身份选择和授权仍是管理员显式操作。

如果命令拒绝，不删除锁或凭据来强行接入。重新核对目标是否存活、是否为
原生模式、Gate/Hub 是否健康；不要编造 `terminalEpoch`。

## 3. 手机上打开并接管

1. 打开 `https://terminal.swordfate.cn/`，使用原 Caddy 网关账号密码登录；
   本次没有修改原来的密码。
2. 手动粘贴上一步的 `code` 并解锁；核对页面的运行/进程/会话身份。
3. 在电脑正在运行 Pi 的那个终端，按 `Ctrl+]`，松开，再按 `w`，交出输入权。
4. 网页选择可申请控制的连接，点“连接终端”，画面就绪后再点“取得控制权”。
5. 在草稿框输入内容后点“发送文本”；如需执行 `/model` 等原生命令，发送后
   还要单独点网页的 `Enter`。仅发送文本不等于按回车。

配对、连接和获得控制权是三件事，不会自动完成。控制权租约30秒，连接最长
300秒，不自动续租、重连、重新获取或重发未知结果的输入。电脑按 `Ctrl+]`，
松开，再按 `l` 可立即收回本地输入权。离开/隐藏网页会释放浏览器权限，
但不会退出 Pi。退出 Pi 请在其终端正常退出。

手机宽度不会偷偷改变原生终端尺寸。长行或高菜单在画面内部滚动；需要改变
原生尺寸时，使用页面的手动尺寸设置。

## 4. 配置、维护和回退

| 位置 | 用途 |
| --- | --- |
| `pi-deploy-gate/terminal-policy.json` | 受信终端镜像允许列表，Gate 构建封存输入 |
| `pi-docker/compose.hub-terminal.yaml` | Hub 两个固定只读 provider 挂载，`nocopy` |
| `pi-web-hub-private` 卷内 `/hub/private/config.json` | Hub 私有配置，新增 terminal16184，不要打印完整内容 |
| `pi-docker/systemd/pi-web-terminal-tunnel.service` | 独立反向隧道13003→16184 |
| 阿里云 `/opt/caddy-sub2api/caddy_data/pi-web.caddy` | 独立域名和保留的网关认证 |

这些路径中的 `pi-docker`、`pi-deploy-gate` 均位于 `/home/fate/docker_files/`。
两个 provider 卷仅 Gate 可写、Hub 只读；Pi 没有它们，也没有 Docker socket。
它们不是 Pi 的项目或模型持久化卷，不要删除来“清缓存”。

```bash
pi-dockerctl hub status
pi-dockerctl gate status
systemctl --user status pi-web-terminal-tunnel.service
pi-dockerctl hub config
```

`hub config` 只渲染当前真实 Hub 的四挂载配置，不部署。
`pi-dockerctl hub restart --confirm` 仍只重启现有 Hub，不重启 Pi。
版本发布继续通过 Gate，不直接执行旧 Compose 的 up/down。
只需暂时关闭终端公网入口，可停止 **新终端隧道**，保留聊天和管理隧道：

```bash
systemctl --user stop pi-web-terminal-tunnel.service
```

完整备份在
`/home/fate/docker_files/pi-docker/backup/terminal-deploy-20261022-i6_ye042`。
Hub 的 Gate 申请是 `3971fea975eec3fba230e84f69e4ea3e`，已保留旧容器。
真正回退前先核对实时身份/配置漂移，并撤回新增的 terminal 私有配置；
不要只启动旧 Hub 却给它不支持的新配置，不删卷或 Gate 数据库。

已实测本地真实浏览器的配对、WebSocket、模型选择框和输入交接，以及公网
直连证书和未登录401。**真实手机和带登录的公网 WebSocket 尚待使用者验收**。
本机代理把域名解析成198.18.x.x Fake-IP时，直接绕过代理可能超时；
不能把本地真实IP直连成功当作手机路由已经验证。
