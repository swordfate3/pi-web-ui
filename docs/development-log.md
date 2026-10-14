# Pi Web UI 开发日志

本文件记录 **pi-web-ui 项目自身**的开发过程，不是 Pi 本体的更新日志，也不是 npm 发布公告。

以下内容根据本轮开发交接、项目文档及保留的验证报告整理。旧阶段没有逐项记录可靠日期，因此按开发顺序归档，不补造日期、提交记录或测试结果。文中 release ID 是独立本地运行快照标识，不等于 Git 提交或已发布 npm 版本。早期各阶段的改动当时尚未 commit/push；后续 GitHub 发布准备见第 08 节。

## 文档与证据约定

- 项目开发日志、设计、运维指南及人工验证报告统一放在 `docs/`。
- 根目录只保留作为包入口的 `README.md` 和代理规则入口 `AGENTS.md`；Skill 的 `SKILL.md` 保持工具要求的位置，不复制成另一份项目文档。
- 原始测试日志、截图、JSONL 性能数据属于验证产物，允许放在独立产物目录，不在那里新增说明文档。
- 人工验证报告见 [validation/README.md](validation/README.md)；需求见 `prd/`，架构决策见 `adr/`。
- 后续追加日志应包含：改动原因、实现与边界、实际验证、发布状态、已知问题。未完成或失败尝试不得记作通过。

## 01 · 常用命令和动态资源接入

### 改动

- 接入 `/settings`、`/model`、`/thinking`、`/compact`、`/name`、`/new`、`/session`、`/tree`、`/copy`、`/export`。
- 模型切换和思考等级使用真实 Pi 能力；可选等级取决于当前模型，包括支持时的 `xhigh`、`max`。
- 通过 `pi.getCommands()` 发现扩展、prompt 模板、skill 命令；动态资源同名时优先，不将未支持的内置命令盲目发送给模型。
- 内部会话控制命令不出现在建议中，并拒绝浏览器直接调用。
- Skill 的显式调用形式是 `/skill:name`。新增资源需 Pi 重载后才能被当前运行实例发现，网页刷新不会代替 Pi 资源重载。

### 边界

接入命令不代表完全复刻 TUI。动态扩展若要求终端专用 UI，浏览器显示其命令也不意味着支持该交互。

完整支持情况见 [slash-command-support.md](slash-command-support.md)。尚未接入的内置命令为 `/scoped-models`、`/import`、`/share`、`/bug`、`/login`、`/logout`、`/trust`、`/hotkeys`、`/changelog`、`/quit`。本次整理日志没有顺带实现 `/changelog`。

## 02 · 会话生命周期、统计和 HTML 导出

### 改动

- `/fork`：在选定用户消息之前创建独立会话，并将该消息放回浏览器草稿。
- `/clone`：在当前 leaf 位置复制独立会话。原有 Branch/Continue 仍为同会话树导航，两者不能混淆。
- `/resume`：当前项目的已保存会话选择器，采用服务端 opaque selection ID，执行前复核身份、cwd 和文件路径。
- `/reload`：等待同 sessionId、不同 runtimeId 的新 snapshot，不能将 ACK 当作完成。
- pending 锁、20 秒期限、草稿/队列确认；成功才清队列，断线不自动重放。
- 会话替换或重载后旧上下文失效。长期回调使用 `latestCtx`，高级操作上下文清除，必须由用户在对应 Pi 终端重新 `/webui`。
- `/session` 区分全树累计 token/cost 和当前上下文占用，缺失数据标记为 unknown。
- `/export` 经敏感内容确认后下载 Pi 生成的完整树 HTML，使用同源 attachment 和 opaque token；不开放任意输出路径。异步生成、超时、并发/保留数量/TTL 限制及生命周期 fencing 防止旧结果串入新会话。

### 验证与限制

隔离真实 Pi JSONL 验证身份、fork 前缀、来源及原文件不变，覆盖取消、参数、权限、hook 和空会话边界。导出保护不等于能防御同 OS 用户的全部 TOCTOU 攻击；`/webui` 是新鲜上下文门控，不是网络认证。

