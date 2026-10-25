# 干净 Pi Web v1 拆分边界

日期：2026-10-26。状态：拆分准备完成，待书面设计审阅；尚未清理产品源码。

## 来源与保留点

本分支名为字面 `v1`，基于 `27326a8cbea8331cac29e6b6b41f98f2b69fa05b` 建立。原 `codex/hub-create-pi` 分支保留完整的 Hub/Gate/创建 Pi 成果，原 main 未修改。本分支名不是 npm 发布版本，也不是已经完成干净包的证明。

## 目标

Pi Web 只做 Pi 进程内的会话交互扩展，可独立使用，不依赖管理器或 WSL。保留聊天、流式显示、模型与思考等级、树和恢复会话、编辑/重新生成、公式、图片、文件上传下载及会话内的扩展交互与授权面板。

Hub/Gate 合并为独立产品 Pi Manager，管理器先启动，再创建 Pi，最后由 Pi 加载 Web 扩展。MCP 作为管理器调用接口，不决定管理器生命周期，也不使 Pi 自动获得审批权。

## 迁移清单

| 部分 | 处理 |
| --- | --- |
| `src/web/`、单会话扩展及交互适配 | 保留，防止单会话交互回归 |
| Pi 侧登记/状态协议 | 保留薄的可选适配；管理器离线不影响单会话使用 |
| `hub/`、`bin/pi-web-hub.mjs`、Hub 构建配置 | 源码迁移至独立 Manager，随后从 Web 产品分发移出 |
| `integrations/runtime-updater/gate/` 与 `pi-runtime/` | 迁入管理项目；明确 Pi 侧薄控制契约，不盲删 |
| `package.json`、lock、分发清单与安装测试 | 同步移除 Hub 入口/产物依赖，保留 Web 完整性检查 |
| TypeScript 检查、测试与文档 | 按所有权拆分；不跨兄弟项目引用源码 |

新项目文档目录为 `/home/fate/gitproject/codex_project_v2/pi-manager`。完整设计在新项目的 `docs/superpowers/specs/2026-10-26-pi-manager-separation-design.md`，来源记录在 `docs/source-provenance.md`；两个产品独立构建和发布。

## 验收与部署边界

源码拆分完成后，须重新验证 Web 安装/更新、构建清单以及模型/树/恢复/编辑重答/公式/文件和扩展交互，不复用旧项目结果宣称通过。管理器须独立验证零 Pi 启动、原生和 Docker 后端、MCP 任务与人类审批隔离、更新/回退和持久状态。

本轮不停止现有服务、不修改线上配置或密码、不删除历史实现、不推送、不合并 main。源码迁移在完整设计书面审阅后进行。
