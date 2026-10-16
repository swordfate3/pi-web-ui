# 网页鲸鱼娘验证

## 结论与范围

在 `96a8fab` 基线上完成现有 Pi Web 页面内的悬浮鲸鱼娘：拖动/方向键移动、点击反馈和用量卡、收起、关闭/设置重开、五槽本地素材、状态联动与减少动态效果。没有创建原生项目，没有复制同人图片进源码或软件包，没有新增生产依赖。

本轮仅本地实现和验证，**未提交、推送、更新启用包、重载生产 Pi 或重启 Hub/隧道**。测试仅使用隔离 Pi、合成会话和 faux provider。

## 最终验证

| 层级 | 结果 | 原始日志 |
| --- | --- | --- |
| 默认 Node 单测 | 253 项，252 通过、1 可选 GiB 跳过、0 失败 | `/tmp/pi-whale-unit-final.log` |
| 真实 Pi 后端 | 16/16，含新用量接口与原有连接、Hub、日期、下载、上传 | `/tmp/pi-whale-backend-all.log` |
| 鲸鱼娘 Chromium | 3/3 | `/tmp/pi-whale-browser-fixes.log` |
| 完整 Chromium | 64/64 | `/tmp/pi-whale-browser-release.log` |
| Web/Hub 构建 | 前端类型、两个 Vite 构建、manifest 写入通过 | `/tmp/pi-whale-build-final.log` |
| Biome | 191 文件通过 | `/tmp/pi-whale-check-final.log` |
| 补充严格类型 | 0 diagnostics | `/tmp/pi-whale-types-final.log` |
| Source/dist 对应 | 通过，只证明 hash 一致性 | `/tmp/pi-whale-dist-final.log` |
| 离线 pack/解包/Node-only 校验 | 703 条目、137 源、673 输出；十一类 stale-input 拒绝；无下载同人素材；生产依赖仍仅 ws | `/tmp/pi-whale-package.log`、`.tmp/whale-release/result.json` |

补充类型使用工作区另一个 review checkout 已有的 `@types/ws`，不安装依赖、不修改其文件。离线包只复制现有 `ws`，运行 Node-only install 校验及 Hub CLI help；**不冒充真正 npm/Pi 安装更新或安装后全部功能测试**。包体约 4.92 MB，解包约 25.32 MB。

### 新增回归的含义

- 后端 helper：历史实际模型与当前选择分离，`responseModel ?? model`、缓存/reasoning 子集、部分未知/全未知价格、零报价保守未知、工具/summary、重复条目、有界模型分组和异常数字。
- 真实 Pi 用量 fixture：两个不同日期、兄弟分支、两个实际响应模型，465 Token，已知小计 `$0.001` 加一次未定价请求；全部条目统计不依赖日期分页。缺失、过期 session/runtime 被拒绝；结果不含合成正文、宿主路径或 key。
- 前端解析器/intent：非有限或负数、超长标识、模型行数上限、scope mismatch、断线/切运行时迟到结果拒绝。
- 浏览器：通过设置导入可解码的合成一像素 PNG，Blob URL 渲染与刷新恢复，不发上传或模型请求；伪装 PNG 的 SVG 被拒绝且保留原图；用量卡关闭后不再轮询；拖动/键盘、收起/关闭持久化、设置恢复、新会话不残留旧模型统计、手机边界不溢出。
- 存储故障：延迟初次图片解码时同时导入新槽，恢复后保留原槽和新槽；首槽写入失败、下一槽成功后仍明确列出临时槽，不误报整体已保存。
- 系统 reduced-motion 的 computed `animation-name: none` 有浏览器断言；组件自身减少动画设置另在独立 Browser 检查同样为 `none`。

新后端测试已加入 CI 的显式 integration 命令；本地通过不代表远端 CI 已运行。

## 独立审查及修复

只读后端快照审查未发现确认必须修项；不是完整基线 diff 审计。只读前端快照审查发现三项 P2，均已修复：

1. reduced-motion 规则优先级低于点击动画：提高 selector specificity，并分别检查系统与组件设置。
2. 一个槽成功保存掩盖另一个临时槽：按槽记录未保存状态，警告持续列明槽位。
3. 首次恢复与新导入竞争：初始恢复成为队列首项，导入/清除串行等待，不整体丢弃其他槽。

限定复核确认三项已解决，未发现修复直接引入的 P2+ 问题。审查没有执行程序，动态测试由主代理运行，不能混为审查独立复验。模型输出行和分组有界，但取全部 entries 及 entry ID 去重集合仍随会话条目数增长，不能宣称整个请求 O(1) 内存。