相关决策见 [ADR 0005](adr/0005-intercepted-command-ui-lifecycle.md)、[ADR 0008](adr/0008-unified-websocket-protocol.md)。

## 03 · 长会话栈溢出与白屏修复

### 问题与纠正

- 深层树的 `JSON.stringify` 出现 `Maximum call stack size exceeded`。
- 第一版 depth-256 截断把 children 替换成字符串，造成白屏；该补丁验证不足，不能算正确修复。
- 正式修复将传输改为迭代 flat `treeNodes`，包含 entry、结构 parentNodeId 和 label。结构父关系来自真实 children，不改持久化 entry.parentId。
- 浏览器通过 Map 和迭代重建完整树，兼容合法旧格式；缺父、重复 ID、环或错误 children 原子拒绝，保留上一份有效树并提示错误。
- 没有在线客户端时不序列化广播；有客户端时只序列化一次。首次同步失败有明确错误。

### 验证与运行快照

- 真实 SessionManager 20000 节点内存验证、31 项树单测。
- 6000 主线消息、3 条侧支、3 个标签的真实 E2E，桌面/手机截图。
- 正确长树版本完整 25 个真实 E2E 通过。
- 本地快照：`0.1.1-a7cb0697266590fd0d469da2`。

此前错误快照 `0.1.1-69f95bb9d221df1960e667db2bb74f4726bf568c`、`0.1.1-72e291f9dbb34917885e35c42682eed16cebd163` 仅作为故障追溯，不应选作回滚目标。

## 04 · 简约聊天布局与移动端

### 改动

- 默认以聊天为主，侧栏完全关闭且不留窄图标列；手机 `/tree` 使用真实 Sheet。
- workspace 按需打开，选择后关闭对话框再交接到详情面板；与 context 面板互斥，重复打开不产生重复 tab。
- reasoning 和工具详情默认折叠；隐藏不等于删除内容。
- 窄屏两行 header，桌面单行；隐藏桌面侧栏使用 inert/aria-hidden，避免隐藏控件仍进入焦点与可访问树。
- 初版关闭时卸载树，将成本集中到首次打开；后续性能阶段改为保留轻量 owner、只卸载行 DOM。

### 验证与发布

27 个真实 E2E、31 个树单测及静态/build 检查通过；1440×900 桌面、390×844 手机和 workspace→detail 焦点交接检查完成。

本地快照：`0.1.1-6c2704b5ff296a022c42b6a3`。详细记录见 [minimal-validation.md](validation/minimal-validation.md)。

## 05 · 简体中文 / English

### 改动

- Settings 即时切换 English / 简体中文，浏览器本地持久化。首次按最高优先级浏览器语言选择，`zh*` 使用简体中文，其他使用英文。
- 集中类型安全词典、独立 React 语言订阅；切换不重连 WS、不改会话、不清草稿或队列。
- 消息正文、代码、路径、模型 ID、会话名、协议/斜杠标识符、动态扩展内容及原始后端错误保持原样。
- 前端通知保存可延迟翻译的描述符，时间显示随语言更新；接入实际 Streamdown wrapper 的 29 个官方翻译字段，现有 Markdown 不因切换重挂。
- localStorage 异常、非法语言偏好有安全回退。

### 验证与发布

32 个真实 E2E、38 个单测（7 个 i18n + 31 个树测试）通过；桌面/手机中英视觉检查及实际本地 release smoke 完成。

本地快照：`0.1.1-3455d073085dedfbc606806b`。详细记录见 [i18n-validation.md](validation/i18n-validation.md)。第三方 Mermaid 部分内部文案仍由上游硬编码；并未穷尽全部深色主题和跨浏览器状态。

## 06 · 首轮交互性能优化

### 原因

侧栏/设置状态会引发聊天列表重复渲染，工具重复解析全文；长树全量挂载，高亮和逐帧宽度变化占用主线程。缓存目标是浏览器重复计算，不需要 Redis、数据库或新服务。

### 改动

