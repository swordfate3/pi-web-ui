# System patch：修订派发确认与版本分组修复

## 根因与范围

SDK 可在新版 user 的 `message_start` 之前持久化 system 上下文更新。此前派发确认要求当前 leaf 严格等于原 user 的 parent，成功生成后仍留下 pending/unknown，拒绝后续 prompt。版本列表直接按 user.parentId 分组，同一上下文位置的旧版与新版也因此失去 pager。

- 派发确认仅允许最多 64 个合法 message/system 祖先到达精确原 parent；正文、图片、生命周期、session/runtime 与树导航版本仍严格验证。真正 unknown 不因超时、ACK、导航或不匹配内容解除，不自动重放。
- 版本位置仅透明跳过连续 message/system；不跳过 metadata、custom、user、assistant 或 toolResult。实际 parent 和导航 leaf 不改动，不从正文或时间猜关系。祖先校验同时缓存 anchor，长共享链保持线性处理。
- 不读取真实用户会话；合成复现不能确定真实受影响会话的 system patch 来源。公共 API 没有 dispatch ID，同位置、完全相同内容的另一 user 仍存在既有相关性限制。

## 最终验证

| 边界 | 实际结果 |
| --- | --- |
| 全部 unit | 424 项：423 pass、1 个可选大流 skip、0 fail |
| 两个 TypeScript 配置 | 均通过 |
| 全仓 Biome | 234 文件、0 error，30 warnings / 1 info |
| 构建 / dist manifest | 通过，源码与预构建 hash 对应 |
| 真实 Pi RPC + WS | SDK 1.1.0、1.3.0 各 edit/regenerate 2/2 pass |
| Git install/update/tarball | 通过；11 类 stale-input 均拒绝，安装后的 Hub lifecycle fixture 通过 |
| 当前 SDK portable integration | 8/8 pass |
| Python gateway | 16 项，15 pass、1 skip |
| 独立只读源码复核 | 覆盖核心生产模块，未发现可证实新增 P2+ 问题；未独立运行程序或取得完整 HEAD diff，不保证无缺陷 |

真实 RPC+WS 回归强制 system-before-user，检查原 entries 不变、精确编辑文本、用户与回答共用 2/2、旧 ALPHA target 包含 BETA 的实际 leaf；切旧 1/2 再新 2/2 不产生生成事件或追加 entries，恢复后超过八秒继续两轮聊天，由 faux provider 检查 transcript 无跨分支泄漏。基线派发逻辑在同类回归 0/2，首个后续 prompt 被 pending/unknown 拒绝。

日志位于 `.tmp/pager-final-{unit,current-sdk,build,check,install-test,portable,gateway}.log`；SDK 1.1.0 日志 `.tmp/pager-integration-1.1.0.log`。这些本地原始产物不纳入安装包。

## Browser 视觉与交互核验

使用本地隔离真实 Pi RPC（1.3.0）＋faux provider、最终 dist、专用 Browser 标签，URL 为 `http://127.0.0.1:<ephemeral-port>/`。创建 ALPHA/BETA 后编辑早期 ALPHA，system patch 后问题和回答均显示 2/2；切旧恢复 BETA 和 1/2，切新恢复 2/2，再继续两轮得到 FOLLOWUP_ONE_OK / FOLLOWUP_TWO_OK。后续再来回切换保留新分支两轮对话。

- 桌面 1440×900：问题／回答 pager 可见，居中列、正文与操作栏无裁切。
- 手机模拟 390×844：pager 可见、操作栏换行，无横向溢出（document scrollWidth = 390）。长回答与后续对话需正常滚动；默认桌宠浮层会遮挡部分右侧后续操作，属于既有布局，不作为本轮修复项。
- 截图已通过 read 直接查看：工作区 `downloads/playwright-mcp/revision-pager-system-{desktop,mobile}.png`。
- 当前共享 CDP 的原生 click 一直等待 stable，force click 未触发页面动作，最终通过 DOM button.click 操作；不注入 React/store 状态、不模拟 WS。此证据仅称手动 Browser 交互／视觉检查，不称完整自动化 Playwright E2E 或触控验收。测试初次未等待异步 pager 返回，手机截图缺 pager，后续等待 pager 并重新截图确认。
- 临时 harness 已停止，仅关闭本轮专用标签，未关闭其他共享标签。

## 发布与生效边界

本修复用于 Git 远端与本机 Pi 管理包更新，不发布 npm；包含重新构建的 dist manifest。未重载真实 Pi，未申请新 Hub Gate 部署或重启服务。安装新文件不改变已加载扩展或已存在的 unknown 内存状态：由用户确认目标 Pi 空闲后手动 `/reload` → `/webui` → 刷新。不同容器需各自更新其实际安装包。

未运行完整自动化浏览器套件，未验证公网、真实付费 provider、实体手机、全部第三方 hook 或生产中旧锁的恢复。不声称当前真实会话已解锁。
