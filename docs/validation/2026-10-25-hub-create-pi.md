# Hub 新建受管 Pi：开发与验证记录

分支：`codex/hub-create-pi`。这是本地开发交付，不代表当前公网 Hub 已启用。
本任务没有推送、合并、部署、修改真实凭据或重启已有 Hub/Gate/Pi 服务。

## 交付范围

- 可信管理页增加“新建 Pi”：默认 `pi_projects`，选择允许根目录下的已有目录、
  名称、确认、任务状态及实际登记后的会话链接；聊天页仅链接到管理入口。
- 本部署允许根为 `$HOME/gitproject`，无创建/删除文件夹功能。Gate 私有策略
  固定镜像、卷、权限与单独登记凭据，HTTP 无任意命令、环境或挂载覆盖能力。
- 精确请求 ID 先持久化，未知结果只查询，不自动重放或换 ID。只有明确“再新建”
  才允许同目录第二个独立 Pi。锁定清掉私有目录/名称，保留非私密恢复编号。
- UID/GID1000、cap-dropALL、no-new-privileges；独立后台 TTY 进程，不新增终端页。
  网页/Hub/Gate 的连接寿命不等于 Pi 寿命；不承诺主机重启后的自动重启。
- 16live/unresolved、256retained、200directories/page、4096scan 上限。扫描达到
  保守上限时409拒绝；不返回无法继续的分页，不自动清除任务历史。

## 验证证据及边界

新 HTTP 测试先观察404失败；补充响应格式和分页测试先观察200!=503失败，再修正。
Portal 先对空实现得到行为断言失败，再验证草稿、确认、存储拒绝、断线查询、
重复点击、显式再新建和安全链接。独立审查要求补充锁定脱敏与持久恢复编号。

- 最初完整 Node 运行：805项，803pass、2skip、0fail。此运行早于最后存储和后端
  审查修正，不冒充最终代码验证；最终结果在下方追加。
- Gate 初版：31项 focused；完整502项，494pass、8skip。最终修正结果另记。
- 真实临时 Hub→Gate HTTP/SQLite 启动、目录和去重测试通过；Docker 边界是替身，
  不称作真实 Pi/Docker 端到端。
- Chromium 合成页面：桌面1440×1000、手机390×844，临时 Hub、合成 Gate 和真实
  登记适配器；确认提示内容、等待登记、可信链接、锁定与无水平溢出。实际打开
  `.tmp/hub-launches-visual/` 下 picker/registered 截图检查：文字、按钮和路径可读。
  这是渲染验证，不是模型或真实容器端到端。
- 两套类型检查、生产构建、dist 哈希一致性通过初版检查。最终修正后重新验证。
  `just check` 仍有未改动 `e2e/web-interactions.browser.ts` 的两项原有导入/格式错误；
  旧的非空断言/模块类型等警告仍存在，没有无关改写或全局抑制。

## 真实 Docker 实测与清理

采用已有固定测试镜像、全新随机前缀卷、临时合成项目和 faux provider，无真实
API key/SSH/会话数据，不发出模型请求。测试镜像包含 image-owned Pi/扩展。

首次全新卷复制超时；Docker 稍后完成了确定名称的 helper 创建。经只读核对身份，
已精确删除该 helper 及其六个测试卷。后续初始化仅复制运行时，避免重复复制 home。
后两次捕获到 `start_intent` 拒绝：真实 Docker 的 Labels/RestartPolicy 规范化与
创建请求不同。证据位于 `.tmp/launch-acceptance/<namespace>/evidence.json`。
这些失败不算启动成功；两次均精确清理测试资源，`cleanup:true`。
后端针对真实格式和 Gate 私有数据源排除问题补充回归；最终真实启动结果另记。

## 运维与限制

