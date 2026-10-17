# 消息下方版本翻页验证

## 实现范围

- 在存在同位置用户分支的问题和已保存 AI 消息下方显示 `‹ 2 / 2 ›`。编辑问题、重新生成和旧 Branch 形成的 user siblings 共用版本组；一次工具轮中的多条 assistant 不计为多个版本。
- 依据完整原始 `parentId` 关系和保存顺序分组，不按正文、时间接近程度或有界 Tree 的可见父节点猜测。问题和对应回答一起切换，后续对话也随当前分支切换，不将其他分支文字拼入当前上下文。
- 后端只返回 ID／索引元数据，最多请求 100 个显示消息，响应最多 256 个版本引用。超预算省略整组并提示，保留组内真实总数。部分显示消息超出请求范围时不显示其 pager。
- 非当前候选有更深分叉时，选择最近保存的真实叶路径；当前候选优先保留当前路径。没有已回答且能安全导航的目标时禁用按钮。需要选择更细路径时继续使用 Tree。
- `switch_message_version` 强制 session/runtime/source leaf，重新解析目标关系，复用 advanced、idle/pending、浏览器异步 mutation、revision unknown 和生命周期保护。固定 `summarize:false`，不发送问题、不要求当前模型配置，不恢复工作区文件。第三方导航 hook 仍可能取消或有其自身副作用。
- 前端严格校验读取响应和目标 ACK。局部导航 token 防止双击、旧 completion 解新锁；草稿确认取消不导航，确认后保留草稿，附件/上传/队列保护不取消。15 秒 deadline 不是取消，不自动重放。
- 日期筛选保留，但切换后读取新分支的最新一页。旧路径的分页 entry cursor 不可跨分支复用；页面 generation 保护旧读结果。目标在筛选日期之外仍遵守日期范围，不静默放宽筛选。

## 失败与修正

1. 前端解析收尾发现：合法的 assistant-only 页可能不含该轮 user ID，不能强制 group.entryIds 包含 user；ACK 必须精确匹配目标 leaf。两项均补测试并通过。初次 unit 中途运行遇到测试 fixture 尚未同步 ACK 契约，最终重跑通过。
2. 新浏览器专项第一次两端失败：测试先通过 pager 已回到原 BETA，再要求点击原 BETA 的 Tree Continue。现有产品对当前 leaf 不显示 Continue，测试因此等待到超时。改从编辑分支直接用 Tree 切原 BETA，保留真实 Tree 回归，不修改产品来迁就测试。`.tmp/message-versions-browser2/` 保留失败证据，修正后专项 2/2。
3. 前端独立审查发现旧分页 cursor 被直接用于新分支读取，会导致导航成功后空页。改为 `loadMessageVersionHistory` 在所有权／原日期页检查后调用无 cursor 的 `loadHistory(range)`；新增真实 session slice 回归挂起旧页读、新页先完成、旧页后到，保证新内容保留。复核认为原问题已修复。此项动态证据是 slice 单测，不冒称长历史浏览器场景。
4. idle／sync 过渡导致相同已保存 scope 的 pager 闪隐，改为保留只读计数，控件由 App 锁定；identity/leaf/日期页/消息集合变化仍立即隐藏不相干版本。
5. 将 pager 移植到远端 `0e69509`（包含之后的 Hub restart 代码）后，独立审查发现：版本切换成功但 ACK 丢失、先断线时，旧 cursor 可能不属于重连后的 active branch。修复不再仅凭 leaf 改变猜测是否换了分支（同一分支正常追加也会改变 leaf）；保留旧页读取路径，只在服务端明确拒绝 `Unknown history cursor for this date range` 时，按相同日期范围只读回退到最新页。其他网络错误不自动重试，也不放弃仍有效的旧页 cursor。新增回归覆盖切分支失效 cursor 回退及同分支追加后仍能保持的合法旧页 cursor。

## 最终验证

以下均为本地合成数据／隔离 Pi，不读取用户会话正文或凭据，不调用付费 provider。

| 层次 | 命令／产物 | 结果 |
|---|---|---|
| 默认 Node 单测（合并快照） | `npm run test:unit` | 415 项：414 通过，1 个可选 GiB 测试 skip |
| 静态检查（合并快照） | `npm run check` | 233 文件，0 error；30 warning、1 info |
| 前端与分发构建 | `npm run build:web`、`npm run verify:dist` | 通过，source/output hash 一致；hash 不代表真实性签名 |
| 连接类型检查 | `npx tsc --noEmit -p tsconfig.connection.json` | 通过 |
| 有限分页恢复专项 | `node --import ./tests/register-ts.mjs --test tests/message-versions-scope.test.ts` | 4/4 通过：切换后的过期页请求 fencing、重连后服务端拒绝旧分支 cursor 时回退到最新页、同分支 append 保留有效旧页、版本 scope 保护 |
| Pi Git 安装／更新夹具 | `node scripts/test-git-install.mjs` | 通过：真实 Pi Git install/update、prepare、tarball 与 Hub lifecycle fixture；11 类 stale-input 拒绝，单生产依赖；不是实际本机安装 |
| 完整源码 Chromium E2E | 本轮合并快照 | 未运行：缺少匹配的 Chromium 可执行文件；未安装浏览器。历史 `39176c9` 的 71/71 不覆盖远端 Hub restart 代码 |
| 独立只读代码复核 | `session-slice.ts` 及相关 cursor 调用链／测试 | `none found`（限定范围）；不代表全项目审计 |

