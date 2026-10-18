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

## 14 · 总管分支二次集成审查

- 拉取 `22ba8c7`；候选已包含 `847079e`，main 可快进，无机械冲突。保留独立可选 hub、生产 `ws` 单依赖和预构建安装策略，不替换实际 WSL 服务或共享 Pi 设置。
- 修复分发清单未强制包含预构建 hub，以及继承属性名未知命令可能误启动总管；分别补缺失输出和 CLI 失败回归。
- 总管 browser/backend fixture 改为执行选定 runtime 的构建 CLI，不再直接导入源码 server；Git update／tarball 内实际 init/issue/serve/HTTP/revoke/SIGTERM 通过，无源码回退。
- 本轮 132 单测、9 生产安装后端、45 完整生产安装浏览器通过；Python/Caddy 19 项中 18 执行通过、1 权限条件不足跳过。正常 pack 重建与已测 runtime manifest 一致；Browser MCP 实看桌面／手机总入口截图。
- 独立服务端审查无确认问题；CLI／分发审查发现修后复核无剩余必须修项。仅本地集成验证，不预先宣称远程发布；最终分支状态以 Git 为准。
- 详见 [本轮验证](validation/hub-merge-validation.md)。没有自动更新运行中 Pi、启动生产总管或改公网隧道。

## 15 · 按日期加载有界历史（2026-10-15）

- 默认最近三个自然日；主聊天区和 `/resume` 均可选择起止日期，浏览器传递本地日历边界，服务端先筛选再传输。Hub 入口仍表示在线 Pi 进程，不冒充历史档案库。
- 历史每页最多 100 条／512 KiB，翻页替换当前页；树仅传最多 1,000 个轻量节点并声明不完整。单条超大记录显式预览，保留工具身份、路径摘要和结果关联，不修改原始会话文件或模型上下文。
- 初始同步、重连、背景同步和历史查询入口全部有界，保留日期／游标以及 session/runtime 防护；最终传输有 4 MiB 保护，不提高 Hub 的 16 MiB 限制。
- 独立审查补修工具跨页结果丢失、实时日期恢复后的增量显示，以及预览丢工具身份；另补取消日期弹窗后旧请求重新打开的问题。孤立 read 结果仍可展开，完成消息恢复完整正文。
- 最终验证：165 项单测、10 项真实 Pi 后端连接、47 项真实浏览器通过；构建、类型、格式和 source/dist 对应通过。生产依赖 Git 安装／更新／tarball 及安装后 Hub 生命周期通过。
- 临时 20 MiB 单条历史夹具的最大接收帧为 67,646 字节，源 JSONL 哈希未变。桌面 1440×1000 与手机尺寸 390×844 的日期与会话选择截图已查看；不等于实际手机或线上部署测试。
- 按用户要求交付 main 源码和预构建资源；不自动更新已安装扩展、不重启运行容器／Hub／隧道。独立的 resume generation 链接交接问题仍不在本次修复范围。

详见 [ADR 0014](adr/0014-date-bounded-browser-history.md) 与 [验证记录](validation/2026-10-15-date-bounded-history.md)。

## 16 · 恢复会话后的 Hub 链接自动交接（2026-10-15，本地修复）

- 小会话复现确认：`/resume` 已成功切换 Pi，但旧 generation 失效后，浏览器仍在重连旧链接。该问题与上一轮大历史／日期窗口修复独立。
- Hub 向已连接网页签发仅内存的短时交接凭证，同源查询只允许原凭据／run ID 的第一个已验证新登记。旧链接仍返回 410，撤销、超时、Hub 重启或绑定目标再次失效时拒绝交接，不自动选择其他 Pi。
- 网页保留已挂载状态和会话操作等待器，自动替换地址再连接；不重发 `/resume`、新建或其他用户操作。握手失败保留原凭证直到收到新的 Hub 控制帧，所有重试共享 15 秒期限。
- 独立审查复现并补修三项边界：证明等待期间 successor 到达、替换连接握手失败时丢失凭证、后端同名控制事件覆盖凭证。三项均先确认失败，再通过真实 HTTP／WebSocket 回归。
- 同一审查者复核确认三项 P2 已解决，相关生命周期与安全边界未发现新的可操作问题；复核了取消交接、可见性重连、共享期限、禁止重放及第一个 successor 限定。
- 最终本地验证：172 项单测（含 15 项 Hub／传输）、10 项真实 Pi 后端、49 项真实浏览器通过；构建、格式、两套类型及 source/dist 对应通过。隔离生产 Git 安装／更新／tarball 和安装后 Hub 生命周期通过。
- 全套回归暴露的既有离屏预览断言已修正：先把 `content-visibility:auto` 参数块滚入可视区，不降低预览大小和源文件完整性断言。桌面 1440×900、手机尺寸 390×844 的最终恢复页面截图已实看。
- 本地验证阶段仅修改源码、文档和预构建资源，未改真实 Pi、Hub、隧道、Caddy 或共享卷。随后用户授权提交并推送本次修复至 main，实际远端状态以 Git 核对为准。上线需同时更新 Hub 和 Pi 网页资源；管理员安排 Hub 重启，保留 state/grants，首次从总管重新打开。无需改变现有转发目标。

