# PRD: Minimal Chat Surface

## Intent

默认页面是安静、可阅读的对话，而不是常驻三列控制台。参考 assistant-ui 的可组合聊天交互和极简聊天布局，但保留现有 React/Vite/Zustand/PiClient，不引入第二套 runtime 或后端。

参考：

- https://www.assistant-ui.com/docs/ui/thread
- https://www.assistant-ui.com/docs/runtimes/custom/external-store
- https://www.shadcn.io/blocks/ai-chat-minimal （第三方设计参考，不复制其付费模板）

## Default Surface

- 桌面单行顶栏：会话树入口、会话标题、连接状态及少量模型/操作控制；窄屏分成两行，避免控件互相挤压。
- 模型不在标题副行重复展示。
- 居中的聊天内容及输入框；中性背景、克制边框和阴影。
- 会话树默认完全关闭，不留窄图标列；关闭时不挂载树行 DOM，轻量状态 owner 保留当前树缓存与搜索/折叠状态；打开时仅渲染视口附近的行。
- 工作区 git/artifact 按需从顶栏打开，不常驻覆盖聊天。
- 思考内容可查看但默认折叠；工具摘要和执行状态可见，输入/输出默认折叠。

## Progressive Disclosure

会话树、工作区、上下文、设置、命令菜单都是按需功能。简约不意味着删除能力：

- 保留 `/resume`、`/fork`、`/clone`、导出及其他已有命令。
- 保留高级命令的 `/webui` 启用和 lifecycle 保护。
- 保留草稿、排队消息、停止和附件。
- 保留文件/diff Right Panel tabs、去重与显隐恢复。
- Context 和 workspace 弹层不同时叠加。

## Mobile

- 每个必要操作都有触摸入口和 accessible name。
- 会话树使用 Sheet；`/tree` 打开正确的移动端导航。
- 工作区展示可选择的列表，而不是强制打开第一个 Git/artifact。
- 输入框、发送/停止按钮、弹层关闭按钮不得超出 viewport。

## Interface language

Settings provides English / 简体中文 switching. See `interface-language.md` for persistence, accessibility and the boundary between translated UI and unchanged conversation content.

## Verification

- 真实 Pi CLI → WebSocket → Chromium → faux provider 的功能 E2E。
- 桌面和手机 Browser 截图检查默认聊天、会话树、workspace 和 Right Panel。
- 已有长会话扁平传输回归保留。
- 更新 local release 时前端 `dist` 和扩展一起快照，不能只更新其中一半。