- memo ChatList/ChatRow、稳定 copy/ref callbacks，复用未变化的 item 引用；双语订阅保留。
- 工具预览缓存，默认限制 12 行 / 4096 字符；完整参数/结果始终可复制。
- 大内容使用纯文本分页（16000 字符 / 200 行），展示范围与提示，不静默丢弃历史/原文。Pi 自身工具返回截断与 UI 展示分页分别说明。
- 高亮完整 language/code key、重复请求去重、LRU 64 项/约 8 MB/16 pending；大代码避开全文 Shiki 和大量 token DOM。这不是 worker offloading。
- 侧栏 32px 固定行虚拟列表，上下各 6 行 overscan，缓存结构、摘要、搜索/折叠投影；仅当前 snapshot/query，不跨会话无界保留。
- 搜索匹配/当前位置通过模型索引定位未挂载节点；键盘导航保留。滚出 overscan 的真实 focused row 最多额外挂载一行，避免按钮焦点丢失。
- 文本摘要另有包含空白的 4096 字符扫描预算；换 sessionId 重置 owner，同会话关开复用状态。
- 侧栏 gap 宽度一次提交，固定侧栏仅 transform 动画；聊天 initial/resize bottom following 改为 immediate，避免工具收起叠加 spring scrolling。

### 可比本地性能样本

真实 Pi/WS/Chromium，1440×1000，6000 消息，等待末端 marker 与 1 秒 settling 后计时。旧双语 immutable release 与优化 build 使用同一测试方法，每项两次样本。

| 指标 | 旧版本 | 优化版本 |
| --- | --- | --- |
| 侧栏点击→搜索框可见 | 2879.8 / 2959.9 ms | 930.8 / 911.0 ms |
| 侧栏点击→double RAF | 3429.3 / 3359.1 ms | 1127.8 / 1087.6 ms |
| 挂载侧栏行 | 6003 / 6003 | 32 / 32 |
| 大工具展开→double RAF | 207.9 / 90.6 ms | 103.2 / 74.9 ms |
| 大工具收起→隐藏 | 599.9 / 1146.8 ms | 230.7 / 223.5 ms |

计时包含 Playwright 操作/可见性等待，不是精确 INP、CPU profile 或所有设备承诺。早期受首次历史加载污染的样本不参与比较；超长聊天仍全量挂载，侧栏约 0.9 秒等待不是“完全即时”。早期大工具 E2E 失败不记为通过；后续加入 agent-settled snapshot 等待后通过完整验证，未声称已定位所有断线原因。

### 验证与发布

- 36 个真实 Pi E2E、55 个单测通过；TypeScript/Biome/build/diff 检查通过。
- 真工具测试覆盖 300018 字符单行、347999 字符多行参数的完整 clipboard，以及分页、工具实际返回值、虚拟行和滚轮后的焦点。
- 桌面/手机视觉检查、实际 release 长树 smoke 完成；截图准备与正常功能 E2E 分开报告。
- 发布完整独立快照：`0.1.1-18cb709e34a9d398464c1a54`，693 文件 inventory/hash/source parity，无 runtime symlink，仅一个启用的 WebUI 注册。
- 临时测试进程与端口已清理；未向真实用户会话发消息、reload 或停止其 Pi。

详见 [interaction-performance.md](prd/interaction-performance.md)、[perf-validation.md](validation/perf-validation.md)。

## 07 · 文档归档（本次）

- 新建本开发日志和 `docs/README.md` 入口。
- 将布局、双语、性能验证说明和早期基线报告从下载目录迁入 `docs/validation/`；保留原始产物，修正相对位置和旧样本状态。
- 将移动端历史说明、npm 发布指南、单测指南分别迁为 `docs/mobile.md`、`docs/releasing.md`、`docs/unit-tests.md`。
- 根 README/AGENTS 只保留入口/规则和文档导航；不在其他目录新建文档副本。
- 本次只整理文档，不更改 UI、命令、安装配置或已发布快照，不重新跑浏览器套件。

## 08 · GitHub 发布准备