详见 [交接修复验证](validation/2026-10-15-resume-hub-handoff.md)、[ADR 0013](adr/0013-package-owned-session-hub.md) 和 [总管指南](hub.md)。

## 17 · 点击聊天中的项目文件并确认下载（2026-10-15，本地实现）

- 按用户给出的中文简历例子，将普通／加粗路径、行内代码路径及本地 Markdown 链接变成下载入口；先确认，取消不申请文件，确认才下载，保留原始中文文件名和字节。
- WebSocket 只准备短时、有界、会话隔离的下载 capability；HTTP 传输附件，不把文件内容放进聊天帧。仅允许当前工作区普通文件，拒绝越界、隐藏／常见凭据路径、软硬链接和目录，下载时重新检查文件身份。
- 浏览器实测修复最终历史同步替换消息行导致弹窗消失的问题；确认状态移出消息行，仍在会话／runtime 更换时失效。保留外链确认、复制链接和中英文文案。
- 本地验证：185 单测、2 项真实 Pi 直连／Hub 下载集成通过；完整浏览器曾 53/53 通过，最终重复为 52/53，移动端 Hub resume 交接偶发失效，关联尚未确定，不宣称已修复。新增四组下载均通过；构建、两套类型、Biome、source/dist 对应与 diff 检查通过。已实际查看桌面 1440×900 和手机尺寸 390×844 的确认弹窗截图。
- 独立代码审查未发现可操作的安全／正确性问题。未提交推送、未更新共享扩展或重启线上 Pi／Hub／隧道；该功能本身不需要调整 Caddy 或端口，不代表独立的大消息实时事件问题已解决。
- 用户随后授权提交推送并刷新部署。发布前重新运行完整浏览器套件为 **53/53 通过**（2.2 分钟），包含两组 Hub resume 和四组下载；保留此前偶发失败记录，不将一次通过解释为已定位并修复该竞态。实际提交和部署结果以 Git 及上线检查为准。

详见 [下载行为与边界](prd/file-downloads.md) 和 [验证记录](validation/2026-10-15-file-downloads.md)。

## 18 · 通用附件保存到会话工作区（本地实现，未发布）

- 网页文件／图片保留原始 `File`，最多五附件、每文件 50 MiB；选择时不写盘，发送时同源 HTTP 串行上传，进度与取消可见。成功后只把短期收据交给扩展，服务端为 Pi 追加 `.pi-uploads/<session>/<upload>/<原文件名>` 路径，不再把新图片自动 Base64 内联到模型。
- 专用模块负责已知长度流式写入、独占／无覆盖发布、权限、路径和 symlink 验证、会话隔离、TTL／并发／数量限制；仅清理未完成文件，成功附件由用户管理。Hub 沿用已有代理，无新云存储、端口或 SSH 操作。
- 独立审查补修 Pi fire-and-forget 提示提前消费收据，以及前端旧请求覆盖新会话、handoff 可修改附件、跨 scope 提交锁三项问题；接收确认改为匹配真实 user `message_start`，未知状态禁止盲目重发。
- 增加真实精确 50 MiB 直连／Hub、中文与原 PNG、17 MiB 二进制、工具 `read`、超限／取消／重试、第二网页切换会话、compaction／凭据和 Pi 异步失败回归。最终 213 单测、离线解包 runtime 的 15 后端／60 完整浏览器通过；构建、类型、Biome、source/dist、pack 和七类 stale-input 负例通过。桌面／手机的最终选择／进度／取消截图直接查看，完成态补拍超时未计通过。各层结果、失败尝试与限制以 [验证报告](validation/workspace-uploads.md) 为准，不借旧轮次数字宣称通过。
- 完整浏览器曾因非 UTF-8 进程 locale 导致既有中文下载名退化，定向 A/B 确认为环境问题；CI 和测试说明设置 UTF-8 locale，不放宽中文名断言。
- 没有安装新依赖、提交／推送、更新已启用扩展或改真实 Hub／隧道／Caddy。离线 tarball 校验不冒充 npm 安装生命周期；dispatch 后第三方异步 hook 与 reload 交错仍有上游撤回能力限制。

