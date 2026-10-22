# 思考区数学公式补齐

## 原因与修复范围

- 回退后的 `main`（`bdc17f4`）保留了聊天正文的原生 TeX 修复。
- `MessageResponse` 使用 `remarkTexMath`，而 `ReasoningContent` 仍直接使用默认 math 插件。相同的 `\(...\)`、`\[...\]` 在正文与思考区因此产生不同结果。
- 本次只把思考区接到同一解析器；不改变 dollar math 策略、不改写 Markdown 原文、不启用 KaTeX `trust`，也不改变思考区默认折叠行为。
- 补充真实 React 组件 SSR 测试，避免只测试解析器而漏掉组件接线；测试用 TSX 加载器仅供 Node 测试使用，无新增依赖。
- 真实 Pi 数学场景增加合成 thinking 内容、展开检查、手机宽度检查和桌面／手机截图步骤。等待最终历史同步后才展开，避免流式行被最终 snapshot 替换导致折叠状态失效。
- 已重新构建跟踪的 `dist`；含源身份信息的资源文件名和 Hub 构建指纹随之更新，不表示部署了 Hub。

## 本次验证

1. **Red**：修复前，真实正文组件渲染 3 条公式；真实思考组件仅渲染旧格式的 1 条。新增组件测试共 6 项，5 通过、1 失败，失败为 `1 !== 3`。
2. **Green**：接入解析器后，既有 6 项解析器／Streamdown 测试和新增 6 项组件测试全部通过。
3. 公式、真实组件、渲染性能与 service worker 范围的定向回归 **21/21 通过**。
4. `just check` 通过，仍有既有 33 warnings、7 infos；本次修改文件的定向 Biome 检查无诊断。
5. `npm run build:web` 和 `npm run verify:dist` 通过。构建仍有既有大 chunk 警告。
6. `npm run e2e:gen` 通过；真实 Pi 浏览器场景**未完成运行**：Chromium 在进入场景前启动失败，报 `setsockopt: Operation not permitted`，随后 `SIGTRAP`。没有桌面／手机验收截图，不能以 SSR 或 DOM 结果代替视觉验收。本次无可用的 in-app Browser 自动化工具。
7. 扩大的构建工具回归 66 项中 65 通过、1 失败。单独运行未修改的 `web-dist` 测试也复现相同 CLI 子进程输出为空；最小独立 `spawnSync` 打印示例返回 `error.code: EPERM`，即当前沙箱拒绝子进程执行。直接运行产物校验通过。未修改脚本或放宽断言来掩盖失败。
8. 独立只读审查认可本次源码与测试范围的修改，未发现新的重要问题；最终历史同步等待也已核对。审查没有运行浏览器，不替代仍缺少的 E2E 与截图验收。

## 交付边界

这是 `codex/hub-version-picker-updates` 上基于 `e7a7acb` 的本地修复，不代表该分支其他未完成的版本更新功能已获准上线。

未安装扩展、未推送、未合并 `main`，未重启或修改生产 Pi／Hub／Gate。保留用户已有未跟踪文档。浏览器场景、桌面与手机视觉验收仍需在允许 Chromium 与本地测试服务运行的环境中补验。
