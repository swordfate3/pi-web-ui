# PRD: Branch Message

## 每轮编辑与重答（新增）

在保留既有 Branch 图标的同时，用户消息下方显示「编辑并重新发送」，已保存的 AI 回答下方显示「重新生成回答」。前者编辑原问题全文，后者只读确认原问题；确认前不会导航或调用模型。两者都从原用户消息之前的上下文产生新分支，不把旧答案或其工具结果当作新上下文。不是手动修改 AI 历史正文。

- 原文来自 Pi 保存的 entry 父链，不使用网页有界预览。完整文本超过 JSON 转义后 2 MiB 时拒绝而不截断；原图片留在后端并随原问题重发，不将 base64 回传浏览器；无法保留的附件类型明确拒绝。
- 对话框提示保留旧分支、不回滚文件、可能再执行工具及消耗 Token；重新执行不撤销先前文件改动、外部请求或部署。
- 需要当前连接、`/webui` 能力、Pi 空闲、无其他 session action；草稿、排队消息、附件或上传/交接先由用户处理，不能静默覆盖或错发。
- identity / leaf 改变后须重新检查；一次性 preview 属于当前连接，旧提交不可重放。派发 ACK 不代表 Pi 接受或生成成功，超时不自动重发。
- Tree 保留旧问题、旧回答与新版本。普通节点点击仍只定位；使用分支末尾箭头切换版本，草稿非空时确认并保留。Tree 仍是有界历史视图，受当前日期及加载范围影响，不承诺无限量全部展开。
- 首个原问题可以从 root 前重答；当前 leaf 本身恰为目标用户 entry 时 Pi 导航是 no-op，本功能明确拒绝，待有已保存回答后再操作。

下方描述为保留的原 Branch 图标行为；新增编辑使用独立确认框，不覆盖其主输入框流程。

## Problem Statement

Pi 的 `/tree` 支持在同一个 session 文件里回到某个历史节点并继续对话，从而形成新的分支。Pi Web UI 需要把这个能力暴露到浏览器，但不能把它命名为 Fork：Pi 官方 `/fork` 会创建新的 session 文件，和这里的同 session 分支语义不同。

## Solution

在 user message 上提供 **Branch** 操作。用户点击 Branch 后，Pi 将当前会话位置移动到该 user message 之前，并返回原消息文本。Web UI 将文本填入主输入框，用户修改并发送后，在当前 session tree 中生成一个新分支。

Tree sidebar 也可以在 user node 上显示 Branch 按钮，作为非当前分支的入口。普通 Tree row 点击只做本地 select/locate/highlight，不切换会话位置，不改变 conversation 内容，也不覆盖 draft。

## User Stories

1. 作为 Pi Web UI 用户，我希望从任意 user message 创建同 session 分支，这样可以保留旧路径并尝试另一种输入。
2. 作为 Pi Web UI 用户，我希望 Tree 里的普通点击只帮我定位和理解结构，不会意外切换主 conversation 或覆盖正在写的 draft。
3. 作为 Pi Web UI 用户，我希望非当前分支上的 user node 也能直接 Branch，因为它不会出现在当前 conversation 的快捷按钮里。
4. 作为 Pi Web UI 用户，我希望功能名称和 Pi 官方命令一致：Branch 表示同 session tree 分支，Fork 保留给未来创建新 session 文件的功能。

## Implementation Decisions

### UI Entry Points

- Conversation user message action row 显示 Branch 按钮。
- Tree sidebar 的 user node 显示 Branch 按钮。
- Tree row body click 只做本地 select/locate/highlight。
- Branch 操作会在 draft 非空时确认是否覆盖。

### 操作流程

1. 用户点击 Branch，若 draft 非空则确认是否覆盖。
2. 系统定位到目标 user message 前，将原消息文本填入输入框。
3. 用户修改文本后发送，在当前 session tree 中生成新分支。
4. Branch 成功后自动刷新当前 branch 内容和完整 tree 结构。

### Naming

用户可见文案使用 Branch：

- Button label: `Branch from message`
- Tooltip: `Branch from message`
- Status text: `Branching from ...`
- Error: `Branch failed`

功能命名与 Pi 命令保持一致：Branch 对应同 session tree 分支，Fork 保留给未来创建新 session 文件的功能。

## Out of Scope

- 不创建新的 session 文件；真正的 Fork 应该使用 Pi 的 Fork 功能单独实现
- 不支持 Branch assistant/tool/system node
- 不做 inline edit；Branch 文本填入主输入框
- 不提供分支预览或分支合并

## Acceptance Criteria

1. Conversation user message 和 Tree user node 都有 Branch 入口。
2. Branch 成功后输入框填入原 user message 文本并获得焦点。
3. 普通 Tree row click 不改变 `leafId`、不刷新 conversation、不会覆盖 draft。
4. 发送 Branch draft 后，Tree 更新并展示新的 sibling branch。
5. UI 和文档不再用 Fork 描述当前 `navigate_tree` 功能。