详见 [ADR 0015](adr/0015-workspace-attachment-uploads.md) 和 [附件行为](prd/file-uploads.md)。

## 19 · 聊天日期筛选可收缩（本地优化，未发布）

- 顶部日期区默认收起，仅保留已应用日期范围摘要及展开入口，避免长期占据手机聊天空间。保留日期表单挂载，折叠不会清除未应用编辑、改变筛选或产生历史请求；错误／加载／历史视图提示和分页仍可见。
- 真实 Pi 日期桌面／手机回归 2/2、完整浏览器 60/60、213 单测通过；前端类型、构建、Biome、source/dist 对应通过。独立限定源码审查无确认问题。
- Browser 实看桌面 1440×900 和手机尺寸 390×844 展开／收起四张截图；含分页手机日期区约 257→89 px，无横向溢出。临时服务已停止，不等于实体手机或线上验证。
- 保留上一轮未提交附件改动；未安装依赖、未提交推送或部署。详见 [日期收缩验证](validation/date-filter-collapse.md)。

## 20 · 大文件分片续传（本地实现，未发布）

- 上传入口由图片图标改为回形针＋“上传文件”，桌面和手机均显示文字。默认单文件上限 1 GiB，8 MiB 分片，最多五文件；可配置服务端大小和未完成文件总预留，硬上限与实际默认限制分开。
- 浏览器逐块计算完整文件和分片 SHA-256，区分校验／上传／完成校验进度；失败或取消保留已确认分片，刷新后重新选原文件可在当前运行期和会话续传。最终完整哈希／大小核验后才无覆盖发布并交给 Pi。
- 继续保留 scope／receipt／真实 Pi 接收确认边界；停止、重载或会话切换清理未完成文件，不承诺跨进程 crash recovery，成功文件由用户管理。旧客户端单 PUT 保持 50 MiB 兼容上限。
- 最终默认单测 232 项（231 通过、1 可选 GiB 跳过）、离线解包 runtime 的真实 Pi 后端 15/15、完整浏览器 61/61（上传 8/8）通过；直连与 Hub 实际传输 65 MiB。另有精确 1 GiB store 实写／全 hash 和共享增量 SHA-256 的 Node 运行时 1 GiB 对照证据，不冒充浏览器／公网 GiB 验证。
- 独立后端快照审查发现 HTTP 底层错误可能泄露宿主路径，已改固定安全提示并补真实 HTTP 回归；客户端快照审查无确认必须修项。构建、177 文件 Biome、补充严格类型、manifest、离线 pack 和八类 stale-input 校验通过；不等于真正安装／更新生命周期。
- Browser 直接查看桌面 1440×900、手机尺寸 390×844 的选择、校验、上传、取消及提交后截图；未稳定捕获 finalizing 单独视觉态，临时服务已停。各层结果、失败尝试与限制集中在 [分片上传验证](validation/chunked-uploads.md)。本轮未安装依赖或提交、推送、更新启用包、重载当前会话、修改公网链路。

## 21 · 网页鲸鱼娘（本地完成，未发布）

- 在现有 Web 内实现160px桌面/112px手机悬浮角色、五状态本地图片、点击反馈/用量卡、拖动/方向键、76px收起入口、关闭/设置恢复与减少动态效果。不是Windows原生应用，不新增框架或生产依赖。
- 图片仅从设置导入浏览器IndexedDB，经签名/解码/大小/尺寸检查，object URL渲染；下载同人图不进入MIT软件包、不上传Pi或模型。
- 新只读 `get_usage_stats` 使用session/runtime身份，按会话所有条目和实际响应模型汇总；分列缓存/输入/输出、已知费用和未定价请求，不套当前模型费率。费用是USD Pi估算，不是账单。
- 独立前端快照审查发现并修复 reduced-motion优先级、部分临时素材警告被成功槽掩盖、恢复/导入竞争三项P2，补浏览器回归并经限定复核。后端快照审查无确认必须修项。
- 最终253单测（252通过、1可选GiB跳过）、16/16真实Pi后端、64/64完整Chromium、191文件Biome、严格补充类型0诊断、Web/Hub构建、manifest和离线pack/十一输入篡改拒绝通过。保留一轮Hub偶发63/64和超时中断记录，不据重跑声称根因已确认。
- 独立Browser直接查看1440×900/390×844的真实下载立绘、用量卡、素材设置和收起截图，服务已停止。详见[鲸鱼娘验证](validation/whale-companion.md)。本轮未提交、推送、更新启用包、reload生产或改公网链路。

