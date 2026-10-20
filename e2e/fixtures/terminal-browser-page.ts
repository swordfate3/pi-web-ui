/**
 * Synthetic, isolated-only page for the terminal browser fixture.
 *
 * Static markup only: it loads the bundled client (`/app.js`), xterm's stylesheet
 * (`/xterm.css`) and the local test font (`/mono.woff2`). No inline script, so the
 * fixture server's `script-src 'self'` CSP holds; no form, so `form-action 'none'` holds.
 * Every interactive control starts disabled and is enabled by the client state machine.
 */
export const TERMINAL_BROWSER_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>隔离终端测试 · 非生产</title>
<link rel="stylesheet" href="/xterm.css">
<style>
  :root { color-scheme: dark; }
  @font-face { font-family: FixtureMono; src: url("/mono.woff2") format("woff2"); font-display: block; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #0b1017;
    color: #e4eaf3;
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif;
  }
  #terminal-app { display: flex; flex-direction: column; gap: 12px; padding: 12px; max-width: 100%; }
  h1 { margin: 0; font-size: 18px; line-height: 1.3; }
  h2 { margin: 0 0 8px; font-size: 15px; }
  section { padding: 10px; border: 1px solid #263243; border-radius: 8px; background: #10151e; min-width: 0; }
  .note { margin: 4px 0 0; color: #a9b6c8; font-size: 12px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; }
  .field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  label { font-size: 12px; color: #a9b6c8; }
  input, textarea, button { font: inherit; }
  input, textarea {
    min-height: 32px;
    padding: 4px 6px;
    color: #e4eaf3;
    background: #0b1017;
    border: 1px solid #52627a;
    border-radius: 6px;
  }
  input[type="number"] { width: 7em; }
  button {
    min-height: 32px;
    padding: 4px 10px;
    color: #e4eaf3;
    background: #1b2a3d;
    border: 1px solid #52627a;
    border-radius: 6px;
    cursor: pointer;
  }
  button:disabled, input:disabled, textarea:disabled { opacity: 0.45; cursor: not-allowed; }
  fieldset:disabled { opacity: 0.7; }
  button:focus-visible, input:focus-visible, textarea:focus-visible, #terminal-viewport:focus-visible {
    outline: 2px solid #7fb2ff;
    outline-offset: 2px;
  }
  .status { margin: 6px 0 0; font-size: 13px; min-height: 1.4em; overflow-wrap: anywhere; }
  #terminal-notice { color: #ffd7a1; }
  #lease-countdown { color: #a9b6c8; }
  #terminal-viewport {
    overflow: auto;
    max-height: 70vh;
    padding: 6px;
    background: #0f141c;
    border: 1px solid #52627a;
    border-radius: 6px;
  }
  /* Keep the PTY's original column width; small screens scroll horizontally instead of reflowing. */
  #terminal-screen { width: max-content; min-width: 100%; }
  #terminal-text { width: 100%; min-height: 64px; font-family: FixtureMono, monospace; }
  fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
  .keys { margin-top: 8px; }
  @media (max-width: 480px) {
    #terminal-app { padding: 8px; gap: 8px; }
    h1 { font-size: 16px; }
  }
</style>
</head>
<body>
<main id="terminal-app">
  <header id="fixture-header">
    <h1>隔离终端测试 · 非生产</h1>
    <p class="note" id="fixture-scope">合成测试数据 · 仅在隔离环境使用的手动验证页面 · 不是生产终端，也不是产品入口</p>
    <p class="note" id="fixture-authorization">取得控制权不是新的真实人工授权；本页没有批准或授权专用按键，配对码与 Cookie 均由测试服务端发放。</p>
  </header>

  <section aria-labelledby="pairing-heading">
    <h2 id="pairing-heading">配对与授权</h2>
    <div class="toolbar">
      <div class="field">
        <label for="pairing-code">配对码</label>
        <input id="pairing-code" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="text" disabled>
      </div>
      <button type="button" id="unlock-button" disabled>解锁</button>
      <button type="button" id="logout-button" disabled>退出授权</button>
    </div>
    <p class="status" id="pairing-status" role="status" aria-live="polite">正在读取授权状态…</p>
  </section>

  <section aria-labelledby="connection-heading">
    <h2 id="connection-heading">连接</h2>
    <div class="toolbar">
      <button type="button" id="connect-button" disabled>连接终端</button>
      <button type="button" id="control-button" disabled>取得控制权</button>
      <button type="button" id="release-button" disabled>释放控制权</button>
      <button type="button" id="disconnect-button" disabled>断开连接</button>
    </div>
    <p class="status" id="connection-status" role="status" aria-live="polite">未连接</p>
    <p class="status" id="lease-countdown" aria-live="off"></p>
    <p class="status" id="terminal-notice" role="alert" aria-live="assertive"></p>
    <p class="status" id="io-status" role="status" aria-live="polite"></p>
    <p class="note">连接建立后才会打开同源的 /ws；不使用自动重连、自动重试、自动续租或自动取得控制权。</p>
  </section>

  <section aria-labelledby="screen-heading">
    <h2 id="screen-heading">终端画面</h2>
    <div id="terminal-viewport" role="group" aria-label="终端画面：只读完整快照，保持原始列宽，小屏可横向滚动" tabindex="0">
      <div id="terminal-screen"></div>
    </div>
    <p class="status" id="terminal-state" role="status" aria-live="polite">未连接终端；画面区域为空</p>
  </section>

  <section aria-labelledby="input-heading">
    <h2 id="input-heading">输入</h2>
    <fieldset id="input-surface" disabled>
      <div class="field">
        <label for="terminal-text">终端文本</label>
        <textarea id="terminal-text" rows="3" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>
      </div>
      <div class="toolbar keys" role="group" aria-label="文本与固定按键">
        <button type="button" id="send-text-button">发送文本</button>
        <button type="button" id="key-up">上</button>
        <button type="button" id="key-down">下</button>
        <button type="button" id="key-left">左</button>
        <button type="button" id="key-right">右</button>
        <button type="button" id="key-enter">Enter</button>
        <button type="button" id="key-esc">Esc</button>
        <button type="button" id="key-ctrl-c">Ctrl+C</button>
        <button type="button" id="key-backspace">Backspace</button>
      </div>
      <div class="toolbar keys" role="group" aria-label="调整尺寸">
        <div class="field">
          <label for="resize-columns">列数</label>
          <input id="resize-columns" type="number" min="20" max="240" step="1" value="120" inputmode="numeric">
        </div>
        <div class="field">
          <label for="resize-rows">行数</label>
          <input id="resize-rows" type="number" min="5" max="120" step="1" value="40" inputmode="numeric">
        </div>
        <button type="button" id="resize-button">调整尺寸</button>
      </div>
    </fieldset>
    <p class="note" id="input-explanation">仅在写权限且显式取得控制权后启用；不转发浏览器键盘事件、不自动附加 Enter、不排队按键，同一时刻只允许一条在途操作。输入交付未知时本页锁存该状态，只能人工核对终端后重新加载。</p>
  </section>
</main>
<script src="/app.js"></script>
</body>
</html>`;
