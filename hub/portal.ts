export const portalHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi · 会话总览</title><link rel="stylesheet" href="/hub.css"><script src="/hub.js" defer></script></head>
<body><main><header><a class="brand" href="/sessions/" aria-label="Pi 会话首页"><span class="logo">π</span> Pi Web <span class="tag">HUB</span></a><span id="health" role="status">正在连接</span></header>
<section class="intro"><span class="eyebrow">你的工作，随时接续</span><h1>所有会话，一个入口。</h1><p>选择正在运行的 Pi，在手机与电脑之间继续工作。</p></section>
<section class="toolbar" aria-label="会话操作"><div><h2>在线会话 <span id="count">0</span></h2><p id="updated">等待登记</p></div><div class="controls"><label><span class="sr-only">搜索会话</span><input id="search" type="search" placeholder="搜索项目或会话…"></label><button id="refresh" type="button">刷新</button></div></section>
<div id="notice" role="status"></div><section id="sessions" class="grid" aria-label="在线 Pi 会话"></section>
<section id="empty" class="empty" hidden><span class="empty-icon">π</span><h3>还没有在线会话</h3><p>为 Pi 配置本总管的登记 socket 和独立凭据。<br>已启动的会话会自动出现在这里。</p></section>
<footer><span>每个会话独立连接 · 退出一个不影响其他会话</span><span>Pi Web Hub</span></footer></main></body></html>`;

export const portalJs = `(() => {
  const get = (id) => document.getElementById(id);
  let items = [];
  let loading = false;
  // Legacy launchers append a short run ID to the grant's project label.
  // Display-only: keep the original API label and capability route untouched.
  const projectLabel = (label) => label.replace(/ · [a-f0-9]{8}$/i, '').trim() || label;
  function render() {
    const query = get('search').value.toLocaleLowerCase();
    const visible = items.filter((s) => projectLabel(s.label).toLocaleLowerCase().includes(query) || (s.sessionName || '未命名会话').toLocaleLowerCase().includes(query));
    get('sessions').replaceChildren();
    get('count').textContent = String(items.length);
    get('empty').hidden = items.length !== 0;
    get('notice').textContent = items.length && !visible.length ? '没有匹配的会话，请尝试其他关键词。' : '';
    for (const session of visible) {
      const card = document.createElement('article'); card.className = 'card';
      const top = document.createElement('div'); top.className = 'card-top';
      const icon = document.createElement('span'); icon.className = 'project-icon'; icon.textContent = '↗';
      const status = document.createElement('span'); status.className = 'online'; status.textContent = '在线';
      top.append(icon, status);
      const title = document.createElement('h3'); title.textContent = projectLabel(session.label); title.title = title.textContent;
      const meta = document.createElement('p'); meta.className = 'meta';
      const name = document.createElement('span'); name.className = 'session-name'; name.textContent = session.sessionName || '未命名会话'; name.title = name.textContent;
      const since = document.createElement('span'); since.textContent = ' · ' + new Date(session.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      meta.append(name, since);
      const link = document.createElement('a'); link.className = 'open'; link.href = session.path; link.textContent = '打开会话 ↗';
      card.append(top, title, meta, link); get('sessions').append(card);
    }
  }
  async function refresh() {
    if (loading) return; loading = true; get('refresh').disabled = true;
    try {
      const response = await fetch('/api/sessions', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error();
      const data = await response.json(); items = data.sessions; render();
      get('health').textContent = '● 总管已连接'; get('health').className = 'connected';
      get('updated').textContent = '刚刚更新 · 每 5 秒自动刷新';
    } catch {
      // Do not leave stale sessions looking online when the hub is unavailable.
      items = []; render(); get('health').textContent = '连接中断'; get('health').className = 'disconnected';
      get('notice').textContent = '暂时无法连接总管。请检查服务，或点击刷新重试。';
    } finally { loading = false; get('refresh').disabled = false; }
  }
  get('search').addEventListener('input', render); get('refresh').addEventListener('click', refresh);
  refresh(); setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();`;

export const portalCss = `:root{color-scheme:light;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#21312c;background:#f6f8f5;font-synthesis:none}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 90% 0,#e6efdf,transparent 55%)}main{max-width:1080px;margin:auto;padding:32px 40px 24px;min-height:100dvh}header{display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:flex;align-items:center;gap:12px;font-size:20px;font-weight:650;color:inherit;text-decoration:none}.logo{display:grid;place-items:center;border-radius:12px;background:#234c3c;color:#e8f3dd;width:42px;height:42px;font:32px Georgia,serif}.tag{font-size:10px;letter-spacing:2px;color:#758478;border:1px solid #d7dfd5;border-radius:5px;padding:4px 6px}#health{font-size:12px;color:#697c70}.connected{color:#347652!important}.disconnected{color:#a35437!important}.intro{padding:68px 0 48px}.eyebrow{font-size:12px;letter-spacing:2px;color:#718478}h1{margin:14px 0 16px;font-size:clamp(30px,4vw,46px);font-weight:600;letter-spacing:-1.5px}.intro p{margin:0;color:#718076;font-size:15px;line-height:1.8}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:22px}h2{font-size:17px;font-weight:600;margin:0}#count{display:inline-grid;place-items:center;min-width:25px;height:23px;margin-left:8px;background:#e2ebe0;border-radius:7px;color:#476347;font-size:12px}#updated{font-size:12px;color:#879287;margin:8px 0 0}.controls{display:flex;gap:10px}input,button{font:inherit;border:1px solid #dce3d9;border-radius:9px;background:#fff;padding:11px 14px;font-size:13px;color:#415447}input{width:230px}button{cursor:pointer}button:hover{background:#eef3eb}button:disabled{opacity:.55}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #93ad91;outline-offset:3px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}.card{background:#ffffffdc;border:1px solid #e0e7dc;border-radius:16px;padding:24px;box-shadow:0 6px 24px #29412c04;min-width:0}.card-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}.project-icon{display:grid;place-items:center;width:40px;height:40px;background:#edf3e8;color:#587452;border-radius:11px;font-size:23px}.online{font-size:11px;color:#39734e;background:#eff5eb;border-radius:20px;padding:5px 10px}.online:before{content:'●';font-size:8px;margin-right:5px}.card h3{font-size:18px;font-weight:600;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{font-size:12px;color:#899587;margin:10px 0 24px;display:flex;min-width:0}.session-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta>span:last-child{flex-shrink:0}.open{display:block;text-align:center;color:#365b42;background:#f2f6ee;border:1px solid #e4ebdf;text-decoration:none;border-radius:8px;padding:11px;font-size:13px}.open:hover{background:#e7efdf}.empty{text-align:center;border:1px dashed #d6dfd0;border-radius:16px;padding:55px 20px;background:#ffffff70}.empty-icon{font:44px Georgia,serif;color:#8a9e82}.empty h3{font-size:17px;font-weight:500;margin:18px 0 10px}.empty p{font-size:13px;color:#7a8978;line-height:1.9}#notice{font-size:13px;color:#a35c3d;line-height:1.6;margin-bottom:14px}#notice:empty{display:none}footer{display:flex;justify-content:space-between;gap:15px;border-top:1px solid #e0e6db;margin-top:48px;padding-top:20px;font-size:11px;color:#96a18f}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}[hidden]{display:none!important}@media(max-width:600px){main{padding:24px 20px}header{gap:8px}.brand{font-size:17px;gap:8px}.logo{width:36px;height:36px;font-size:27px}#health{font-size:11px}.intro{padding:48px 0 34px}h1{letter-spacing:-1px;line-height:1.35}.toolbar{flex-direction:column;align-items:stretch;gap:18px}.controls label{flex:1;min-width:0}input{width:100%;min-width:0}.grid{grid-template-columns:1fr}.card{padding:22px}.card-top{margin-bottom:18px}footer{flex-direction:column;margin-top:32px;line-height:1.6}}`;