- 目标仓库为 `swordfate3/pi-web-ui`，保留上游历史与归属，不强制覆盖目标仓库初始化提交。
- 目标仓库原初始化只有 Apache-2.0 LICENSE；维护者明确选择沿用 MIT，补充根 LICENSE 和 [许可证来源](license-provenance.md)。依赖许可证保持原状。
- 删除上游 launchd 示例里写死的个人 HOME；补充 `.tmp/`、`.env.*` 和私钥文件忽略规则。
- README 安装/克隆路径与 package repository 指向此 fork，保留 npm 上游版本说明，不执行 npm 发布或改包名。
- 已重新检查当前与完整上游历史的常见秘密模式、待提交文件名单；未发现明确密钥或真实会话文件。模式检查不能保证绝无遗漏。
- 发布前 Biome/build/diff 检查和 55 项单测通过；此前 36 个真实 E2E 结果仍作为功能证据，本次仅元数据/文档/忽略规则变更未重跑浏览器套件。
- 本节记录发布准备，不预先宣称 push 成功；最终提交与远端状态以 Git 为准。

## 09 · Git 安装无需开发工具

- 修正旧 prepare 在生产依赖安装时调用 Vite/TypeScript 的问题；安装不再构建或另行下载资产。
- 前端完整 `dist/` 随安装 ref 提交，新增确定性 source/output manifest；prepare 使用 Node 内建校验，完整源码与产物不同步时拒绝安装。安装时仅豁免 npm 可能写回的 lock 字节，CI/default 仍验证 lock。
- 生产依赖缩减为 `ws`；React/diff/Zustand 归为构建依赖，Pi 1.1 仅作为开发测试 runner，不在消费包中嵌套安装。
- CI 增加提交产物检查、重建一致性、72 项单测、真实 Pi 生产安装/更新及生产安装版 E2E。
- 本地验证：真实 install/update/tarball 通过；真实 Pi 安装过期源码 commit 被 prepare 拒绝；仅 1 个运行依赖；36 项真实 E2E 通过。干净 dev install 重建一致，正常 npm pack 完成（685 文件/约 4.8 MB 压缩包）。
- 不修改用户 package settings、不升级现有启用包、不自动 reload 会话。维护者已授权将本批源码与产物一起发布到远程 main；实际发布提交以 Git 历史为准，GitHub CI 运行结果另行核对。
- 详见 [ADR 0007](adr/0007-npm-publish-distribution-strategy.md)、[安装验证](validation/git-install-validation.md)。

## 10 · 可移植连接管理（2026-10-14）

### 改动原因与实现

- 本地 Web 使用不应依赖个人 WSL 路径、Docker 启动脚本或阿里云。将监听地址、端口、自动启动、公网入口和可选登记统一到 `settings.json["pi-web-ui"]`，环境变量显式覆盖。
- 默认仍为 loopback 自动启动。端口冲突顺序递增，限定重试期限和 TCP 范围，不设固定会话数量；停止时取消未完成监听，清理每轮失败监听的资源。
- 内置可选 capability 登记客户端，发送真实端口、续租、退出注销，并在重载/退出时先使旧回调和 generation 失效。登记故障不关闭本地 Web；配置和远端错误仅显示通用提示，不回显凭据。
- 浏览器资源、WebSocket 和导出原生遵循入口子路径。子路径不注册 service worker，root worker 不拦截代理会话/API/其他站点路径；不改写浏览器全局函数。
- `/webui` 使用无 shell 插值的平台打开方式；未打包隧道、登录页、登记服务端或进程管理器。公网访问仍需外部 TLS 和认证。

### 验证与交付边界

- 77 项单测、3 项真实 Pi 后端集成、39 项完整浏览器测试通过；Biome、TypeScript、生产构建与 diff 检查通过。npm dry-run 包含新增运行模块，生产依赖审计为 0。
- Chromium 截图复看了根入口和代理子路径桌面 1440×900、手机尺寸 390×844：连接指示、回复、顶栏与输入框可见，未观察到空白或裁切。不等于实体手机或 app Browser 实测。
- 初次浏览器导出测试因漏处理确认弹窗失败；修复测试后定向三项和全套均通过。开发依赖审计及既有构建警告未顺带处理。
- 在 `codex/portable-web-connection` 交付本地分支提交，不合并、不推送、不发布。未改原有工作区、共享 Pi 设置、运行容器或阿里云链路，尚未测试原生 Windows/macOS。

