# Pi Web UI 文档

项目说明文档统一维护在本目录。根 README 是包入口，AGENTS 是代理规则入口；不在下载/临时/测试目录另存人工报告。

## 开发与维护

- [开发日志](development-log.md)：项目自身的阶段性改动、验证、运行快照和待办。
- [斜杠命令支持矩阵](slash-command-support.md)：Pi 1.1.0 命令与浏览器边界。
- [连接配置](connection.md)：无需 WSL 的本地使用、手机访问、代理子路径及可选原生登记。
- [多会话总入口](hub.md)：包内独立总管、本地启动、集中配置、凭据与卷边界。
- [远程引导与登录管理](remote-access.md)：部署材料、终端设置账号、修改密码、独立恢复及适用边界。
- [发布指南](releasing.md)：npm 发布流程；本地未提交快照不等于 npm 发布。
- [许可证来源](license-provenance.md)：MIT 上游归属、fork 初始化许可证与包名边界。
- [单测指南](unit-tests.md)：纯逻辑、临时 IPC/TCP 及真实 Pi 测试，命令均从仓库根运行。
- [移动端历史说明](mobile.md)：旧移动布局记录，当前行为以 PRD 和验证报告为准。
- [验证报告索引](validation/README.md)：布局、双语、性能及证据局限。

## 功能设计

- [简约聊天](prd/minimal-chat.md)
- [双语界面](prd/interface-language.md)
- [交互性能](prd/interaction-performance.md)
- [工作区附件上传](prd/file-uploads.md)、[确认后下载文件](prd/file-downloads.md)
- [左侧栏](prd/left-sidebar.md)、[树导航](prd/tree-sidebar.md)、[分支消息](prd/branch-message.md)
- [Workspace 入口](prd/workspace-status-float.md)、[产物](prd/workspace-artifacts.md)、[详情面板](prd/right-panel.md)

架构与协议决策维护在 `adr/`，包括 [事件协议](adr/0002-web-ui-extension-event-protocol.md)、[生命周期](adr/0005-intercepted-command-ui-lifecycle.md)、[WebSocket 协议](adr/0008-unified-websocket-protocol.md)、[真实 E2E](adr/0010-real-pi-web-ui-e2e.md)、[视觉验证](adr/0011-web-ui-visual-validation.md)、[附件分片续传](adr/0016-resumable-workspace-uploads.md)。

- [网页鲸鱼娘](prd/whale-companion.md)：页面内悬浮、显示生命周期、本地素材与当前会话用量。
- [ADR 0017](adr/0017-web-whale-companion.md)：浏览器资源与公开软件许可分离、只读统计及 scope fencing。