## 22 · 鲸鱼娘移动与输入框右上方默认位置（本地完成，未发布）

- 无手动位置时锚定输入框右上方，留8px间距；输入框增高和视口变化时跟随。直接拖角色或把手可移动，超过5px不误触用量卡；记住手动位置，设置支持恢复默认。
- 修复审查发现的缩放CSS尺寸不一致和拖动中scope变化丢失收尾两项P2；限定快照复核确认修复。换行跟随测试改成真实换行并断言输入框高度增加。
- 254项单测（253通过、1可选GiB跳过）、4/4鲸鱼娘真实Pi Chromium、构建、191文件Biome、严格补充types和manifest通过。未重跑完整浏览器或实际安装更新；新增生命周期测试因遗漏replacement断连重连曾超时，修正观察端后通过，不重复发送命令。
- Browser最终1440×900/390×844直接查看默认位置和拖动截图，角色不遮输入框、手机无横向溢出，测试服务均已停止。证据与限制见[鲸鱼娘验证](validation/whale-companion.md)。无提交、推送、安装或生产reload；素材策略仍为浏览器本地导入。

## 23 · 鲸鱼娘软键盘式视口恢复（本地完成，未发布）

- 将手动偏好与临时限界显示坐标分离，视口/软键盘收缩不覆盖原位置，扩大后恢复；在小视口主动拖动或用方向键才重设偏好。拖动收尾不再误存临时坐标。
- 新回归在旧安装0ec4ac4明确失败（608→310未恢复），修复后鲸鱼娘真实Pi Chromium5/5；默认254项单测（253通过、1可选GiB跳过）、构建、Biome、补充types、manifest通过。限定只读快照审查无确认P2+，不是完整diff审计。详见[鲸鱼娘验证](validation/whale-companion.md)。
- 独立Browser查看390×844/390×430/恢复及1440×900截图，确认手动坐标608.4→310.4→608.4；缩小时仍可能盖输入框（既有仅视口限界策略），不把合成视口当实体软键盘实测。临时服务已停止。本轮无提交、推送、安装或生产reload。

## 24. 大型实时内容的传输限界与恢复

- 保留 Web 4 MiB／Hub 16 MiB 保护，delta 不再反复传累计 message／partial；agent/turn 结束事件不重复整段消息。超大已知实时内容显式通知当前 scope，终态复用有界历史同步，不删除原文、不将失败响应伪装成功。
- Git diff 聚合与文件 JSON 转义后约 3 MiB 预算，过大明确拒绝；审查另发现既有 untracked 读取失败吞错会导致不完整 success，改为固定失败错误，并在非 root POSIX 隔离仓库验证。
- 262 默认单测（261通过／1可选GiB跳过）、68完整 Chromium、最终9定向与离线包2场景、16真实Pi后端、构建／hash／补充types通过。独立Browser1440×900／390×844截图直接查看，临时服务已停。完整证据、验证时点与未测边界见[验证报告](validation/transport-limits.md)。
- 限定快照审查不等于全量diff审计；旧mirror adapter严格类型问题不在本轮修复范围；未知超大事件／fork或files响应仍fail closed。当前未提交、推送、安装或重载用户实例。

## 25. 鲸鱼娘本地 GIF 与静态首帧

