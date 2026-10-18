# Hub 独立部署版本信息修复

## 根因与范围

实际 Hub 的 `/api/sessions` 曾返回 `status: ok`、Web 公开版 `1.0.0`，但没有 `versions.hub`。原实现从 bundle 所在目录向上查找包信息；独立 bundle 无 `package.json` 时可复现缺失，完整仓库运行不能覆盖该部署形态。不能据此声称已读取生产镜像内部文件。

GitHub REST ref 在诊断环境返回 403 限流；raw 文件和 Atom 源正常。各在线 Pi 的已加载版本独立于 Hub 更新，不修改其上报、不自动 reload。

## 修改

- Vite 构建时内嵌 `package.json` 版本和固定源码 inventory 的 SHA-256。复用最终 manifest 的源码策略，不依赖旧 manifest 或输出自身，无循环 hash。bundle 优先使用内嵌身份；直接运行源码仍读取磁盘。
- 固定 REST ref 失败后查询固定仓库 Atom 源，只从首个直接 entry 的完整 id 提取严格 40 位 SHA，再取同一不可变提交的 package/manifest。提取器不是通用 XML 验证器，不执行实体或读取内容里的 URL。
- 保留 HTTPS 固定来源、拒绝重定向、256 KiB 上限、取消、单飞及五分钟冷却；三阶段单请求各最多两秒，留在八秒总体截止内。失败仍如实 unknown/partial，不将本机版本当作公开最新版。
- `/api/sessions` schema 未再次扩展；包版本保留 `1.0.0`，构建指纹改变。不涉及管理权限、Gate 审批、Pi 派发或会话结构。

## 验证

- 新增 detached CLI 回归在旧 bundle 上失败（Hub metadata 为 undefined）；修复后通过。fixture 只提供 Node 与外部 `ws`，不带包信息；相邻伪造 `9.9.9` 包和断网也不能覆盖或擦除内嵌身份。
- manifest 回归证明无 dist 时即可计算源码指纹，最终 manifest 同源，改版本会改变指纹。
- 限流降级覆盖实际 GitHub feed 形状（含 `media:thumbnail`）、非法首 entry/SHA/重复或嵌套 ID/实体及危险声明、超大响应、超时、Atom/raw 两阶段取消；两个 raw 文件固定同一提交。
- 最终单测 488 项：487 pass / 1 optional skip / 0 fail。构建、manifest、连接类型检查通过；Biome 243 文件 0 error，保留已有 30 warnings / 1 info。
- 专项版本/CLI 测试 26/26；Python gateway 15 pass / 1 optional skip。
- Pi 1.3.0 真实 RPC+WS portable/Hub/revision 集成曾两轮 11/11 通过。最后并行压力运行中 portable 的 missing-capability 一次得到 200 而非 409（同一用例早先通过）；隔离重跑 portable 8/8 通过。fixture 先申请再释放随机端口、启动就绪仅以根路径 200 判断，存在端口复用竞争可能，但尚未证明该次失败根因；不隐去该失败，也不通过放宽认证断言修复。最终以 `--test-concurrency=1` 串行运行全部三组集成 11/11 通过，见 `/tmp/hub-versions-integration-serial.log`。
- 真实 Pi 隔离 Git install/update、tarball、安装后 Hub 生命周期和 11 类 stale-source 拒绝通过。未更新个人安装目录或 reload 用户 Pi。
- 真实公开源检查观察到 REST 403 → Atom 200 → 同 commit 两个 raw 200，得到 Pi 1.3.0 / Web 1.0.0。此证据仅代表诊断环境，不保证生产出网始终可用。

## 限制与部署

本轮不修改前端 HTML/CSS/渲染逻辑，未重做截图或完整浏览器 E2E。只读审查未发现确定的发布阻断问题，按审查建议补上 raw 阶段取消统一拒绝。推送与 Gate 申请/完成状态须分别核对；部署后用本机 API 只读核对 Hub 自身版本、指纹和公开参考数据，不输出会话正文、名称或凭据。
