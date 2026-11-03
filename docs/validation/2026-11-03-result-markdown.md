# 分页全文 Markdown 渲染修复 · 2026-11-03

## 已复现的故障与修复

1. 原生 assistant 同时含 thinking/text 时，详情格式判断只接受纯 text 数组，导致有效 Markdown 全部按源码显示。现在允许可读的 thinking/text 组合，保留原有 `Thinking:` 标签、顺序和正文；结构化工具参数与二进制块不会因此被当作 Markdown。
2. 边界扫描只在换行时处理标记；代码围栏、`$$` 或原生显示公式的闭合标记落在 EOF 时被误判为未闭合。现在也处理 EOF 的最后一行，不插入字符或改变源偏移。只有开头标记、缺少闭合标记的内容仍降为源码。
3. 阅读框跨关闭保留 `sourceEntry`，同一条目重新打开后仍是源码。现在关闭即卸载该次阅读状态，重新打开默认排版；状态也绑定 session/runtime/entry，翻页不重置用户在当前阅读框内的源码选择。

没有用户提供的具体失败正文，本轮证据证明上述可重复路径已修复，不断言覆盖了所有可能的 Markdown 格式问题。

## 实测

- RED：新增格式测试在旧实现中两项失败，均为预期 `markdown`、实际 `text`。原生 thinking 与无末尾换行标记分别触发。
- RED：真实 Pi/Chromium 先验证正常分页与源码切换，再关闭重开；旧界面无法找到已渲染标题，证实源码模式残留。
- GREEN：`node --import ./tests/register-ts.mjs tests/entry-detail.test.ts`，11/11 通过，包括未闭合/超大原子块回退、64 KiB 完整响应限制、精确内容重组和身份/修订游标约束。
- 完整单元回归：`node --import ./tests/register-ts.mjs --test --test-concurrency=4 tests/*.test.ts tests/*.test.mjs src/web/src/core/i18n.test.ts src/web/src/components/pi-web-ui/sidebar-tree.test.ts`，524 项，523 通过、0 失败、1 个原有可选 1 GiB 流式测试跳过。
- `npm run build:web`、`npx --no-install tsc --noEmit -p tsconfig.connection.json`、`npm run verify:dist` 通过。原有 Vite 大 chunk 和 Node 模块类型等提示保留；哈希一致性不等于可信签名。
- 修改的七个 TypeScript/TSX 文件通过定向 Biome 检查。
- `npm run e2e:gen` 后，以已安装 Chromium 执行 `playwright test -c e2e/playwright.config.ts --grep @history-pagination`：最终 2/2 通过，13.1 秒。

浏览器覆盖：含 thinking 的超长回答双向翻页、标题/表格/公式、源码模式关闭重开；历史翻页与滚动稳定；真实 Pi 在临时工作区通过 write/read 创建并读取没有末尾换行的 Markdown 文件，重新加载保存历史后打开其结果，确认正文排版、最后代码块、源码全文与文件完全一致。只读浏览前后合成 JSONL 哈希不变。

新增真实文件用例最初未触发历史预览入口：先误在实时完整输出中寻找分页入口，随后发现文件仅约 15.6 KiB，低于 16 KiB 条目预览门限。修正为读取保存历史及约 23 KiB 的文件后通过；没有放宽产品阈值、跳过断言或延长测试时限。一次自动权限审核超时未执行命令，允许的重试成功。

## 可见界面检查

内置 Browser 工具不可用，采用本机 Playwright Chromium 截图替代，且已实际打开检查，不以 DOM 命中替代画面。

- 地址为每次测试分配的 `http://127.0.0.1:<临时端口>/`，不是线上域名。
- 桌面 1440×1000：正文标题、代码高亮、表格和公式可见；独立正文滚动，工具栏和关闭按钮未被遮挡。
- 手机 390×844：翻页/源码控件换行但均在屏内；末尾表格、公式和代码可读。长代码保持块内横向滚动，没有撑大整个页面。
- 已查看 `.tmp/history-pagination/desktop-reopened-markdown.png`、`mobile-reopened-markdown.png`、`desktop-read-file-markdown.png`、`mobile-read-file-eof.png`。

所有进程使用独立临时 HOME/Agent/session 目录和 faux provider，测试结束由 harness 清理；没有读取真实聊天、使用真实模型或操作生产卷。

## 生效范围与保留边界

- 本轮未提交/推送/合并、安装更新、重新加载运行中的 Pi 或重启 Hub；本地已重建跟踪的 dist。
- 部署需要同时更新扩展端与前端构建，再在空闲时重新加载或重启 Pi 并刷新网页；不需要新增服务或修改 Hub/Compose。
- 未闭合或超过单页预算的单个大代码块、公式块、表格仍显式回退源码；本次不把不完整分段伪装为完整 Markdown。
- 不宣称实测了物理手机、Safari、阿里云公网链路或用户这次失败的具体会话。
