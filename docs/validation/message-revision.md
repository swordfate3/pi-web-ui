# 每轮编辑与重新生成验证

## 范围

本地开发，未提交、push、安装更新或部署。用户消息下「编辑并重新发送」、已保存 AI 回答下「重新生成回答」，独立确认框，以及 Tree 原分支／新版本切换。只改变对话上下文，不恢复文件或撤销工具、外部请求、数据库、部署。

## 实现边界

- 原文取 Pi 原始 entry 父链，不取聊天或 Tree 截断预览。JSON 转义后 2 MiB 限额，超限明确失败而不截断。编辑保留原问题全部图片，无法保留的附件拒绝；浏览器不接收 base64 原图。
- get/submit 两阶段，一次性连接级 preview；submit 再检 session/runtime/leaf、idle/pending 和生命周期。导航到原问题前，`summarize:false`，不把旧问题、旧答案和后续工具结果带入新上下文。文字按字面发送，不展开 `/new` 等命令。
- void `sendUserMessage` ACK 只代表派发，不是已接受／已成功。15 秒客户端截止不自动重试；8 秒共享 busy 截止不取消派发，独立 unknown 继续拦 mutation。只读、同步、abort 与 extension UI response 可用。
- Pi 1.1.0 无派发 correlation metadata；匹配预期 parent 与完整文本／图片内容确认 user start。原文被 hook transform/handled、图片规范化或异常可使 unknown 持续；需终端检查，必要时显式 session 替换／reload。普通树导航或无关消息不解锁。同 parent 的完全相同消息仍无法严格区分，见 ADR0008。
- 草稿、队列、已选附件、上传／交接先由用户处理；确认框打开时不自动派发队列。Tree 普通点击仍只定位；分支末尾箭头才切换当前路径。

## 已定位的失败与修正

1. 默认 MessageAction 同时含可见文字与 sr-only label，用户编辑按钮 accessible name 重复。独立 Browser 精确选择失败后补 `aria-label`；不是按钮不存在。
2. 真实 Pi 专项首轮桌面／手机均在刚完成 BETA 后读取时得到 stale leaf 错误。`agent_end` 先恢复 ready，持久化快照 debounce 尚未抵达。操作前主动同步所选有界历史，再取完整问题，保留 submit 精确 leaf fence；新增 ready-before-snapshot 单测。
3. 第二轮误选 ALPHA：测试仅等待回答文字出现，BETA 的 saved entry 操作尚未显示。改等待两个已保存回答按钮，不用 sleep 掩盖产品竞态。
4. 第三轮桌面 sidebar selector 命中 header 和 sidebar 两按钮，手机通过。测试改唯一 `toggle-left-sidebar` test ID。
5. 第四轮两个真实 Pi 示例通过；独立 Browser 曾在手机 Sheet 过渡期间截到横向滑动中页面，等待 transition 完成后重新截图并直接查看，不把过渡帧当最终布局。
6. 初次手机确认框截图出现背景 disabled 按钮 tooltip 盖住警示，将 revision overlay 层级提升至 tooltip 之上，后续重验。
7. 后续复核确认反向异步窗口：模型切换先进入 getAvailable／宿主认证 await，随后 revision 才加锁。加入贯穿请求 await 的 active mutation 计数，已有 mutation 完成前拒绝 revision；新增 discovery 和 setModel 内部等待两段测试，不仅重检入口。
8. 只读审查确认并修正：leaf 永久去重阻止合法新重答、无关 tree/user 提前清 unknown、导航中 compact 绕过锁。改一次性 preview、预期 parent/完整内容匹配和导航/unknown 统一 mutation 白名单，并补模拟 WS 回归。审查是限定快照，不是完整代码或宿主取消证明。

## 验证记录

