# 鲸鱼娘本地 GIF 素材

状态：基于 `41ce8c7` 的本地开发，未提交、push 或更新启用包，未自动 `/reload`，未重启 Hub／隧道。

## 行为

- 五个本地槽均支持 PNG/WebP/GIF，保留每张 ≤2 MiB、每边 ≤2048 像素限制。GIF87a／GIF89a magic、MIME 一致性、逻辑画布和实际解码尺寸均检查；损坏或伪装文件不覆盖已有槽。
- IndexedDB 保存原始 Blob，普通模式原生 `<img>` 使用原 GIF；不重编码原图，不上传给 Pi、模型或图片站点。不增加模型调用／Token，也没有新增生产依赖。GIF 是否循环取决于素材自身。
- CSS 不能暂停 GIF，所以单独生成静态首帧 PNG（长边 ≤512），仅作本页预览，不回写原图。设置缩略图始终静态；网页减少动画与系统 `prefers-reduced-motion` 任意一个启用时，宠物显示静态首帧，两者都关闭后恢复原动画。
- 原图与预览两套 object URL 在替换／清除／卸载／过期恢复结果时释放。恢复、导入、清除仍串行；按槽 temporary 警告保留。解码和首帧编码设 3 秒截止时间；不可取消的迟到解码完成后关闭 bitmap，不再创建 URL。
- 不将第三方同人素材放入源码、公开 dist 或 npm tarball；原许可与软件 MIT 分开。既有 PNG/WebP 原 Blob 不迁移，也适用静态预览模式。

## 验证证据

- 默认单测 265 项：264 通过、1 可选 GiB 条件跳过。新增 GIF magic／MIME／逻辑尺寸／大小、解码错误、原 bytes 不变、实际尺寸拒绝、512×256 预览缩放、解码超时和迟到 bitmap 关闭；canvas/decoder 使用 mock，不能代替真实 GIF 动态测试。
- 前端构建、manifest/hash 校验、补充 strict types（复用已有 review 工作树 ws 声明）通过；Biome 199 文件无 error，仍有既有 history-store 五项 non-null assertion warning；没有安装依赖。完整 mirror adapter 的既有 strict 类型边界没有因此扩大或宣称全通过。
- 最终源码既有完整 Chromium 回归 68/68（排除新增 GIF 场景），新 GIF 专项 1/1；分两轮，不能说同一轮全量 69/69。GIF 专项验证原生 `<img>` 截图帧差、IndexedDB 原字节哈希、刷新后仍播放、PNG 缩略图、系统／用户双向切换及系统 reduce 优先、真截断 GIF 与 MIME 不匹配均不覆盖原图；usage/upload 请求为零。最终离线解包 runtime 再跑全部六项鲸鱼场景 6/6，包含既有桌面／手机、拖动／缩放、键盘式视口恢复、hydration／部分存储失败。
- 限定只读快照审查未发现可证实 P2+；没有执行程序、非完整 diff 或原子审计。系统／用户双向切换、原帧变化、原 bytes 和刷新由专项 E2E 补充，URL 创建／撤销计数、解码中真正卸载及 StrictMode 重放没有独立动态计数认证。
- 离线 pack／解包 704 entries，138 source／673 output，只含 ws 生产依赖；三个相关源码 stale-input 均被拒绝。不是实际 npm 安装／更新生命周期。

## 独立 Browser 可见检查

临时真实 Pi `http://127.0.0.1:45091`，只操作自己的隔离页，未操作其他浏览器标签。导入本地已下载 `idle.gif`：70,410 bytes、192×208；普通 src 为 `image/gif`，系统 reduce 后 src 为 `image/png`，尺寸不变。素材并未上传服务器。

直接查看了以下截图（仓库外、不随包分发）：

- `downloads/playwright-mcp/whale-gif-desktop.png`：1440×900，角色显示在输入框右上方，控件、输入框清晰。
- `downloads/playwright-mcp/whale-gif-mobile.png`：390×844，GIF 角色与输入框没有新增横向溢出。
- `downloads/playwright-mcp/whale-gif-mobile-still.png`：390×844，系统减少动画后静态首帧；scrollWidth=390。
- `downloads/playwright-mcp/whale-gif-mobile-settings.png`：手机设置可滚动、PNG/WebP/GIF 与减少动画说明可读、待机缩略图为静态 PNG。

截图只证明可见布局，不能独自证明 GIF 连续播放；专项原生帧差测试是另一个证据层。截图后仅将素材目录提示从静态目录说明补为「02桌宠／04动态GIF」，未改布局。后续临时服务 `127.0.0.1:45227` 尝试补截最终文案时，两次 open-settings actionability 等待超时，未得到新截图，不当成已验证或已定位的产品缺陷。自有服务 PID119458、PID122507 均已 SIGTERM 并确认退出；这些 URL 不代表用户端已升级。

## 失败尝试与限制

- 超时清理单测最初仅等一个 microtask，Promise adoption 链尚未运行到 late-close；改为有界等待并仍严格断言关闭后通过，没有放宽 bitmap 释放要求。
- 编写 E2E 期间 Biome 检查遇到其格式尚未收尾，不能当成最终检查结果；收尾格式化后最终检查无 error，保留早期失败日志。
- 子代理首次独立运行新 GIF 场景时未设置持久化 Chromium 路径，缺少默认 headless shell，未安装浏览器；主代理使用既有 `.tmp/visual-check/whale-browser.sh` 的已安装浏览器及动态库环境后，新场景1/1和离线包六项6/6通过。
- 受浏览器原生 GIF 解码能力、文件本身帧时长／循环设置影响，不承诺任意损坏／巨大帧数的 GIF 都完整通过。没有逐帧穷尽检查或动画 CPU／内存基准，文件大小和尺寸限制不是所有解码资源的数学上界。
- 不保证后台或不可见标签停止浏览器全部解码工作；没有引入 JS 逐帧循环或改动 Pi 会话。未测试实体手机、Safari／Firefox 或所有厂商 WebView。
- 旧静态 WebP 不会因升级变成动画，需重新选择真正的 `.gif`。已下载素材 ≤95,024 bytes、192×208，符合现有导入限额；这不替代其再分发许可核查。

日志：`/tmp/pi-whale-gif-{unit-final,types-final,build-final,dist-final,check-final,e2e-initial,regression,specific,offline,package-final}.log`；最终离线包 `.tmp/whale-gif-release-final/result.json`。