详见 [connection.md](connection.md)、[ADR 0012](adr/0012-portable-web-connection.md) 和 [验证报告](validation/2026-10-14-portable-web-connection.md)。

## 11 · 远程访问引导与登录信息管理（2026-10-14）

- 将已批准设计实现为中英双语向导：可跳过首访提示、设置入口及 `/webui-setup` 本地入口，不依赖公网先可用。
- 非敏感计划严格校验，显式保存浏览器草稿，预览／下载部署材料。只读连接 RPC 使用 typed store intent，返回实际监听端口，不泄露登记凭据。
- 新部署明确为 Linux/OpenSSH/Caddy 单会话；已有网关接入保留认证、说明原生登记与容器挂载，不自动创建多会话路由。
- 独立终端工具实现首次自行设置账号密码、修改／重命名、忘记密码恢复和实际 HTTPS 登录验证，无默认密码、无网页管理员执行接口。
- 专用站点解析、维护锁、原子替换、私有备份、完整配置和新账号检查、并发拒绝及失败回滚；新增站点拒绝外部 WebSocket Origin。
- 79 项单测、3 项真实 Pi 后端集成、41 项真实浏览器 E2E、13 项 Python／隔离真实 Caddy 检查通过；最后 Python 工具修复后重建并复跑两项向导用例。桌面／手机尺寸截图已直接检查。实际手机与阿里云未测试／未改动。
- 独立审查补强全局处理顺序：认证和 Origin 拒绝必须先于终止代理执行，复杂路由失败关闭；真实 Caddy 顺序覆盖回归验证拒绝重载与回滚。
- 复审补强跨监听器校验：其他 HTTP 服务器必须使用与目标域名不相交的普通 host 匹配；公共 catch-all、通配或复杂路由保守拒绝，真实适配测试确认拒绝发生在重载前。
- 拒绝选中服务器的非空 error routes，防止认证失败后进入另一个代理；单元和真实适配回归先复现失败，再验证拒绝与回滚。
- 本次交付既有功能分支，不合并 main，不发布 npm，不安装到共享 Pi 卷，不修改现有密码、容器或隧道。远端提交状态以交付时 Git 验证为准。

详见 [使用指南](remote-access.md)、[验证报告](validation/remote-access-onboarding.md)。

## 12 · 连接分支集成与审查修复

- 在独立 worktree 将 main 的预构建安装改造集成到连接分支；保留 main 的 Node-only prepare、`ws` 单运行依赖和 tracked dist，不把旧安装编译流程带回主线。
- `package.json` 合并安装校验文件、许可证／图片和远程操作指南；开发日志保留两侧记录并统一编号。
- 登记能力不可用或未启用时，带代理路由标识的 HTTP／WS 请求失败关闭；无路由标识的本地访问仍可用。能力文件严格拒绝非字符串字段。
- 网关原子替换在非 root 路径保留并复核 UID/GID/mode，失败拒绝；前端 reducer 保护用户端口编辑，自动端口变化使材料失效，不应用旧计划的结果。
- 构建清单纳入连接模块和位于 extension 目录的浏览器 plan／gateway 输入；真实生产安装负例扩大到外部浏览器输入，避免源码改变而产物校验仍通过。
- 默认 E2E harness 统一消费 `PI_E2E_RUNTIME_DIR`，新增向导／子路径场景也可验证生产安装副本，而非意外回退开发源码。
- CI 补连接模块类型检查、真实 Pi 后端集成及 Python 事务测试；真实 Caddy 检查仍按文档显式提供 binary，在没有 binary 的环境不冒充已执行。
- 最终验证：109 单测、8 项生产安装真实 Pi 后端集成、42 浏览器 E2E 通过；Python 19 项中 18 执行通过、1 因不同组权限缺失跳过。普通 install/update/tarball 和三种真实 prepare 负例通过；正常 pack 重建与已验证安装产物一致。
- 独立复审指出的测试运行时选择／页面对象问题已修；完整 E2E 的 Markdown 弹窗历史同步竞态改为等待真实 settled snapshot，保留失败证据、不跳过断言。
- 验证完成后维护者授权提交候选、合入 main 并发布 GitHub；实际提交／远端状态以 Git 历史为准。不更新共享 Pi 包，不修改 WSL／公网隧道。详见 [集成验证](validation/portable-merge-validation.md)。

