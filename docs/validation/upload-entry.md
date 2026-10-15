# 上传入口辨识度

本报告记录分片开发之前的入口单独修改；其中 50 MiB 是当时协议上限，不代表后续分片版本的限制或验证结果。

## 修改

将聊天输入框的图片图标改为回形针，并在桌面和手机上始终显示“上传文件”（英文为 Upload files）。保留“添加图片或文件”的提示，文件选择、原字节上传和现有 50 MiB 上限不变。

## 验证

- `npm run build:web`、`npm run check`（174 文件）、`npm run verify:dist` 通过。
- 文件上传浏览器场景 3/3：真实 Pi direct desktop、Hub desktop、Hub mobile；新增按钮可见、文字、可访问名称和回形针断言，仍核对原字节落盘及路径交接。
- 独立 Browser 访问临时真实 Pi fixture，1440×900 和 390×844 截图直接查看：左下角回形针及中文文字完整可见，与发送按钮无重叠；手机 scrollWidth=390。截图位于工作区 `downloads/playwright-mcp/upload-paperclip-{desktop,mobile}.png`。
- 临时 fixture 已停止。未提交、推送或更新启用包。

## 范围

本次只改入口；大文件分片／续传尚未实现，不能据此宣称超过 50 MiB 的文件已受支持。
