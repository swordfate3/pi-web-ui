# 聊天顶部日期筛选收缩

## 改动

用户反馈日期区占据聊天可视空间。本轮只改主聊天区日期展示与对应文案／回归，不改后端协议、历史范围或 `/resume` 日期选择器，也保留上一轮未提交附件上传改动。

- 默认收起，显示“日期 + 已应用日期范围 + 箭头”，点击或键盘 Enter/Space 展开／收起。
- 日期表单保持挂载，未应用的编辑不因折叠丢失；摘要始终反映已应用范围。
- 折叠不发送 `get_history`，不重置分页或已应用筛选。
- loading、error、历史视图实时消息提示与分页仍可见；统计／详细预览说明随日期表单收起。
- 使用 `aria-expanded`、`aria-controls`、原生按钮与可见焦点样式；`hidden` 面板里的输入不参与 Tab 导航。

## 验证

使用现有依赖、临时合成会话与 faux provider，不接触真实对话／生产服务。

| 项目 | 结果 |
| --- | --- |
| `npm run build:web` | 通过（含前端 TypeScript、Web/Hub 构建、manifest 重建） |
| `npm run check` | 174 文件通过，无警告／错误 |
| `npm run test:unit` | 213/213 通过 |
| `npm run verify:dist`、`git diff --check` | 通过 |
| 新日期展开／折叠真实 Pi 浏览器 | 桌面／手机 2/2 通过 |
| 最终完整真实 Pi 浏览器 | **60/60 通过**，3.9 分钟，含上一轮上传／下载／Hub 交接回归 |
| 独立源码审查 | 限定四文件当前快照未发现可证实问题；不代表完整 diff 或独立动态验证 |

浏览器使用 `LC_CTYPE=C.UTF-8` 与已有 Chromium。此轮完整浏览器使用当前工作树源码及最终 `dist`，不是上一轮离线解包快照；没有再次执行安装／更新／打包，不能借历史安装结果宣称本轮安装通过。后端未改，不重复宣称后端集成结果。

### Browser 可见检查

Browser MCP 打开临时 `http://127.0.0.1:45327/`，真实大日期会话 fixture，中文界面：

- 桌面 **1440×900**、手机尺寸 **390×844**，展开与收起各一张截图，已直接读取查看。
- 收起后日期输入、快捷按钮和说明收起，聊天内容获得更多空间；日期摘要和展开入口清晰，分页仍可用。
- 大会话含分页的手机日期区域高度从约 **257 px** 减少到 **89 px**（约腾出 168 px）；无横向溢出，scrollWidth=390。普通无分页／警告会更紧凑，该数字不是所有页面固定高度。
- 未发现日期控件、摘要或输入框重叠／离屏。箭头截图可能在 transform 过渡中，交互与最终 aria 状态已由 E2E 检查。
- 首次 CDP 截图超时；将可见浏览器窗口恢复后重新捕获四张最终截图成功。可见 Chrome 点击使用 force；完整 headless E2E 使用普通点击及键盘。

临时 Pi 服务在检查后停止；该 URL 不代表当前仍可访问。未操作其他浏览器标签页或真实在线会话。

## 证据位置与交付

源码：`src/web/src/components/pi-web-ui/history-controls.tsx`、`src/web/src/core/messages.ts`；回归：`e2e/features/date-history.feature`、`e2e/steps/date-history.steps.ts`。

原始日志与最终四张截图归档于：

```text
../../../../downloads/pi-web-ui-visual-check/date-filter-collapse/
```

相对于本报告，不随 Git 克隆分发。文件名 `pi-web-history-collapse-{build,check,unit,dist,browser,browser-full}.log`、`date-collapse-final-{desktop,mobile}-{open,closed}.png`。E2E 原始结果在忽略目录 `.tmp/date-collapse-full-results/`。

代码与匹配 `dist/` 留在未提交工作树；未提交／推送、未更新启用包、未重载当前 Pi，未更改 Hub／Caddy／隧道。上线仍需单独授权。