- 本地槽允许 GIF87a/GIF89a，仍限制2 MiB／2048像素、校验magic／MIME／逻辑尺寸／实际解码。IndexedDB与普通src保留原Blob，不上传不调用模型，旧PNG/WebP兼容。
- 新增仅本页静态PNG首帧，设置缩略图始终静态；用户或系统减少动画时宠物切首帧，关闭后恢复原GIF。双URL资源释放、hydration／导入队列、temporary槽不变；解码截止及迟到bitmap清理防卡死。
- 265默认单测（264通过／1条件跳过）、前端构建／hash／补充types、68既有Chromium及新GIF专项1/1（分两轮）、离线pack六项鲸鱼6/6通过；GIF原帧差／IDB哈希／motion双向及其他证据见[GIF验证](validation/whale-gif.md)。独立Browser实导入本地idle.gif，在桌面／手机及系统reduce截图直接查看，临时服务已停。本轮未提交、推送、安装或reload。

## 26. Hub 卡片以会话名字替代随机 ID

- 保留项目／文件夹标签，第二行由generation前缀改为Pi会话名字，未命名fallback；搜索匹配名字和标签。登记每15秒读取最新名字，Hub每5秒刷新，改名不改变路由或since。
- 可选sessionName登记字段兼容旧客户端，规范控制字符／256长度上限；API显式投影、浏览器textContent安全显示。沿用latestCtx生命周期与原授权证明，不读聊天正文，不修改凭据。
- 专项26/26、默认267单测（266通过／1条件跳过）、最终Hub5＋鲸鱼6共11 Chromium、build／hash／补充types通过；只读限定审查无P2+，桌面／手机及长名HTML样式文本截图直接查看，自有临时服务停止。见[验证报告](validation/hub-session-names.md)。保留未发布GIF改动，本轮无提交、推送、安装或运行实例重启。

## 27. 修正旧 Hub 标签内嵌短 ID 的遗漏

- 实际旧label本身为 `pi_projects · ae32751f`，初版保留label导致ID仍显示；portal纯展示精确去除末尾中点分隔8hex，标题／tooltip／搜索一致。API label、授权、路由和会话名不变。
- 新portal运行单测含非匹配／空标签保护；268默认项（267通过／1条件跳过）、Hub真实Pi5/5、构建／hash／补充types通过。独立Browser桌面／手机使用真实同形旧label+真实/name截图直接查看，自有服务停止。详见[Hub名字报告](validation/hub-session-names.md)。本次本地未提交、push或部署，不借用前次已完成申请。

## 28. Hub 导航与改名体验

- 会话顶栏同源←Hub入口、草稿／附件离开确认、静态加载提示和点击反馈；返回pageshow刷新合并、未变化卡片保留焦点，首次Git刷新debounce合并。网页改名立即登记但只等250ms，15秒续期兜底，不声称慢链路已同步。
- 回归暴露并修复handoff proof窗口过早410、routePath轮询导致立即文本提交被旧上传scope拒绝。改显式本地route事件＋layout清理，scope checks保留；successor只首次绑定，撤销／期限proof后复查。
- 最终286单测（285通过／1可选skip）、69/69源码Chromium、离线runtime Hub5/5、8类stale-input、types0／build／manifest通过；独立Browser桌面／手机直接查看，临时服务停止。首次3/5失败与中断尝试保留，限定静态审查不替代动态结果。详见[验证报告](validation/hub-navigation.md)。本轮未提交／push／更新或申请生产部署。

## 29. 每轮编辑问题与重新生成

- 用户消息下增加可见「编辑并重新发送」，已保存 AI 回答下增加「重新生成回答」；确认框读取 Pi 完整原问题、保留原图，超过预算或不支持附件明确失败。以同会话分支保留旧问题／旧回答，Tree 末尾箭头切换，不回滚文件或改写历史正文。
- 两阶段单次 preview、session/runtime/leaf、busy 与 lifecycle fences；literal dispatch ACK 不冒充接受／完成，unknown 不自动重发。原生 void API 无 correlation metadata 的限制、恢复方式与第三方 hook／图片规范化边界明确记录。
- 审查发现并修复永久 leaf 去重、无关事件误解 unknown、导航期 compact 漏锁及反向 async model mutation 窗口；真实 Pi 测出 ready 与 snapshot 间的 stale leaf，改操作前同步已保存页，不放宽提交检查。最终316单测（315通过／1可选skip）、71/71源码Chromium、离线包真实Pi修订2/2、16后端回归、build／manifest／types0通过；独立Browser桌面手机截图直接查看并停止自有服务。队列scope和旧Branch异步草稿窗口也补保护。最终验证与未测范围见[报告](validation/message-revision.md)。本轮本地未提交／push／安装更新或部署。

## 30. Hub 请求门禁重启单个 Pi 进程（源码完成，尚未上线）

