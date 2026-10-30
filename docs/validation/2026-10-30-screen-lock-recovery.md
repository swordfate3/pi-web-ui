# 长时间后台后无需返回 Hub 的连接恢复

## 目标与复现

目标是登录和原 Pi 仍有效时，手机回到已有页面便自动恢复原实例，不把普通锁屏、网络变化或 Hub 重启解释为需要返回总管。

- 基线浏览器实验：原 generation 不变时，Chromium 冻结并离线 130 秒仍可恢复。因此没有把所有锁屏故障笼统归因于单一网络、DNS 或认证原因。
- 确定的失败组合：浏览器休眠期间同一 Pi 重新登记、原 generation 退休，旧 disconnected handoff 的 45 秒期限也已过。旧实现返回 410，使前端永久停止恢复。真实 HTTP/WebSocket 回归先得到 `410 != 200`，配套 Manager 修复后通过。
- 前端独立 RED 用例覆盖：有正常应用事件但 health 响应延迟时误关连接；hidden 时未决检查到期；快速 hidden/visible 被旧 Promise 吞掉；仅墙钟前进、定时器未执行的 health 和 CONNECTING；临时协议响应被永久当作会话过期。

## 修复

- 接收并仅在内存保留 Manager 的 exact-runtime reconnect ticket；只通过同源、带登录的 handoff 接口提交，不放入 URL、history 或浏览器持久存储，不传给 Pi 或模型。
- 前台 health 窗口改为 15 秒；当前 socket 上有效应用事件或已知请求响应可提前证明存活。隐藏时暂停检查，不退休连接；恢复时取消已过期探针并重新探测。
- 探针与生命周期操作采用身份 fence，旧 Promise 的清理不能覆盖新操作。明显迟到的定时器不当作网络故障；握手在唤醒时也检查墙钟 8 秒期限，避免等待被冻结的 timer queue。
- 显式 410、认证拒绝、无效成功响应及 managed restart 绝对截止期仍终止恢复；未知协议错误只拒绝当前尝试，以有上限退避重试。不会重放提问、授权或会话变更操作。

Manager 的普通短 handoff 仍明确授权原 generation 的第一个 successor，包括用户正常 `/reload` 引起的 runtime 变化。新 ticket 是另一项更窄的能力：短 handoff 不可用时，只能找回同 run_id、同 immutable runtimeId 的当前登记，不选择任意其他实例，不跨越 managed restart 的截止期。

## 验证

- 最终 Web 完整单测 502 项：501 通过、0 失败、1 个原有可选 skip。
- 配套 Manager 完整串行 Hub socket 回归 122/122；真实登录代理/撤权/能力隔离定向回归 7/7。
- 构建、dist 源码/输出 hash 一致性及修改文件的 Biome 检查通过。保留原有 Vite 大 chunk、Node experimental/module-type 提示。
- `e2e/manager-reconnect.integration.ts` 使用真实 Chromium → 已登录 Manager → Hub → 隔离真实 Pi RPC。模型回复合成，账号/目录/状态独立；覆盖 `/new`、`/resume`、临时 503、连续可见页面离线恢复，以及页面冻结离线期间重启测试 Hub、重新登记后再等 50 秒，解冻自动改为原 runtime 的新路径。检查草稿、聊天保留及用户操作不重放。
- 已查看 `.tmp/manager-reconnect/recovered-390.png`（390×844）和 `recovered-1440.png`（1440×900）：恢复后绿色连接状态、原聊天、草稿和输入区可见，无横向溢出。测试账号界面中既有的鲸鱼引导浮层仍存在，本次不改其布局。
- 浏览器替代验证不是手机实机验证。临时 Pi、服务和浏览器由 finally 清理；不使用真实会话、凭据或生产卷。

## 使用与限制

Hub/Manager 和 Web 客户端都需要更新；仅更新 Hub 或只执行前端 `/reload`，不能让已加载的旧浏览器脚本获得新逻辑。更新后需一次刷新网页，以接收新 ticket；不要求每次解锁返回 Hub。

不能保证手机系统永不暂停网络。自动恢复适用于仍保留的标签页；操作系统完全销毁页面后重新加载旧已退休 URL、用户退出登录、撤销权限、Pi 实际退出或新的 runtime 替代旧进程，不在“无条件接回原页面”的保证内。附件和草稿没有新增持久化承诺。

ticket 无单独时钟到期，由现有 run grant、精确 runtime、实时后端证明以及外层登录约束；撤销 grant 或更换 token 即失效。不新增数据库、状态卷、代理服务或旧 pi-docker 兼容。legacy handoff map 的 512 项容量边界未在此任务重构。

本记录对应本地修复与隔离验收，不等于已推送、安装或上线；部署状态必须另有明确回执。本次未重启生产 Hub、隧道或 Pi。