安装扩展本身不会配置 Gate 启动权限。管理员还需按
[私有启动配置指南](../../integrations/runtime-updater/README.md#restricted-hub-pi-launches)
设置策略、只读浏览根、单独凭据目录、Hub 导出目录及固定镜像/容器身份。
原有截图服务、宿主 SSH、`.bashrc` 不隐式继承；模型源可用固定 readonly bind。
共享 home/config/runtime 保留原有共享状态影响，不是恶意 Agent 的完整隔离。
目录描述符校验不能消除 Docker 后续解析 bind 路径的并发竞态；信任宿主/daemon。

未知副作用需可信管理员按原任务核对；不提供通用任意恢复/删除入口。
更换 Hub/Gate 镜像或容器需同步固定身份；不能假装单纯扩展更新已完成上线。

## 最终验证

- Gate 修正提交 `59d11a8`：按固定镜像捕获继承标签，并严格检查 Docker 的零重试
  规范化字段；新增显式 `gate_provenance`，解析并排除 Gate 私有状态和策略的
  daemon 可见 backing mounts。42项启动测试加32项既有管理测试，共74项通过，
  无skip/失败；不是修正后的完整 Gate suite 结果。
- Portal 修正提交 `b353367`、`a3bbb23`：锁定时移除私有请求，保留单独的 durable
  原编号回执；模拟脱敏写入失败、删除成功、重载的路径也不会放开重复启动。
  9项针对性测试通过，独立复审关闭 I1/R1。原有模块类型警告仍在。
- 最后源码的生产构建及 dist 一致性检查通过。最终 Docker 实测授权请求和一次
  重试都在执行前超时，**没有执行最终复测，没有新建这两次请求的资源**。同样，
  一次最终视觉复测和一次最终 HTTP 联调复测请求也因自动授权超时未执行；之前
  的通过证据保留，但不冒充最终代码端到端成功。
- 后端独立复审关闭 I1/I2，前端独立复审关闭 I1/R1；没有把实现者自查当作独立
  审查。最终两套类型检查、10文件 scoped Biome、dist 校验、whitespace 检查通过；
  全量 `just check` 仍仅有上述两项既有错误，36warnings、7infos，未声称全绿。
- 因此尚未满足“真实 Pi 后台登记验收完成”的交付条件，不能称为已可部署版本。
  下一步需要允许独立临时服务/浏览器/Docker 测试继续执行；范围仍仅新建测试
  资源，无真实卷或凭据、无生产重启。未推送、合并或上线。

## 用户允许继续后的复测（2026-10-25）

用户已明确同意临时服务、浏览器和独立 Docker 验收；并非缺少用户授权。
两次只读固定测试镜像检查（首次及一次重试）仍在自动权限审核阶段超时，
均未执行 Docker 命令；一次 Chromium 合成页面复测请求也在执行前超时。
这些请求没有创建容器、卷或临时服务，不能算测试通过，也不是运行时断言失败。
没有更换途径绕过权限审核，没有修改真实服务或读取真实数据卷。

本轮生产构建、dist 一致性、连接层类型检查及3项离线 bootstrap 隔离检查通过。
真实 Pi 登记验收仍保留为独立未完成项。

### 最终修正与新鲜回归

本地提交 `501a898` 修正最终审查的两项问题：

- F1：Gate 对没有变化的观察不再重写 `updated_at`。重复的容器编号和运行状态
  查询都保持生命周期时间，等待超过60秒后能出现登记排查提示；真实登记链接
  优先于等待提示。后台测试覆盖70秒反复观察、实际状态变化与重开数据库。
- F2：真实 Docker 验收脚本在创建前持久保存每个确切目标；创建响应丢失时
  有界查询，不重放。核对命名空间、镜像、标签等归属后，仅以完整容器 ID 删除；
  无法证明归属、仍未确定或清理失败的目标留在证据中。各清理步骤独立执行，
  保留原始失败，最终写出清理错误和残留清单，不误报 `cleanup:true`。

主控在该提交后独立复跑：16项不启动通信服务的 Gate 启动测试、10项页面逻辑、
10项清理故障注入均通过；加上本轮3项 bootstrap，共39项离线针对性检查通过。
这不代表完整 Gate/Node suite 或真实 Docker/Pi 验收通过。

可复现的针对性命令（仓库根目录）：

```sh
node --import ./tests/register-ts.mjs --experimental-test-isolation=none \
  --test tests/hub-launch-portal.test.ts
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=integrations/runtime-updater/gate:integrations/runtime-updater/tests \
python3 -m unittest discover \
  -s integrations/runtime-updater/tests -p 'test_real_launch_acceptance.py' -v
```

最终两套类型检查、测试文件 scoped Biome、dist 一致性和 whitespace 检查通过。
`just check` 仍失败于原有两项 `e2e/web-interactions.browser.ts` 导入/格式错误，
共36warnings、7infos；本次测试文件格式问题已消除，不做无关全局改写。

### 受限环境中的完整套件结果

完整 Gate 命令为在 `integrations/runtime-updater/gate` 执行
`PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:tests python3 -m unittest discover -s tests`。
结果514项、134errors、8skip，不能称为全绿：其中133次是创建临时 socket 时
`PermissionError: [Errno 1] Operation not permitted`；另一次是既有 lifecycle
fixture 在创建 socket 失败后继续引用尚未赋值的 `engine`，抛出
`UnboundLocalError`。没有修改此无关 fixture 来隐藏环境限制。

完整 Node 默认隔离模式运行已观察到多个需要临时服务的文件失败，随后以
Ctrl-C结束（exit130），没有完整汇总，不能沿用旧803pass作为最终代码成绩。
单独运行 `tests/hub-launch-live.test.ts` 已定位到 Gate fixture 的 Unix Docker
替身在 `bind()` 处被同一权限限制拒绝，尚未进入实际 Hub→Gate业务验证。
这些失败与自动权限审核超时是两种不同阻碍，都不算最终验收通过。
本轮构建、全量失败及针对性回归原始日志保留于
`.tmp/launch-validation/20261025/`（本地忽略的测试产物，不随包发布）。

### 当前交付边界

最终唯一一次定向复审已关闭 F1/F2，修正差异未发现新的重要问题；这是源码
修正结论，不是实际容器验收、完整套件通过或部署许可。前两项任务的既有
独立复审结果保持有效，没有重开无关源码审查。

源码修正和离线针对性检查已保存到本地 `codex/hub-create-pi`，未推送/合并/上线。
实际临时 Pi 后台登记、所属资源清理与最终桌面/手机截图复测仍待可运行的
隔离验收环境；不能把已写好的测试脚本、过往截图或审查通过当成这些实测。