## 独立 Browser 可见检查

隔离真实 Pi 页面 `http://127.0.0.1:46509/`；桌面 **1440×900**、手机尺寸 **390×844**。手工导入已下载的五张 WebP，均经浏览器解码实测 512×512、约 178–235 KB；只写测试浏览器当前站点 IndexedDB，没有进入包或上传 Pi。

截图存于工作区 `downloads/playwright-mcp/`（从仓库根目录为 `../../downloads/playwright-mcp/`），不属于发布资源：

- `whale-desktop-idle.png`：小立绘、拖动/收起/关闭按钮清楚可见，位于输入框上方，不挤占聊天布局。
- `whale-desktop-usage.png`：点击反馈立绘和滚动用量卡；总量、缓存、最近响应和模型明细可读，faux 零报价显示未知。
- `whale-mobile-idle.png`、`whale-mobile-card.png`：112×108 角色、310px 宽卡片在视口内，关闭按钮可见，输入框未被角色遮挡；正文/模型明细可在卡内滚动。`scrollWidth = 390`。
- `whale-mobile-settings.png`：五个素材槽缩略图与文件选择、显示/收起/关闭和减少动画控件在滚动设置面板内可见，无横向溢出。
- `whale-mobile-compact.png`：收起后 76×76 小入口，保留拖动、展开及关闭按钮，不盖输入。

已直接读取以上截图确认可见布局，不以 DOM 存在代替视觉证据。关闭用量卡与设置后可返回聊天。首次几张图在 reduced-motion specificity 修复前拍摄，只用于布局；修复后的设置/收起图与 computed 动画检查是单独证据。测试服务 PID 由 ready 文件记录，已发送 SIGTERM 并清理隔离 Pi；URL 不再表示可用服务。

## 后续优化：直接拖动与输入框右上方默认位置（本地，未发布）

- `core/whale-pet.ts` 增加默认锚点纯函数；`chat-input.tsx` 为输入容器提供明确锚点。无手动位置时右侧对齐输入框，底部留 8px；输入框增高、容器宽度和 visualViewport 变化时重新计算，不将自动位置写成用户偏好。
- `whale-pet.tsx` 允许直接拖动角色或专用把手，5px 阈值区分点击。拖动后记住位置；设置新增「恢复到输入框右上方」，清除手动偏好并恢复跟随。已有位置不自动覆盖。
- 独立只读快照审查发现两项 P2：缩放后 visualViewport 断点与 CSS 实际尺寸不符；scope 更新清空进行中的 drag，造成误点击和不保存。已改用实际元素尺寸、统一 finishDrag，scope 更新保留进行中的拖动；阈值开始即抑制点击。限定复核确认两项修复，未发现修复范围新增 P2+，但不是完整 diff 审计或独立动态复验。
- 最终默认单测 **254 项（253 通过、1 可选 GiB 跳过）**；鲸鱼娘真实 Pi Chromium **4/4**。覆盖桌面鼠标/手机 CDP touch 直接拖立绘、不误请求统计、刷新记忆、设置重置及刷新后恢复默认、真正多行输入增高跟随、三倍页面缩放后实际160px角色限界，以及拖动按住期间另一实际 WS 客户端执行 `/new` 后松开不误触并保存。测试使用隔离 Pi/faux 和合成图片，无生产会话。
- `npm run build:web`、`npm run check`（191 文件）、补充严格 types（0 diagnostics）、`npm run verify:dist` 和非 dist 源码 whitespace 检查通过。构建仍有既有大 chunk warning；manifest仅证明hash一致。没有重新跑完整65场景、后端16集成、离线pack或实际更新生命周期，不借用上一轮结果冒充本轮证据。
- 独立 Browser 最终页面 `http://127.0.0.1:45979/`，1440×900 / 390×844。实际导入本地待机WebP，直接查看 `downloads/playwright-mcp/whale-position-final-{desktop,mobile,mobile-moved}.png`（相对工作区）。截图中角色在输入框右上方、控件可见，拖动后可自由移动且不打开卡片；手机无横向溢出（scrollWidth390）。设置重置后重新对齐，角色底部708.4、输入框顶部716.4，间距8px。临时服务PID96087已SIGTERM并确认退出；初轮服务92924也已退出。
- 新增生命周期场景曾三次超时：测试观察客户端未对真实 Pi replacement 的 socket 断开重连，虽然收到请求ACK但无法观察新state_sync；改成有界重连观察，仍只发送一次 `/new`，没有放宽产品断言。修复后单项1/1及最终4/4通过。此前换行用例使用字面量反斜杠n的问题也已修正，增加实际高度增长断言。
- 仍未实测实体手机、软键盘、Safari/Firefox或公网。本轮未提交、推送、更新启用包或重载生产；没有将测试浏览器素材导入描述成用户手机已生效。