- 中间默认单测 308 项：307 通过、1 可选 GiB 跳过。之后有新增回归，最终结果见下方追加。
- 后端专项最新一次 17/17；前端专项 8/8。涵盖文本／图片顺序、超限、scope、取消、单次 preview 跨 socket、重复／合法新提交、>8秒 delayed void、无关事件不能恢复、compact 锁，以及前端旧 runtime completion 不清新锁。
- 真实 Pi + context-inspecting faux provider：`e2e/features/message-revision.feature` 桌面1440×900与手机390×844两个示例第四轮 2/2（23.3秒）。验证早期 ALPHA 编辑排除原问题／旧回答／后续 BETA；BETA 重答保留先前 ALPHA、排除旧 BETA 回答和编辑 sibling；准确空白、busy、取消无 submit、草稿保护、Tree 多版本切换及刷新持久。所有 JSONL 均为合成临时会话。
- build 和 manifest 已多轮通过；补充 strict types 使用既有 review 工作树的 ws 声明，未安装依赖。直接 connection tsc 缺 ws 声明仍是环境限制；不声称整个旧 mirror adapter strict 通过。

原始日志前缀 `/tmp/pi-message-revision-*`；浏览器失败 trace `.tmp/message-revision-browser{,2,3}/`，通过 `.tmp/message-revision-browser4/`。临时日志不是公开报告或生产数据。

## 独立视觉

Browser 单独创建合成 Pi 页面 `http://127.0.0.1:45505/`，没有操作其他用户标签页。桌面1440×900、手机390×844直接截图查看：动作文字常显、编辑全文框、原问题只读预览、安全警示、确认／取消和 Tree 分支提示。图位于本地下载目录 `downloads/playwright-mcp/message-revision-*.png`，不是公开包素材。DOM 无横向溢出仅辅助，不替代图像判断。最终复验在相同视口直接查看 `message-revision-{edit-desktop,edit-mobile,regenerate-mobile}-final.png`：确认框文字与按钮可读、无遮盖、手机无横向溢出；关闭行为正常。自有 PID163633 已 SIGTERM 停止，45505 健康入口不再监听，未重启用户 Hub／Pi。

## 最终验证

- `npm run test:unit`：316 项，315 通过、1 可选 GiB skip；包括新增 queue/source 与 draft-version helper 4项。`npm run check`：208 文件、0 error、5既有 warning。build／manifest／补充 strict types：通过，DIAGNOSTICS=0。
- 最终源码完整 Chromium **71/71**，约6分钟：`.tmp/message-revision-full-final/`。此前 build5 的中间快照亦71/71，不将其代替最后一轮。涵盖既有聊天／Branch、Hub导航、附件／分片、历史、鲸鱼及本次两个新场景。
- 真实 Pi 后端回归16/16：portable/upload/usage一组12、date-history/download/Hub一组4（日志 `integration{,2}.log`）。这些在最终App收尾前运行，后端变化已包含反向mutation fence；与最终完整浏览器证据分列。
- 离线 pack 705 条目、142源／673输出，prepare验证、6类stale-input拒绝、helper实际在包内、仅复制本地ws且无其他生产依赖。抽取runtime启动真实Pi，桌面／手机修订 **2/2**；`.tmp/message-revision-release-final/result.json`、`.tmp/message-revision-offline/`。不是实际 npm 安装／update 生命周期，无网络安装依赖。
- 额外审查的队列／旧Branch窗口也收尾：入队绑source identity，旧scope不自动发并可明确恢复到输入框；错误或未知ACK暂停项可检查后手工恢复，不自动重放。旧Branch／continue有局部所有权锁、composer/附件暂停、身份和draft版本重检，旧finally不解新锁。新增文案全部登记typed key，不通过类型断言绕过。
- 所有本轮自有服务已停止；没有 commit、push、targeted update 或 gate request。

## 未证明事项

尚不代表生产已加载、Hub 已部署、真实付费 provider、实体手机、Safari/Firefox、所有第三方 input hook 或图片重新编码后的接受关联。当前不支持只回滚代码或代码＋对话，不手工改写 AI 原历史正文。