- 独立管理来源的一次性配对、生命周期专用凭据和默认禁用的精确镜像策略；普通 Pi/Hub 不获取 Docker 或管理员 socket。保留已有卷、UID1000及权限限制，不重建容器、不运行 npm 更新。
- Supervisor 只执行一次平滑子进程重启，恢复精确已保存会话及分支；固定预加载输入防护保守拒绝无法证明空闲的进程。不强杀、不重试、不重放提示；外部退出与新进程发布竞争已经补测修正。
- Gate 执行结果与 Hub 实时身份核对分开；首次成功需要完整证明，历史成功不因后续聊天或路由轮转变成失败，但原链接不可证明时不再给出。修正 Docker Mounts 顺序变化引起的错误漂移，保留真实字段变化拒绝。
- 最新392默认单测（391通过／1可选skip）、269已同步Gate测试、75已同步Pi测试（72通过／3条件skip）、6真实Pi输入防护、2容器恢复与连续3次真实浏览器全链路通过。类型、错误级Biome、打包及manifest通过；桌面1365／手机390截图直接查看，无溢出，合成历史提示与真实Pi E2E证据分开。组件审查和最终两项修正复审均通过。
- 27个审查过的宿主源码文件已备份后同步；相对路径补丁随功能分支保留。没有更新生产镜像、重启服务、签发生产凭据、启用策略、改阿里云或推送main。生产需要独立认证管理HTTPS入口、明确镜像上线和选定旧Pi容器的一次性迁移。完整证据与局限见[验证报告](validation/managed-restart-final-validation.md)，操作见[运行说明](managed-pi-restart.md)。

## 31. 消息下方版本翻页

- 问题和 AI 回答操作栏增加 `‹ 2 / 2 ›`，按原始用户 parent 分组，编辑与重答共用版本序号；翻页切整条已保存分支，问题、回答及后续对话同步切换，不生成模型请求、不回滚文件。原始 entries metadata 索引不依赖有界 Tree 预览，超预算整组省略提示。
- strict ACK、session/runtime/source leaf、busy/异步 mutation、草稿/附件/队列及导航 token 保护；独立审查发现并修复旧分支 cursor 复用于新分支导致空页，保留日期但读新分支最新一页，旧 page generation 失效。
- 原 `39176c9` 基线验证为337单测（336通过／1可选skip）、71/71完整源码Chromium、离线抽取包真实Pi2/2；仅代表旧树。合并到远端 `0e69509`（包含 Hub restart 改动）后，415单测（414通过／1可选skip）、233文件静态检查0 error、build／dist hash／connection types及真实 Pi Git install/update/tarball/Hub lifecycle fixture通过；因缺少匹配 Chromium 未运行完整 Playwright E2E。合成 faux Pi 的桌面／手机 Browser 交互与视觉检查通过。独立只读复核检查最终 cursor 恢复逻辑未发现确认问题。提交 `5dee430ee7eb03c920ac34c837de9164ed748464` 已推送 `publish/main`，Pi 管理的本机 Git 安装包已更新并复核 `prepare`；未重载当前 Pi、未部署或重启 Hub。见[验证报告](validation/message-versions.md)。

## 修订派发确认：SDK system patch 最小修复（本地验证，未发布）

