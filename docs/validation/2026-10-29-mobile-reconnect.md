# 手机切换页面后的连接恢复

## 变更

- `visibilitychange`（可见）、`focus`、`online`、BFCache `pageshow` 共用唤醒处理；正在进行的检查合并，健康连接补一次有界会话同步，新连接沿用 onOpen 同步。
- 已显示OPEN不作为健康证明：只读 `health` 请求4秒无响应，本地退役连接并恢复。握手8秒超时也退役；旧帧、close和异步响应不能影响新连接。
- 原Hub链接先做同源认证的HEAD检查；原generation还有效就重连它，避免对已到期的断线handoff能力产生不必要依赖。原链接404/410时才调用原能力的handoff；不从会话列表自动选其他实例。
- 单次恢复请求最长8秒，失败退避1.2、2.4、4.8、9.6、15秒，封顶15秒；前台事件可跳过待重试延迟。短暂断网、5xx、202不冒充链接过期。认证拒绝、登录重定向、撤销和不合法successor不继续恢复。
- 受控重启仍遵守既有120秒绝对期限，包含页面暂停导致计时器延迟的情况；没有延长服务端能力或登录有效期。
- 未连接时写操作立即拒绝；不会在重试间隙缓存提问、授权或会话变更再发送给successor。草稿由现有界面保留，不自动代发。

## 验证

- `node --import ./tests/register-ts.mjs tests/pi-client-recovery.test.ts`：17/17。
- `node --import ./tests/register-ts.mjs tests/connection-lifecycle.test.ts`：1/1。
- `npm run test:unit`：485项，484通过，1个既有可选skip，0失败。
- `npm run build:web`、`npm run verify:dist`、本次修改文件的Biome检查、`git diff --check`通过。构建保留既有大chunk提示，Node测试有既有TS模块类型/MockTimers实验性提示。
- 全仓 `npm run check` 没有通过：未修改的 `e2e/fixtures/host-rpc-dialog-extension.ts` 和 `e2e/host-rpc-dialogs.integration.ts` 有3项格式/导入错误，另有原有warning/info。本任务没有扩大修改范围清理这些文件。

浏览器命令（Manager目录和浏览器位置需自行指定）：

```bash
npm run e2e:gen
PI_E2E_MANAGER_DIR=<独立且已构建的Manager目录> \
PI_E2E_BROWSER_EXECUTABLE=<Chromium可执行文件> \
  npx --no-install playwright test -c e2e/playwright.config.ts mobile-reconnect --reporter=list
```

真实Pi RPC进程、独立Hub和Chromium运行于临时本机随机端口，使用faux模型和临时工作区，不调用真实模型、生产卷、凭据或实例。最终BDD 1/1通过，约26秒：网络中断超过15秒后回到同一generation、已有消息可见、未发送草稿仍在、prompt帧只出现一次、无pageerror。

截图在 `test-results/features-mobile-reconnect.-548d5-draft-or-replaying-a-prompt-chromium/reconnected-390.png` 和 `reconnected-1440.png`。已目视检查390×844及1440×900：绿色连接状态、历史消息和完整草稿可见，输入控件未被裁切，没有整页横向溢出。截图是隔离测试，不是生产或手机实机证据。

首次沙箱运行因Chromium权限和本机端口限制失败；授权后同一测试通过。旧的受限测试进程已停止，所有临时Hub/Pi/浏览器由测试清理。

## 尚未宣称的内容

- 不保证手机操作系统永不暂停网页，也不是iOS/Android实机后台测试。
- 页面被操作系统完全销毁后的未发送草稿持久化不是本次范围。
- 本次未推送远程、更新已安装的生产扩展或重启任何生产服务；本地构建通过不等于公网已部署。