## 13 · 包内独立多会话总管（2026-10-14，本地实现）

- 同一扩展包新增 `pi-web-hub` CLI 与独立总管：初始化、按会话签发／撤销凭据、登记续租、会话列表、HTTP／WebSocket 路由和中文响应式入口。普通单 Pi 仍无需启动总管。
- 原生登记协议与现有扩展复用，不依赖个人 WSL 路径、宿主服务或源码注入。总管不负责启动 Pi、容器或 SSH，不需要 Docker socket。
- 私有 config/state 与可共享 runtime 分离；每个并发 Pi 使用单独 capability，端口归属通过签名后端证明核验。在线租约仅在内存，失效链接归属持久化，重启后由 Pi 换 generation 重新登记。
- 默认 loopback，限制 Host／Origin，过滤转发敏感头；注销、过期、撤销和重启使旧链接失效。TLS、网页登录及跨同 UID 的隔离仍需外部可信部署，不能把总管当作 Agent 沙箱。
- 聚焦复审先复现并修复四处生命周期问题：拒绝 WS 升级的半关闭连接阻碍退出、陈旧 socket 并发启动竞争、证明等待跨租约后错误续期、未登记 generation 的注销未封禁。修复后 11 项定向测试通过，复审未发现这些修改的残留重要问题。
- 最终本地验证：78 项 Node 单元／真实 Pi 集成、44 项完整浏览器 E2E；TypeScript、Biome、构建、diff 和 npm 打包清单通过。生产依赖审计为 0；Python 网关 10 项通过、3 项可选真实 Caddy 检查跳过。
- 已核验桌面 1440×900 与手机尺寸 390×844 的入口截图。本次未部署 Docker 示例、未验证实体手机／阿里云；未修改真实 pirun、WSL 服务、共享 Pi 卷或服务器密码。
- 本地实现阶段曾保留未提交修改；随后用户授权提交并推送 `codex/portable-web-connection`，整合验证见下方记录。实际迁移仍需另行确认，不能仅 `/reload` 就宣称已替换现有会话路由。

详见 [总管操作指南](hub.md)、[ADR 0013](adr/0013-package-owned-session-hub.md) 与 [验证报告](validation/2026-10-14-package-session-hub.md)。

### 用户授权的分支交付与安装修复

- 保留旧 WSL 服务和实际部署，整合远程 `847079e` 的预构建资源、生产依赖安装与失败关闭路由修复。
- 真实 npm 安装暴露 Node 无法加载 node_modules 内 TypeScript 的 CLI 问题；先复现再将总管预构建为 JavaScript，package bin 和 Docker 示例均使用构建产物。
- 新鲜回归：132 项 Node 单元／真实 Pi 集成、45 项源码浏览器、9 项生产安装后端及 45 项生产安装浏览器通过；普通 install/update/tarball 以及六类过期源码拒绝通过。细节、失败尝试和实际部署边界见总管验证报告。
- 此次只交付 `codex/portable-web-connection` 分支，不合并 main、不发布 npm、不更新共享 Pi 包，不自动启动总管或改变 pirun 挂载。

## 后续工作与已知限制

- 上述 10 个未映射内置命令按需接入，认证/分享/信任/退出不能当普通聊天指令透传。
- 动态高度聊天虚拟化、streaming delta 合并、normalized store、worker 高亮需独立滚动/生命周期验证。
- 明确 HTTP/WS 认证、Origin 和反向代理部署边界；现有 `/webui` 不能代替认证。
- 持续补充 provider、clipboard、多浏览器、跨会话竞争、深色主题及第三方组件文案边界。
- 本地 release 快照位于 `$HOME/.pi/agent/local/pi-web-ui/releases/`，不是工作区引用。应用新代码仍由用户执行 `/reload` → `/webui` 后刷新网页。