## 后续修复：软键盘式视口恢复后回到手动位置（本地，未发布）

- 根因：手动位置只保留一个被限界的显示坐标，视口收缩后再扩大仍从该临时坐标出发，因此无法回原位置。改用 `preferredPositionRef` 保留用户意图，resize/scroll/scope/mode 只更新显示位置；主动拖动/方向键才改偏好。拖动收尾保存偏好而非可能临时被限界的坐标。自动位置继续跟随输入框、不写手动偏好。
- 新回归先在未修改的已安装 `0ec4ac4` 上运行，确定失败 `expected608 / actual310`，日志 `/tmp/pi-whale-keyboard-before.log`、trace `.tmp/whale-keyboard-before/`。修复后鲸鱼娘真实 Pi Chromium **5/5**，日志 `/tmp/pi-whale-keyboard-after.log`：含布局视口844→430→844、模态框暂停、缩小状态刷新后恢复、主动方向键重设偏好，以及仅覆写visualViewport高度/offset并触发resize/scroll的合成路径。不伪造WS或组件状态，不以合成视口证明实体软键盘。
- 默认单测 **254项（253通过、1可选GiB跳过）**；构建、Biome191文件、严格补充types0诊断、manifest和非dist whitespace检查通过。日志 `/tmp/pi-whale-keyboard-{unit,build,check,types}.log`。未重跑完整浏览器、后端集成或实际安装更新生命周期。
- 独立有限只读快照审查未发现可证实P2+；审查未取得diff、未执行测试，不能冒充完整变更审计或独立动态验证。
- 独立Browser URL `http://127.0.0.1:45671/`，手机390×844→390×430→390×844和桌面1440×900。直接查看工作区相对路径 `downloads/playwright-mcp/whale-keyboard-{before,shrunk,restored,desktop}.png`：手动y608.4临时到310.4，恢复后回608.4，角色控件保持可见。缩小视口时手动位置只限界到可见区域，仍可能覆盖输入框/发送按钮；本轮未新增输入框避让，不宣称不遮输入。临时服务已停止。
- 本轮未提交、推送、更新启用包或重载生产。未实测实体手机软键盘/Safari事件时序；已有被用户主动保存的坐标按现存值恢复，无法还原更早版本曾丢失的原始位置。

## 失败尝试及限制

- 前端代理草稿未完交接：缺 test ID、费用行未显示部分未知、最近响应未列数字和重复 validator 等由主代理补完，不把草稿当通过。
- 早期单测在共享文件仍编辑时遇到聚合排序改变后的预期值及 null storage 返回预期不一致；测试与实现语义修正后默认完整 253 项无失败。
- 首轮鲸鱼娘两场景失败：错误提示当时还是 role=status、组件缺点击 test ID。补齐后 2/2，再加故障回归后 3/3。
- 第一轮完整 Chromium 外层 300 秒命令超时，只完成到约第 54 项，未算完整通过。随后一轮 63/64：Hub desktop replacement 之后发送草稿偶发未清空；未改产品或放宽断言，单独 Hub 5/5、最终完整 64/64。该次偶发失败保留于 `/tmp/pi-whale-browser-final.log` 和 `.tmp/whale-e2e-final/`，不据重跑声称已定位根因。
- 浏览器首次合成 PNG 样例解码失败，fixture 改用实际 canvas 生成的有效 PNG，未放宽解码校验。
- 独立 Browser 中途选中旧标签页导致等待超时，重新选择本轮 URL 后完成；旧页面连接错误不算本轮产品失败。
- 尚未实测实体手机软键盘、Safari/Firefox、Windows/macOS、实际 Provider 账单、公网入口、跨设备同步或真正安装生命周期。卡片按 visualViewport 限高，但不以尺寸模拟证明所有手机键盘行为。
- 不承诺跨标签即时素材同步。浏览器清站点数据会丢失素材；临时槽刷新不能保留。用户素材许可证与软件 MIT 分离，本地导入不是公开再分发授权。
