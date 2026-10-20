# 真实私有 Unix socket → Pi PTY 试验

日期：2026-10-19。属于ADR0018 M2a的后续试验，**不是可用网页终端、Hub provider或生产安全边界**。

## 实际链路

```text
合成测试客户端
  → 临时私有 Unix socket
  → Node test broker（复用 TerminalLeaseState）
  → 固定 Python worker 的私有 JSONL stdin/stdout pipes
  → 唯一隔离 Pi 的 PTY
```

新增文件：

- `e2e/harness/pty-transport.ts`：创建0700临时目录/0600 Unix socket；独立随机read/write测试凭据，不落日志/URL；单writer、连接绑定、30秒固定lease、实际断线撤权、连续sequence、输入8KiB、单连接输出队列256KiB、最大3连接；固定worker启动，客户端不能选择命令/路径/进程。
- `e2e/harness/pty-stream-worker.py`：复用已有IsolatedPiPty；epoch/lease/sequence/期限及实际sink重核，单次PTY写入不重试；32KiB原始输出按base64传输，保留UTF-8跨chunk字节；stdin/frame/stdout等待均有界；EOF/TERM/HUP/stop/Pi退出清理同一个Pi。
- `e2e/pty-transport.integration.ts`：真实Unix客户端和真实Pi集成验收。
- `e2e/harness/test-pty-stream-worker.py`：直接私有pipe故障验收，不涉及产品UI。

默认生产路径没有调用这些test harness。没有修改Hub terminal listener，它仍返回 `terminal_backend_unavailable`。没有新增依赖，没有安装或加载个人memory/MCP/真实认证。配置隔离仍不是OS沙箱。

## 与旧进程内句柄试验的差别

这次输入和输出确实经过Unix socket、两个进程间pipe和PTY；不是只调用Python对象。Node复用包内lease模型，但worker独立验证sink；授权仍是测试侧生成的本地凭据，不代表Hub授权、浏览器人工授权或可信生产provider。

- 只读token不能取控制权或输入；写token建立连接后也需显式control。
- socket断开、非法sequence、错epoch、到期撤权；后继grant须等实际sink撤权ACK。测试观察明确状态/事件，不用固定睡眠猜排空。
- `written`仅表示该次PTY字节交付，不是命令完成、用户授权或异步副作用完成。
- 原始输出只实时转发，无screen snapshot。attach声明 `screenAvailable:false`；重连不会取出最后N字节冒充屏幕，也不会自动Ctrl+L或回送DA/DSR。

## 撤权与并发边界

独立复核指出：如果input和revoke只排同一FIFO，input可在Node观察断线后、worker处理revoke前才落笔。已增加独立私有lease marker：grant创建、断线/失败同步删除；worker在sink准入点检查marker，取消尚未通过检查的排队输入。回归在写前暂停worker，断开真实socket后再释放，确认Enter没有提交合成确认框。

**不声称撤权可撤回已经准入的系统调用。** marker检查与单次os.write间仍有不可原子跨进程窗口；通过检查后属于in-flight/结果未知，断线不是取消证明。任何未知输入不得自动重放。文件marker是当前同机测试机制，不是生产跨容器grant方案。

独立复核还指出worker被SIGSTOP时EOF不能让它执行finally。关闭路径已加deadline：优雅关闭后若未退出，对仍由ChildProcess拥有的worker发TERM+CONT，让其恢复执行清理；再等待最多26秒。若仍未退出，明确报cleanup incomplete，不能假报Pi已回收。测试注入SIGSTOP，验证关闭有界、Pi消失、socket移除。硬杀worker不会当然回收PTY子进程，因此不以只杀Python掩盖不完整清理。

## 复现命令与结果

仓库根，使用已有依赖/二进制：

```bash
NODE_OPTIONS='' node --import ./tests/register-ts.mjs --test e2e/pty-transport.integration.ts
PI_E2E_BIN=/home/node/.local/bin/pi NODE_OPTIONS='' \
  node --import ./tests/register-ts.mjs --test e2e/pty-transport.integration.ts
python3 -B e2e/harness/test-pty-stream-worker.py
PI_E2E_BIN=/home/node/.local/bin/pi python3 -B e2e/harness/test-pty-stream-worker.py
```

完整socket套件8项，包含真实30秒lease到期，因此约43秒：

1. socket权限、错token拒绝、只读拒绝、partial帧超时。
2. 原生confirm完整合成预览（含中文emoji）、拒绝无文件、合成Yes写测试marker、同PID。
3. 单writer、第二连接不能抢权、实际socket断开后显式新grant，无自动Enter。
4. 重复Down不落PTY（新writer确认仍选BETA）、旧epoch拒绝、真实resize。
5. 真实固定期限到期、不因输入续期，后继连接必须显式取权。
6. input已进pipe但暂停在sink准入前，实际断socket撤权后丢弃Enter、不产生批准。
7. worker SIGSTOP后close恢复并回收Pi/socket。
8. 正常关闭断开真实客户端、回收唯一Pi、移除socket，重复close安全。

直接worker套件6项：sink epoch/lease/sequence重核与不可覆盖grant、EOF清理、TERM清理、重复JSON键拒绝、超限帧、partial帧期限。首次partial测试失败，因为communicate提前关闭stdin只测到EOF；修正为保持stdin打开等待partial deadline，未放宽worker行为。

实际结果：Pi1.1/1.3 socket套件各 **8/8**，直接worker各 **6/6**；旧PTY套件 **7/7**，现有单元546项 **545pass/1条件skip**。前端/连接两套types、Biome265文件（0error/既有30warnings/1info）、dist核验及diff whitespace通过。只改测试和文档，不重建产品dist，版本仍1.0.1。

独立只读初审发现上述2项P2并修复；限定范围复审确认两项根因修复成立，没有新增必须修复项。审查未独立运行测试，不覆盖下面列出的未验证异常。原始日志：`/tmp/pi-pty-transport-{1.1,1.3,unit,biome}.log`、`/tmp/pi-pty-worker-{1.1,1.3}.log`。

## 尚未覆盖

- 没有浏览器/WS/HTTPS、独立origin的真实攻击验收、手机IME、xterm/headless parser或完整screen/snapshot。未安装这些依赖，不手写ANSI→HTML。
- 没有产品adapter屏障、真实Hub权限撤销/身份变化、local TTY relay/control手势，也没有生产run身份可信证明。不得直接接生产服务。
- sink单次写前检查并不撤回已通过检查的in-flight输入；不证明任意扩展完成、ACK后安全空闲或可重新开放聊天写入。
- worker退出本身不是异常cleanup成功的证明；正常/SIGSTOP测试另外验证Pi消失，但未注入Python cleanup抛异常。关闭升级的26秒不是总期限，stop RPC约2秒+优雅等待1秒+升级后26秒，总约29秒；超限保留目录并明确报错供检查。
- 文件系统unlink失败不会被当成成功撤权，broker整体failclosed；marker未删除时排队input仍属unknown，未动态注入此文件系统故障。
- 没有慢消费者洪泛、不可中断内核状态、worker SIGKILL/宿主崩溃后的全面回收证明。清理仍限同组后代，非setpgid/setsid逃逸追踪。
- Node标准JSON parser的重复键语义不是Python严格JSON parser；当前测试凭据不是恶意同UID隔离。0700/0600不能防同UID或root。
- 所有Yes均针对合成fixture，不是模型替用户批准实际授权。当前Pi/生产配置/SDK未动，没有提交、push、Gate申请、reload或部署。
