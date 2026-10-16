# Hub 进入、返回与改名体验

## 状态与范围

基于已发布 `00c6d3b` 的本地开发，尚未提交、推送、安装或申请生产 Hub 更新。未修改网关／SSH／用户会话或凭据。本轮使用隔离真实 Pi、faux provider、私有临时 Hub，未调用真实模型。

## 修改

- Hub 路径的会话顶栏增加固定同源「← Hub」入口；独立根或其他代理路径不显示。不停止 Pi，不等待会话完成后才返回。普通点击离开有未发送文字／排队消息／已选附件／上传交接时先确认；取消不丢草稿或附件。原生后退／刷新没有额外全局拦截，离开后不承诺保存临时状态。
- Hub 链接点击显示正在打开，10秒恢复可重试状态；支持修饰键打开新页。HTML 加静态加载 shell，不能把它描述成消除了全部CSS、JS或网络等待。
- API 数据与搜索词不变则不重建卡片，保留焦点；失败仍清空在线列表并显示错误。从BFCache恢复触发一次立即刷新，已有请求最多合并一次尾随请求；保留5秒可见页轮询。
- 网页 `/name` 与 `set_session_name` 后立即请求登记，最多250ms共享ACK等待预算、一个执行中请求＋一个合并尾批次；超时仍返回Pi改名成功，不声称Hub同步成功。后台登记及15秒续期补偿。stop/start epoch栅栏、generation与授权身份不变；TUI改名仍用续期。
- 去掉首次无client的无效settings调用，首次Git请求与快照后的350ms debounce合并；不删除主动bounded history sync或放宽identity校验。真实Hub进入测试观察一次初始Git请求。

## 回归发现与修复

第一轮Hub浏览器3/5，desktop/mobile两种handoff失败，日志 `/tmp/pi-hub-ux-browser.log`，trace `.tmp/hub-ux-browser/`。不是仅重跑：

1. Desktop实际202→200→新WS成功，但立刻发第二条纯文本被旧upload scope误挡。`history.replaceState`不触发popstate，原页面100ms轮询存在窗口。改为PiClient替换路径后、连新socket前发送本地 `pi-web-route-changed`，App监听并在layout effect更新/清理上传scope；仍保留真实pathname与session/runtime checks，不让旧receipt穿透。
2. Mobile `/new` ACK后第一次handoff410，未得到新快照。trace不包含registry IPC，不能断言具体服务端分支；静态与确定性测试证实旧proof异步失败、successor尚未登记时可提前410。修复为有效capability且尚未绑定时202 pending，保留客户端15秒／断线token45秒期限。已绑定目标失败仍410、不跳过首successor，proof后重查撤销和deadline；metadata续期不绑定历史capability。

新的10项真实HTTP／UnixIPC测试覆盖proof窗口、退役／successor绑定、renew、撤销／过期和精确45秒边界。有限只读快照审查未发现指定范围可证实P2+；审查无diff/执行/原子快照，不冒充完整审计。

## 验证结果

- 默认286项：285通过、1可选GiB条件跳过；最终日志 `/tmp/pi-hub-ux-unit-final.log`。
- 源码最终完整Chromium **69/69**，约5.6分钟：`/tmp/pi-hub-ux-full-final.log`、`.tmp/hub-ux-full-final/`。包括改名ACK后立即查API并点击返回按钮、草稿和附件取消离开保留、轮询卡片/焦点稳定、浏览器goBack、两种屏幕新建/恢复交接后立即发文本。
- 初次非Hub全套尝试300秒超时，中断前至58项，无完成总数；保留 `/tmp/pi-hub-ux-regression.log`，不算全套成功。另定向13/13后才执行最终完整69项。
- build、manifest、补充严格类型DIAGNOSTICS=0；Biome199文件无error，5条既有history-store warning。新测试初用静态import类型使旧mirror adapter五项既有strict问题入编译图；改为既有动态mock测试惯例，不能说整个旧adapter已strict通过。
- 离线pack704条目、138源/673输出、仅ws（本地复制，不安装依赖），8类stale-input负例拒绝；fresh extraction的Pi扩展和Hub CLI共同运行 **5/5 Hub浏览器**。结果 `.tmp/hub-ux-release-final/result.json`，日志 `/tmp/pi-hub-ux-{package,offline}.log`。这不是实际生产npm安装／更新生命周期。
- 未单独重跑16项后端integration，未测试公网延迟、实体手机、Safari/Firefox。完整浏览器通过不证明所有后台上传回调/无障碍/超大仓库性能已穷尽。

## 独立Browser视觉

隔离 `http://127.0.0.1:45225/`，1440×900及390×844。截图存于 `downloads/playwright-mcp/`，均已直接read：

- `hub-ux-desktop.png` / `hub-ux-mobile.png`：左上←Hub可见，窄屏两行顶栏无横向溢出/覆盖。
- `hub-ux-return-mobile.png`：真实/name确认后立即点返回显示新名字，旧标签8hex未出现。
- `hub-ux-entry-shell-nojs.png`：禁用JS的独立context显示静态shell和noscript；不是加载耗时或E2E证明。之前尝试静态asset延迟截图因等待font超时，已解除route并关闭独立context，没有成功的慢链路截图证据。

一次本地自动操作记录进入约481ms、返回并截屏约347ms；返回计时包含截图，不是严格基准，没有旧版同条件对照，不据此承诺公网性能提升比例。初次favicon404与导航API无关。自有PID147618已SIGTERM退出，测试context关闭，未停止实际Hub/隧道。
