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

## 失败尝试及限制

- 前端代理草稿未完交接：缺 test ID、费用行未显示部分未知、最近响应未列数字和重复 validator 等由主代理补完，不把草稿当通过。
- 早期单测在共享文件仍编辑时遇到聚合排序改变后的预期值及 null storage 返回预期不一致；测试与实现语义修正后默认完整 253 项无失败。
- 首轮鲸鱼娘两场景失败：错误提示当时还是 role=status、组件缺点击 test ID。补齐后 2/2，再加故障回归后 3/3。
- 第一轮完整 Chromium 外层 300 秒命令超时，只完成到约第 54 项，未算完整通过。随后一轮 63/64：Hub desktop replacement 之后发送草稿偶发未清空；未改产品或放宽断言，单独 Hub 5/5、最终完整 64/64。该次偶发失败保留于 `/tmp/pi-whale-browser-final.log` 和 `.tmp/whale-e2e-final/`，不据重跑声称已定位根因。
- 浏览器首次合成 PNG 样例解码失败，fixture 改用实际 canvas 生成的有效 PNG，未放宽解码校验。
- 独立 Browser 中途选中旧标签页导致等待超时，重新选择本轮 URL 后完成；旧页面连接错误不算本轮产品失败。
- 尚未实测实体手机软键盘、Safari/Firefox、Windows/macOS、实际 Provider 账单、公网入口、跨设备同步或真正安装生命周期。卡片按 visualViewport 限高，但不以尺寸模拟证明所有手机键盘行为。
- 不承诺跨标签即时素材同步。浏览器清站点数据会丢失素材；临时槽刷新不能保留。用户素材许可证与软件 MIT 分离，本地导入不是公开再分发授权。