- `matchesRevisionDispatch` 保留正文／图片严格比较，仅允许当前 leaf 经最多 64 个合法 `message/system` 节点到达原 parent；缺失、循环、节点身份错误、其他角色／metadata 与超预算均拒绝。派发保存既有树版本以及 lifecycle/session/runtime 身份，之后导航即使回到同 parent 也不确认；读取使用 `latestCtx`。八秒后真正 unknown 仍不解锁，不处理任意 input transform/handled 的伪成功。
- `e2e/message-revision.integration.ts` 新增无浏览器真实 RPC+WS 回归，专用 faux fixture 强制 structured system patch。编辑／重答均检查 system-before-user、原 entries 不变、精确文本与上下文隔离，并在超过原八秒截止后继续两轮聊天。加入现有 CI 后端 integration 命令；仅新建临时合成会话。
- 实际验证：`npm run test:unit` 共 419 项（418 通过，1 个可选 1 GiB 流测试 skip）；`node_modules/.bin/tsc --noEmit`、`node_modules/.bin/tsc --noEmit -p tsconfig.connection.json`、改动 TS 文件的 Biome check 与 `git diff --check` 通过；全仓 `npm run check` 检查 234 文件，无 error，报告 30 warnings／1 info（未扩大本轮修改范围）。`PI_E2E_BIN=<已存在的 CLI> node --import ./tests/register-ts.mjs --test e2e/message-revision.integration.ts` 在 1.1.0 和 1.3.0 各 2/2 通过，日志 `.tmp/revision-integration-{1.1.0,1.3.0}.log`。把 b715cff 的两个修订模块放入隔离 baseline 后，同一回归 0/2，在首个后续 prompt 明确报 pending/unknown，见 `.tmp/revision-integration-baseline.log`。
- pager 仅调查：`message-versions.ts` 直接按 user.parentId 分组，system patch 会让旧／新 user 的直接 parent 不同；六节点合成图调用 `resolveMessageVersions` 得到空 groups。此轮不改变分组或会话结构，后续需单独确定版本身份规则，不能认为派发修复同时修好 pager。
- 未运行浏览器 E2E／视觉检查（本轮无 Browser 工具且不重建 dist），未验证真实 provider、Hub 部署及完整远端 CI。按任务要求未重建 dist、安装、提交、推送、发布、修改安装包或 reload 真实 Pi；最终构建与产物核验交主线程。

## 后续工作与已知限制

- 上述 10 个未映射内置命令按需接入，认证/分享/信任/退出不能当普通聊天指令透传。
- 动态高度聊天虚拟化、streaming delta 合并、normalized store、worker 高亮需独立滚动/生命周期验证。
- 明确 HTTP/WS 认证、Origin 和反向代理部署边界；现有 `/webui` 不能代替认证。
- 持续补充 provider、clipboard、多浏览器、跨会话竞争、深色主题及第三方组件文案边界。
- 本地 release 快照位于 `$HOME/.pi/agent/local/pi-web-ui/releases/`，不是工作区引用。应用新代码仍由用户执行 `/reload` → `/webui` 后刷新网页。

### System patch 前后的 pager 稳定上下文位置修复（本地未发布）

- 承接上一节 pager 调查：`extensions/message-versions.ts` 在已有有效 ancestry 的迭代回溯中缓存稳定上下文 anchor，仅版本位置 key 透明跳过连续 `type:message` / `role:system`。原版和 revision 各自追加 prompt/tool patch 仍共享版本组；原 parent、真实 leaf 导航、source preference、safeTarget 与请求/响应预算不变。其他 metadata/custom/user/assistant/toolResult 节点不透明，不推断任意分支版本身份。
- 非法 ID/parent 类型、missing 和 cycle fail closed；无深度截断，不把长 system 链误当 root。新增单测覆盖 root/nonroot、多层独立 patch、非 system 边界与无关上下文、正文/时间 getter 禁读、反序输入与保存顺序、坏链、预算及 12,000 层共享 system 链的线性 parent 读取次数。
- 扩展已有真实 RPC+WS `e2e/message-revision.integration.ts`：edit/regenerate 后问题与回答共用 2/2，旧 ALPHA target 指向含 BETA 的真实 leaf，切旧 1/2 再新 2/2，context 精确恢复、无生成事件/新增 entries；恢复后超过原八秒派发截止继续两轮 prompt，faux provider 检查真实模型 transcript 无跨分支泄漏。
- 实际验证：`npm run test:unit` 424 项（423 通过，1 个可选大流测试 skip），`node_modules/.bin/tsc --noEmit`、`node_modules/.bin/tsc --noEmit -p tsconfig.connection.json` 通过；`npm run check` 检查 234 文件、无 error，保留 30 warnings / 1 info。`git diff --check` 通过。已有 SDK 1.1.0 默认 CLI 与 `PI_E2E_BIN=/home/node/.local/bin/pi`（1.3.0）各运行 `node --import ./tests/register-ts.mjs --test e2e/message-revision.integration.ts`，各 2/2 通过。日志 `.tmp/pager-{all-unit,check,integration-1.1.0,integration-1.3.0}.log`。
- 保留已有 revision-dispatch 与其他修改。上述为实现阶段的后端与真实 SDK 验证，不替代产品验收。

### 合并修复的最终发布前核验

