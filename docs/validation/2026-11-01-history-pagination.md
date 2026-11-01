# 历史分页与完整结果阅读验收 · 2026-11-01

## 用户行为

1. 日期栏不展开也能点“更早一页 / 更新一页”；第 1 页表示此次阅读快照中最新的一页，不代表全部会话只有一页。
2. 往回翻后固定历史上界。新回复显示提示，不替换当前页；“回到最新”清除快照锚点并选择最近三个本地日历日。
3. 预览下点击“分页阅读全文”，在同一阅读框前后翻页。正文优先 Markdown，支持表格、代码和公式；源码按钮可看原始可读文本。超大的单个代码/公式块明确按源码分页，后续安全段恢复排版。二进制仍不传入详情。
4. 网页只保留当前历史页与一页详情正文，往返使用游标元数据重新请求；不会将所有页拼进内存，也不改写、截短或删除保存的会话。

## 已执行验证

- `node --import ./tests/register-ts.mjs --test --test-concurrency=4 tests/*.test.ts tests/*.test.mjs src/web/src/core/i18n.test.ts src/web/src/components/pi-web-ui/sidebar-tree.test.ts`：521 项，520 通过、0 失败、1 个原有可选 1 GiB 流式测试跳过。
- `npx --no-install tsc --noEmit -p tsconfig.connection.json`：通过；`npm run build:web` 包含应用类型检查并构建成功。
- `npm run verify:dist`：源码与分发构建哈希一致。这不是代码真实性或安全签名证明。
- `PI_E2E_BROWSER_EXECUTABLE=<已安装的 Chromium> npx --no-install playwright test -c e2e/playwright.config.ts --grep '@history-pagination|@date-history|数学公式|简约折叠回归' --max-failures=1`：6 个场景全部通过。
- 分页场景覆盖：双向回到同一内容、首页非零滚动位置恢复、长结果前后页和源码切换、表格与公式、旧页新回复提示与滚动稳定、回到最新、最新页向上阅读时追加回复不跳底。只读浏览前后的合成 JSONL SHA-256 不变。
- 状态回归覆盖：UTC/本地日期范围不同的在线重连补全、过去日期首页保持、分支切换清除旧锚点、过期游标/锚点恢复、请求失败保留上页、旧请求不得写入另一会话。详情服务测试覆盖逐页精确重组、Unicode/JSON 转义、完整响应 64 KiB 上限、超大代码块和原生显示公式。

所有 Pi 进程使用独立临时 HOME、Agent 目录、合成 JSONL 与 faux provider；没有读取正式会话、调用真实模型、挂载生产卷或操作线上服务。测试拥有的进程在退出时停止。

## 可见界面检查

Browser 工具不可用，采用 Playwright Chromium 截图替代；不是 DOM 存在即视为通过。

- 地址：隔离 Pi 在运行时分配的本机回环 HTTP 地址，不是固定生产入口。
- 桌面 1440×1000：日期/翻页可见；长结果对话框、页码、源码切换及独立正文滚动区域可见；代码和表格未撑破对话框。
- 手机 390×844：缩短页码后更早/更新按钮能同排显示；历史页提示和回到最新可见；详情控件换行，正文在框内滚动，没有页面横向溢出。
- 已查看 `.tmp/history-pagination/desktop-pinned-latest.png`、`desktop-markdown-page.png`、`mobile-new-replies.png` 和 `mobile-markdown-page.png`；其他过程截图同目录。截图中的鲸鱼浮层是原有功能，不是本次新增。

## 边界与上线状态

- 仍默认最近三个日历日；查看更早日期需展开筛选选择范围。翻页不自动扩大到全部历史。
- Markdown 分段使用保守边界扫描，不承诺任意跨段定义、复杂嵌套语法都能无损独立排版；源码保留可读全文。大代码/公式块回退源码是显式行为，不是截断。
- 详情游标继续绑定当前会话/runtime/leaf/条目修订，失效需重新打开预览，不放宽访问栅栏。
- 历史完整包 256 KiB、条目页 40 条/192 KiB、浏览器序列化内容 200 条/512 KiB 等既有预算保持；不是总 JS 内存、Pi 核心占用或磁盘容量的固定保证。
- 本轮仅本地实现、验证和构建；没有提交/推送/合并、更新已安装扩展、重启 Hub/Pi 或进行阿里云/手机实机上线验证。生效需要后续更新 Web 扩展代码和构建，再让 Pi 进程加载并刷新网页；不要求新增 Hub 服务或卷。