此前原基线的 337 单测、71/71 Chromium、离线抽包与真实 Pi 路径只记录为历史证据，不覆盖远端合并后的 Hub restart 代码。此次合并快照额外执行 Browser 中隔离 faux Pi 合成对话的手动交互／视觉检查，不冒称完整 E2E。

## 远端最新快照合并后的验证补充

- 本轮对照远端 `main` `0e6950992ca8dfc660d78b617e3722609ea1e240` 建立隔离工作树；保留其 Hub restart 代码，并将尚未发布的消息版本翻页集成到该基线。提交前验证重建 `dist/` 与当前源码 hash 一致。
- 独立审查指出连接中断／未知 ACK 期间旧 cursor 可能与新分支不符；第二轮审查指出不能用 leaf 改变判断分支切换（正常追加也改 leaf）。已修复为服务端精确 cursor 拒绝时的有限只读回退，并新增新分支失效 cursor 与同分支有效 cursor 两类回归。详见上面的“失败与修正”。
- 以下旧证据（337 单测、71/71 全量 Chromium、离线分发抽取等）针对更早的 `39176c9` 开发树；它们不代表远端新合入的 Hub 重启功能已完成同等覆盖。合并快照需以本轮最终开发日志及提交验证为准。

## 独立 Browser 视觉检查

- 使用隔离 faux Pi 合成对话；Browser 桌面视口 1440×900、手机模拟视口 390×844。
- 使用 Browser 创建专用测试标签，编辑中文问题、切回旧版本、再次生成第三版，并在最终构建刷新后切到 `2 / 3`。截图通过 read 直接查看，不以 DOM 匹配代替视觉。
- 问题和回答的版本索引一致，上一／下一按钮常显。手机操作栏正常换行，文字可读，无横向溢出；切换目标问题有既有定位高亮，未覆盖正文。边界禁用亦在先前 `1 / 2`、`2 / 2` 截图和浏览器功能断言中确认。
- 合并后的桌面和手机最终截图已在 Browser 直接查看：`/workspace/downloads/playwright-mcp/message-versions-remote-merged-desktop.png`、`/workspace/downloads/playwright-mcp/message-versions-remote-merged-mobile.png`。桌面 1440×900 对话为居中最大宽度列；手机 390×844 pager 可见、操作栏换行，无横向溢出。截图在工作区 `downloads/playwright-mcp/`，不纳入 npm 包。
- 使用隔离 faux Pi 合成对话及专用 Browser 标签；已停止本次临时 Pi harness。未重启用户 Pi／Hub／隧道，未关闭其他共享浏览器标签。

## 限制与发布状态

- 不提供每个 user 内任意 assistant 分叉的独立版本列表；此次按当前 edit/regenerate 所形成的 user siblings 分组。更细历史选择仍用 Tree。
- 旧 Tree 的日期／节点预算不变；pager 关系来自全条目，但显示聊天仍是有界历史。非常大的分组省略，不保证无限版本 UI。
- 未验证公网、实体手机、Safari/Firefox、真实付费 provider、所有第三方 hook 或所有异常长历史布局。本轮未重新跑全部独立后端 integration 文件；手动 Browser 使用隔离 faux Pi 合成数据，不是完整 Playwright／真实 Pi E2E。
- 最终发布提交 `5dee430ee7eb03c920ac34c837de9164ed748464` 已推送至 `swordfate3/pi-web-ui` 的 `publish/main`，并核实远端 ref 与之相同。
- Pi 管理的本机 Git 包 `/home/node/.pi/agent/git/github.com/swordfate3/pi-web-ui` 已经 `pi update git:github.com/swordfate3/pi-web-ui --no-approve` 更新；已核实安装 HEAD 相同、worktree clean，`npm run prepare` 再次通过。该路径在 `/home/node/.pi` 持久卷内。未 reload 当前运行的 Pi。
- 未申请或执行 Hub/pi-gate 部署、Hub 重启，也未改动其他运行服务。本次授权只覆盖 Git 远端和本机包。