- 主线程重建 dist 并验证 manifest；重新执行 424 单测（423 pass / 1 skip）、两套类型检查、Biome 0 error（30 warnings / 1 info）、当前 SDK 修订及翻页 integration 2/2、portable integration 8/8、Python gateway 15 pass / 1 skip、真实 Git install/update/tarball/Hub lifecycle fixture 及 11 类 stale-input 拒绝，均通过。
- 使用最终构建和隔离真实 Pi 1.3.0 的 faux provider，在 Browser 1440×900 / 390×844 检查 system patch 后 2/2、切旧 1/2 再切新、继续两轮聊天；截图直接查看。原生 CDP click 未生效，使用 DOM button.click，无 React/store 注入；不称完整自动化浏览器 E2E。临时服务和专用标签已停止，不影响用户会话。
- 用户授权推进 Git 推送与本机包更新；不含当前真实 Pi reload、新 Hub Gate 部署或容器重启。新扩展需目标 Pi 空闲后由用户 reload 生效，不声称已解除真实旧锁。完整结果和限制见[修订 system patch 验证](validation/revision-system-patch.md)。

#### 2026-10-18 · Pi Web UI 1.0.0 版本更新（待发布部署）

- 将 `package.json` 与 `package-lock.json` 的包版本提升至 `1.0.0`，重建并更新 `dist/build-manifest.json`，Hub 和 Pi 扩展的版本元数据因此报告 1.0.0。
- 验证：`npm run build:web`、`npm run verify:dist`、`npm run test:unit`（447 pass／1 optional skip）、连接 TypeScript 检查通过。尚未推送、申请 Gate 部署或更新任何 Pi 运行进程；此记录表示准备状态，不代表远程已发布。

## 2026-10-18 · Hub 版本总览与会话软件信息

- 入口新增只读「版本与更新」区域，显示 Hub 自有版本／构建、公开参考版本和检查时间；会话名下单列 Pi、Web 扩展包版本和 source fingerprint。旧客户端明确未上报，非受管 Pi 也有版本信息，不改变管理授权或重启资格。
- 扩展 factory 捕获一次不可变软件元数据，续租不重读磁盘，防止把共享卷安装更新误显示成已加载更新。Pi 版本独立于 Web 元数据，缺少包／manifest 时仍保留已知 Pi 版本。
- Hub 首次列表读取后异步查询固定 npm／GitHub 公开源；Web 文件来自同一个不可变 commit，独立请求限时、整体截止、单飞和至少五分钟成功／失败冷却；关闭取消后台查询，`PI_OFFLINE=1` 不联网。不读取会话正文、扫描任意扩展或发送凭据。
- 区分可更新、与公开版一致、构建不同、版本较新、未上报与检查不可用；相同包版本不同构建不伪装成确定升级。桌面 1440×1000、手机 390×844 合成浏览器截图已查看，长名字截断、版本行换行、无手机横向溢出；原有搜索可用。这是视觉检查，不是完整 Pi 浏览器 E2E。
- 最终 447 单测（446 pass／1 optional skip）、类型／构建／manifest通过，Biome 239 文件 0 errors（已有30 warnings／1 info）；真实 Pi 1.3.0 后端11/11、1.1.0后端9/9通过。审查发现的独立运行时 fixture 来源与单源超时 partial 丢失均修复并补验证。默认公开源实查仅取得Pi参考版本，Web来源不可用如实降级。
- 本轮仅开发及隔离验证，未提交／推送、安装扩展、刷新用户 Pi、部署 Hub 或重启容器。完整证据与限制见[Hub 版本展示验证](validation/hub-version-display.md)。

### 2026-10-18 · Pi 1.3.0 安全刷新兼容

- 将运行控制适配器从仅允许已审核的 Pi 1.1.0 扩展为允许 1.1.0／1.3.0，修复实际安装 1.3.0 后始终报告 busy 的兼容问题。未知 SDK 继续拒绝，不放宽终端输入、异步命令、prepare 或会话身份保护。
- 独立 Docker Pi 1.3.0 验证同容器内子进程刷新后精确保留 session／leaf／model／thinking、无提示重放、另一实例不受影响；6 项真实终端输入和异步命令保护验收通过。完整默认单测 425 项（424 pass／1 optional skip），类型检查、构建、dist 对应性和检查无 error，已有 warnings 保留。
- 本次只修改运行控制后端和测试，未改变网页布局。代码位于独立本地分支，尚未推送远程；不声称当前旧生产容器已采用新 supervisor 或已刷新 Pi。与全局更新门控的部署状态由宿主运维记录另行说明。[验证和边界](validation/runtime-control-1.3.md)。
