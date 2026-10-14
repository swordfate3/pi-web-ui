#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import net, { isIP } from "node:net";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __esmMin = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region extensions/connection-config.ts
var connection_config_exports = /* @__PURE__ */ __exportAll({
	localWebUrl: () => localWebUrl,
	resolveConnectionConfig: () => resolveConnectionConfig,
	validatedPublicUrl: () => validatedPublicUrl
});
/** Never include the supplied value in errors: it may contain a credential. */
function validatedPublicUrl(value) {
	if (typeof value !== "string") throw new Error("Invalid Pi Web public URL");
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Invalid Pi Web public URL");
	}
	const loopback = [
		"localhost",
		"127.0.0.1",
		"[::1]"
	].includes(url.hostname);
	if (!(url.protocol === "https:" || url.protocol === "http:" && loopback) || url.username || url.password || url.search || url.hash) throw new Error("Invalid Pi Web public URL");
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	return url.href;
}
function resolveConnectionConfig(settings = {}, env = process.env) {
	const portValue = env.PI_WEB_UI_PORT ?? settings.port ?? 3001;
	if (!/^\d+$/.test(String(portValue))) throw new Error("Invalid Pi Web port");
	const port = Number(portValue);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Pi Web port");
	const host = env.PI_WEB_UI_HOST ?? settings.host ?? "127.0.0.1";
	if (typeof host !== "string" || !isIP(host) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) throw new Error("Invalid Pi Web host");
	const disabled = env.PI_WEB_UI_DISABLED;
	if (disabled !== void 0 && ![
		"0",
		"1",
		"true",
		"false"
	].includes(disabled)) throw new Error("Invalid Pi Web disabled option");
	const warnings = [];
	let publicUrl;
	const suppliedUrl = env.PI_WEB_UI_PUBLIC_URL ?? settings.publicUrl;
	if (suppliedUrl !== void 0) try {
		publicUrl = validatedPublicUrl(suppliedUrl);
	} catch {
		warnings.push("Pi Web public URL ignored: use HTTPS without credentials, query or fragment");
	}
	const socketPath = env.PI_WEB_UI_REGISTRY_SOCKET ?? settings.registration?.socketPath;
	const credentialFile = env.PI_WEB_UI_REGISTRY_CREDENTIAL_FILE ?? settings.registration?.credentialFile;
	let registration;
	if (socketPath !== void 0 || credentialFile !== void 0) if (typeof socketPath === "string" && socketPath.trim() && !socketPath.includes("\0") && typeof credentialFile === "string" && credentialFile.trim() && !credentialFile.includes("\0")) registration = {
		socketPath,
		credentialFile
	};
	else warnings.push("Pi Web registration disabled: configure both socketPath and credentialFile");
	return {
		host,
		port,
		publicUrl,
		registration,
		warnings,
		autoStart: disabled === void 0 ? settings.disabled !== true : disabled !== "1" && disabled !== "true"
	};
}
function localWebUrl(host, port) {
	const browserHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
	return `http://${isIP(browserHost) === 6 ? `[${browserHost}]` : browserHost}:${port}/`;
}
var init_connection_config = __esmMin((() => {}));
//#endregion
//#region hub/config.ts
init_connection_config();
function privateDirectory(directory) {
	mkdirSync(directory, {
		recursive: true,
		mode: 448
	});
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || process.platform !== "win32" && ((stat.mode & 63) !== 0 || stat.uid !== process.getuid?.())) throw new Error("Hub state directory must be private and owned by the current user");
}
function readPrivateJson(file) {
	const stat = lstatSync(file);
	if (!stat.isFile() || stat.size > 8192 || process.platform !== "win32" && ((stat.mode & 63) !== 0 || stat.uid !== process.getuid?.())) throw new Error("Invalid private hub file");
	return JSON.parse(readFileSync(file, "utf8"));
}
function initializeHub(file, options = {}) {
	mkdirSync(path.dirname(path.resolve(file)), {
		recursive: true,
		mode: 448
	});
	writeFileSync(file, `${JSON.stringify({
		port: 16180,
		...options
	}, null, 2)}\n`, {
		flag: "wx",
		mode: 384
	});
}
function readHubConfig(file) {
	const value = readPrivateJson(file);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hub configuration");
	const host = value.host ?? "127.0.0.1";
	if (host !== "127.0.0.1" && host !== "::1") throw new Error("Hub HTTP must bind to loopback; use a trusted TLS gateway");
	const port = value.port ?? 16180;
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid hub port");
	const leaseMs = value.leaseMs ?? 45e3;
	if (!Number.isInteger(leaseMs) || leaseMs < 500 || leaseMs > 3e5) throw new Error("Invalid hub lease");
	const parent = path.dirname(path.resolve(file));
	if (value.stateDir !== void 0 && (typeof value.stateDir !== "string" || !value.stateDir || value.stateDir.includes("\0"))) throw new Error("Invalid hub state directory");
	const stateDir = path.resolve(parent, value.stateDir ?? "state");
	if (value.runtimeDir !== void 0 && (typeof value.runtimeDir !== "string" || !value.runtimeDir || value.runtimeDir.includes("\0"))) throw new Error("Invalid hub runtime directory");
	const runtimeDir = path.resolve(parent, value.runtimeDir ?? "runtime");
	if (runtimeDir === stateDir || runtimeDir.startsWith(`${stateDir}${path.sep}`) || stateDir.startsWith(`${runtimeDir}${path.sep}`)) throw new Error("Hub IPC and administrator state must be separate directories");
	const publicUrl = value.publicUrl === void 0 ? void 0 : validatedPublicUrl(value.publicUrl);
	if (publicUrl && new URL(publicUrl).pathname !== "/") throw new Error("Hub public URL must use the domain root");
	if (process.platform === "win32") throw new Error("Bundled hub currently requires Unix IPC (Linux/macOS); standalone Pi Web still works");
	return {
		stateDir,
		runtimeDir,
		socketPath: path.join(runtimeDir, "registry.sock"),
		host,
		port,
		leaseMs,
		publicUrl
	};
}
function validHost(host) {
	return Boolean(isIP(host)) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host);
}
function hasControls(value) {
	return [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
function readGrant(config, runId) {
	if (!/^[0-9a-f]{32}$/.test(runId)) throw new Error("Invalid session capability");
	const grant = readPrivateJson(path.join(config.stateDir, "grants", `${runId}.json`));
	if (grant.run_id !== runId || !/^[0-9a-f]{64}$/.test(grant.token) || typeof grant.label !== "string" || grant.label.length > 120 || hasControls(grant.label) || typeof grant.backendHost !== "string" || !validHost(grant.backendHost)) throw new Error("Invalid session capability");
	return grant;
}
function issueSession(config, output, options) {
	privateDirectory(config.stateDir);
	privateDirectory(path.join(config.stateDir, "grants"));
	const backendHost = options.backendHost ?? "127.0.0.1";
	if (!validHost(backendHost) || !options.label.trim() || options.label.length > 120 || hasControls(options.label)) throw new Error("Invalid session label or backend host");
	const credential = {
		run_id: randomBytes(16).toString("hex"),
		token: randomBytes(32).toString("hex")
	};
	const grant = {
		...credential,
		label: options.label,
		backendHost
	};
	const resolvedOutput = path.resolve(output);
	if (resolvedOutput === config.socketPath || resolvedOutput.startsWith(`${config.stateDir}${path.sep}`)) throw new Error("Session credential must be outside the administrator state directory");
	writeFileSync(resolvedOutput, `${JSON.stringify(credential)}\n`, {
		flag: "wx",
		mode: 384
	});
	writeFileSync(path.join(config.stateDir, "grants", `${credential.run_id}.json`), `${JSON.stringify(grant)}\n`, {
		flag: "wx",
		mode: 384
	});
	return credential;
}
function revokeSession(config, runId) {
	const grant = readGrant(config, runId);
	writeFileSync(path.join(config.stateDir, "grants", `${runId}.json`), `${JSON.stringify({
		...grant,
		revoked: true
	})}\n`, { mode: 384 });
}
//#endregion
//#region hub/portal.ts
var portalHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi · 会话总览</title><link rel="stylesheet" href="/hub.css"><script src="/hub.js" defer><\/script></head>
<body><main><header><a class="brand" href="/sessions/" aria-label="Pi 会话首页"><span class="logo">π</span> Pi Web <span class="tag">HUB</span></a><span id="health" role="status">正在连接</span></header>
<section class="intro"><span class="eyebrow">你的工作，随时接续</span><h1>所有会话，一个入口。</h1><p>选择正在运行的 Pi，在手机与电脑之间继续工作。</p></section>
<section class="toolbar" aria-label="会话操作"><div><h2>在线会话 <span id="count">0</span></h2><p id="updated">等待登记</p></div><div class="controls"><label><span class="sr-only">搜索会话</span><input id="search" type="search" placeholder="搜索项目或会话…"></label><button id="refresh" type="button">刷新</button></div></section>
<div id="notice" role="status"></div><section id="sessions" class="grid" aria-label="在线 Pi 会话"></section>
<section id="empty" class="empty" hidden><span class="empty-icon">π</span><h3>还没有在线会话</h3><p>为 Pi 配置本总管的登记 socket 和独立凭据。<br>已启动的会话会自动出现在这里。</p></section>
<footer><span>每个会话独立连接 · 退出一个不影响其他会话</span><span>Pi Web Hub</span></footer></main></body></html>`;
var portalJs = `(() => {
  const get = (id) => document.getElementById(id);
  let items = [];
  let loading = false;
  function render() {
    const query = get('search').value.toLocaleLowerCase();
    const visible = items.filter((s) => s.label.toLocaleLowerCase().includes(query) || s.generation.includes(query));
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
      const title = document.createElement('h3'); title.textContent = session.label; title.title = session.label;
      const meta = document.createElement('p'); meta.className = 'meta'; meta.textContent = '会话 ' + session.generation.slice(0, 8) + ' · ' + new Date(session.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
var portalCss = `:root{color-scheme:light;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#21312c;background:#f6f8f5;font-synthesis:none}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 90% 0,#e6efdf,transparent 55%)}main{max-width:1080px;margin:auto;padding:32px 40px 24px;min-height:100dvh}header{display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:flex;align-items:center;gap:12px;font-size:20px;font-weight:650;color:inherit;text-decoration:none}.logo{display:grid;place-items:center;border-radius:12px;background:#234c3c;color:#e8f3dd;width:42px;height:42px;font:32px Georgia,serif}.tag{font-size:10px;letter-spacing:2px;color:#758478;border:1px solid #d7dfd5;border-radius:5px;padding:4px 6px}#health{font-size:12px;color:#697c70}.connected{color:#347652!important}.disconnected{color:#a35437!important}.intro{padding:68px 0 48px}.eyebrow{font-size:12px;letter-spacing:2px;color:#718478}h1{margin:14px 0 16px;font-size:clamp(30px,4vw,46px);font-weight:600;letter-spacing:-1.5px}.intro p{margin:0;color:#718076;font-size:15px;line-height:1.8}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:22px}h2{font-size:17px;font-weight:600;margin:0}#count{display:inline-grid;place-items:center;min-width:25px;height:23px;margin-left:8px;background:#e2ebe0;border-radius:7px;color:#476347;font-size:12px}#updated{font-size:12px;color:#879287;margin:8px 0 0}.controls{display:flex;gap:10px}input,button{font:inherit;border:1px solid #dce3d9;border-radius:9px;background:#fff;padding:11px 14px;font-size:13px;color:#415447}input{width:230px}button{cursor:pointer}button:hover{background:#eef3eb}button:disabled{opacity:.55}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #93ad91;outline-offset:3px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}.card{background:#ffffffdc;border:1px solid #e0e7dc;border-radius:16px;padding:24px;box-shadow:0 6px 24px #29412c04;min-width:0}.card-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}.project-icon{display:grid;place-items:center;width:40px;height:40px;background:#edf3e8;color:#587452;border-radius:11px;font-size:23px}.online{font-size:11px;color:#39734e;background:#eff5eb;border-radius:20px;padding:5px 10px}.online:before{content:'●';font-size:8px;margin-right:5px}.card h3{font-size:18px;font-weight:600;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{font-size:12px;color:#899587;margin:10px 0 24px}.open{display:block;text-align:center;color:#365b42;background:#f2f6ee;border:1px solid #e4ebdf;text-decoration:none;border-radius:8px;padding:11px;font-size:13px}.open:hover{background:#e7efdf}.empty{text-align:center;border:1px dashed #d6dfd0;border-radius:16px;padding:55px 20px;background:#ffffff70}.empty-icon{font:44px Georgia,serif;color:#8a9e82}.empty h3{font-size:17px;font-weight:500;margin:18px 0 10px}.empty p{font-size:13px;color:#7a8978;line-height:1.9}#notice{font-size:13px;color:#a35c3d;line-height:1.6;margin-bottom:14px}#notice:empty{display:none}footer{display:flex;justify-content:space-between;gap:15px;border-top:1px solid #e0e6db;margin-top:48px;padding-top:20px;font-size:11px;color:#96a18f}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}[hidden]{display:none!important}@media(max-width:600px){main{padding:24px 20px}header{gap:8px}.brand{font-size:17px;gap:8px}.logo{width:36px;height:36px;font-size:27px}#health{font-size:11px}.intro{padding:48px 0 34px}h1{letter-spacing:-1px;line-height:1.35}.toolbar{flex-direction:column;align-items:stretch;gap:18px}.controls label{flex:1;min-width:0}input{width:100%;min-width:0}.grid{grid-template-columns:1fr}.card{padding:22px}.card-top{margin-bottom:18px}footer{flex-direction:column;margin-top:32px;line-height:1.6}}`;
//#endregion
//#region hub/server.ts
var mac = (token, value) => createHmac("sha256", token).update(value).digest("hex");
function equal(value, expected) {
	if (typeof value !== "string") return false;
	const a = Buffer.from(value);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}
async function proveBackend(grant, generation, port) {
	const challenge = randomBytes(24).toString("hex");
	return new Promise((resolve) => {
		let settled = false;
		const finish = (valid) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			request.destroy();
			resolve(valid);
		};
		const request = http.get({
			host: grant.backendHost,
			port,
			path: "/.pi-web-identity",
			agent: false,
			headers: {
				"x-pi-web-challenge": challenge,
				"x-pi-web-challenge-proof": mac(grant.token, challenge)
			}
		}, (response) => {
			if (response.statusCode !== 200) {
				finish(false);
				return;
			}
			let body = "";
			response.on("data", (chunk) => {
				body += chunk;
				if (body.length > 4096) finish(false);
			});
			response.on("error", () => finish(false));
			response.on("end", () => {
				try {
					const value = JSON.parse(body);
					finish(value.generation === generation && equal(value.proof, mac(grant.token, `${challenge}:${generation}`)));
				} catch {
					finish(false);
				}
			});
		});
		const timer = setTimeout(() => finish(false), 1500);
		request.on("error", () => finish(false));
	});
}
function backendHeaders(request, session) {
	const headers = {};
	const hop = new Set([
		"connection",
		"upgrade",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"te",
		"trailer",
		"transfer-encoding",
		"authorization",
		"cookie",
		"host"
	]);
	for (const field of (request.headers.connection ?? "").split(",")) hop.add(field.trim().toLowerCase());
	for (const [key, value] of Object.entries(request.headers)) if (!hop.has(key) && !key.startsWith("x-pi-web-") && !key.startsWith("x-forwarded-") && key !== "forwarded") headers[key] = value;
	headers["x-pi-web-generation"] = session.generation;
	headers["x-pi-web-proof"] = mac(session.grant.token, session.generation);
	return headers;
}
/** Explicitly launched independent process; never imported as a Pi extension entry. */
async function startHub(config) {
	privateDirectory(config.runtimeDir);
	const lock = path.join(config.runtimeDir, "hub.lock");
	mkdirSync(lock, { mode: 448 });
	const owner = path.join(lock, "owner.json");
	const release = () => {
		if (!existsSync(lock)) return;
		if (existsSync(owner)) unlinkSync(owner);
		rmdirSync(lock);
	};
	try {
		writeFileSync(owner, JSON.stringify({ pid: process.pid }), {
			flag: "wx",
			mode: 384
		});
		const hub = await startLockedHub(config);
		let closing;
		return {
			...hub,
			close: () => {
				closing ??= hub.close().finally(release);
				return closing;
			}
		};
	} catch (error) {
		release();
		throw error;
	}
}
async function startLockedHub(config) {
	privateDirectory(config.stateDir);
	privateDirectory(config.runtimeDir);
	privateDirectory(path.join(config.stateDir, "grants"));
	privateDirectory(path.join(config.stateDir, "generations"));
	if (existsSync(config.socketPath)) {
		const stat = lstatSync(config.socketPath);
		if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("Unsafe hub socket path");
		if (!await new Promise((resolve) => {
			const socket = net.createConnection(config.socketPath);
			const timer = setTimeout(() => {
				socket.destroy();
				resolve(false);
			}, 500);
			socket.once("connect", () => {
				clearTimeout(timer);
				socket.destroy();
				resolve(false);
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				socket.destroy();
				resolve(error.code === "ECONNREFUSED");
			});
		})) throw new Error("Another hub is already running");
		unlinkSync(config.socketPath);
	}
	const boot = randomBytes(16).toString("hex");
	const sessions = /* @__PURE__ */ new Map();
	const peers = /* @__PURE__ */ new Set();
	const connections = /* @__PURE__ */ new Set();
	const webSockets = /* @__PURE__ */ new Map();
	let stopped = false;
	let pending = Promise.resolve();
	let url = "";
	const retire = (generation) => {
		sessions.delete(generation);
		for (const [ws, id] of webSockets) if (id === generation) ws.terminate();
	};
	const current = (generation) => {
		const session = sessions.get(generation);
		if (!session) return void 0;
		try {
			const grant = readGrant(config, session.grant.run_id);
			if (session.expires <= Date.now() || grant.revoked || !equal(grant.token, session.grant.token) || grant.backendHost !== session.grant.backendHost) {
				retire(generation);
				return;
			}
		} catch {
			retire(generation);
			return;
		}
		return session;
	};
	const register = async (value) => {
		if (stopped || typeof value.run_id !== "string" || typeof value.generation !== "string" || !/^[0-9a-f]{32}$/.test(value.generation)) throw new Error("Registration rejected");
		const grant = readGrant(config, value.run_id);
		if (grant.revoked || !equal(value.token, grant.token)) throw new Error("Registration rejected");
		const generation = value.generation;
		const session = current(generation);
		const ledger = path.join(config.stateDir, "generations", `${generation}.json`);
		const owner = existsSync(ledger) ? readPrivateJson(ledger) : void 0;
		if (value.action === "unregister") {
			if (session && session.grant.run_id !== grant.run_id || owner && owner.run_id !== grant.run_id) throw new Error("Registration rejected");
			writeFileSync(ledger, JSON.stringify({
				boot,
				run_id: grant.run_id,
				retired: true
			}), {
				flag: owner ? "w" : "wx",
				mode: 384
			});
			retire(generation);
			return {};
		}
		if (value.action !== "register" || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) throw new Error("Registration rejected");
		const port = Number(value.port);
		if (owner) {
			if (owner.retired || owner.boot !== boot || owner.run_id !== grant.run_id || !session || session.port !== port) throw new Error("ended generation");
		}
		if (!await proveBackend(grant, generation, port) || stopped) throw new Error("Registration rejected");
		const latestGrant = readGrant(config, grant.run_id);
		if (latestGrant.revoked || latestGrant.token !== grant.token || latestGrant.backendHost !== grant.backendHost) throw new Error("Registration rejected");
		if (session && current(generation) !== session) throw new Error("ended generation");
		if (!existsSync(ledger)) writeFileSync(ledger, JSON.stringify({
			boot,
			run_id: grant.run_id
		}), {
			flag: "wx",
			mode: 384
		});
		for (const other of sessions.values()) if (other.grant.run_id === grant.run_id && other.generation !== generation) retire(other.generation);
		if (session) session.expires = Date.now() + config.leaseMs;
		else sessions.set(generation, {
			grant,
			generation,
			port,
			expires: Date.now() + config.leaseMs,
			since: Date.now()
		});
		return { url: `${config.publicUrl ?? url}s/${generation}/` };
	};
	const registry = net.createServer((socket) => {
		if (peers.size >= 128) {
			socket.destroy();
			return;
		}
		peers.add(socket);
		let data = Buffer.alloc(0);
		let received = false;
		const timer = setTimeout(() => socket.destroy(), 5e3);
		socket.on("error", () => {});
		socket.once("close", () => {
			clearTimeout(timer);
			peers.delete(socket);
		});
		const reply = (ok, result, error = "Registration rejected") => {
			if (!socket.destroyed) socket.end(`${JSON.stringify(ok ? {
				ok,
				result
			} : {
				ok,
				error
			})}\n`);
		};
		socket.on("data", (chunk) => {
			if (received) return;
			data = Buffer.concat([data, chunk]);
			if (data.length > 8192) {
				received = true;
				reply(false);
				return;
			}
			const end = data.indexOf(10);
			if (end < 0) return;
			received = true;
			let value;
			try {
				value = JSON.parse(data.subarray(0, end).toString());
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
			} catch {
				reply(false);
				return;
			}
			pending = pending.then(async () => {
				if (socket.destroyed) return;
				try {
					reply(true, await register(value));
				} catch (error) {
					reply(false, void 0, error instanceof Error && error.message === "ended generation" ? "ended generation" : "Registration rejected");
				}
			});
		});
	});
	const allowedBrowser = (request, requireOrigin = false) => {
		const allowed = new Set([new URL(url).origin, ...config.publicUrl ? [new URL(config.publicUrl).origin] : []]);
		const hosts = new Set([...allowed].map((origin) => new URL(origin).host));
		const origin = request.headers.origin;
		return hosts.has(request.headers.host ?? "") && request.headers["sec-fetch-site"] !== "cross-site" && (origin === void 0 ? !requireOrigin : allowed.has(origin));
	};
	const matchRoute = (request) => /^\/s\/([a-f0-9]{32})(\/.*)?$/.exec(request.url ?? "");
	const fail = (response, code) => response.writeHead(code, { "Cache-Control": "no-store" }).end();
	const server = http.createServer(async (request, response) => {
		try {
			if (!allowedBrowser(request)) {
				fail(response, 403);
				return;
			}
			const route = matchRoute(request);
			if (route) {
				const session = current(route[1]);
				if (!session) {
					fail(response, 410);
					return;
				}
				if (!route[2]) {
					response.writeHead(308, {
						Location: `/s/${route[1]}/`,
						"Cache-Control": "no-store"
					}).end();
					return;
				}
				if (!await proveBackend(session.grant, session.generation, session.port)) {
					retire(session.generation);
					fail(response, 410);
					return;
				}
				if (stopped || current(session.generation) !== session || response.destroyed) {
					fail(response, 410);
					return;
				}
				const upstream = http.request({
					host: session.grant.backendHost,
					port: session.port,
					path: route[2],
					method: request.method,
					headers: backendHeaders(request, session),
					agent: false
				}, (result) => {
					const headers = { ...result.headers };
					delete headers["set-cookie"];
					delete headers.connection;
					response.writeHead(result.statusCode ?? 502, {
						...headers,
						"Cache-Control": "no-store"
					});
					result.on("error", () => response.destroy());
					result.pipe(response);
				});
				upstream.setTimeout(3e4, () => upstream.destroy());
				upstream.on("error", () => {
					if (!response.headersSent) fail(response, 502);
					else response.destroy();
				});
				response.once("close", () => upstream.destroy());
				request.pipe(upstream);
				return;
			}
			const pathname = request.url?.split("?")[0];
			if (!["GET", "HEAD"].includes(request.method ?? "")) {
				fail(response, 405);
				return;
			}
			if (pathname === "/") {
				response.writeHead(302, {
					Location: "/sessions/",
					"Cache-Control": "no-store"
				}).end();
				return;
			}
			if (pathname === "/api/sessions") {
				const items = [...sessions.keys()].map(current).filter((s) => Boolean(s)).map((s) => ({
					label: s.grant.label,
					generation: s.generation,
					path: `/s/${s.generation}/`,
					since: s.since
				}));
				response.writeHead(200, {
					"Content-Type": "application/json",
					"Cache-Control": "no-store"
				}).end(JSON.stringify({ sessions: items }));
				return;
			}
			const asset = pathname === "/sessions/" ? ["text/html", portalHtml] : pathname === "/hub.js" ? ["text/javascript", portalJs] : pathname === "/hub.css" ? ["text/css", portalCss] : void 0;
			if (!asset) {
				fail(response, pathname?.startsWith("/s/") ? 410 : 404);
				return;
			}
			response.writeHead(200, {
				"Content-Type": `${asset[0]}; charset=utf-8`,
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
				"Referrer-Policy": "no-referrer",
				"Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
			}).end(request.method === "HEAD" ? void 0 : asset[1]);
		} catch {
			if (!response.headersSent) fail(response, 500);
			else response.destroy();
		}
	});
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: 16 * 1024 * 1024
	});
	server.on("connection", (socket) => {
		connections.add(socket);
		socket.on("error", () => socket.destroy());
		socket.once("close", () => connections.delete(socket));
	});
	const rejectUpgrade = (socket, code) => {
		const timer = setTimeout(() => socket.destroy(), 500);
		timer.unref();
		socket.once("close", () => clearTimeout(timer));
		socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
	};
	server.on("upgrade", async (request, socket, head) => {
		try {
			if (!allowedBrowser(request, true)) {
				rejectUpgrade(socket, 403);
				return;
			}
			const route = matchRoute(request);
			const session = route && route[2] === "/ws" ? current(route[1]) : void 0;
			if (!session || !await proveBackend(session.grant, session.generation, session.port) || stopped || current(session.generation) !== session) {
				rejectUpgrade(socket, 410);
				return;
			}
			const upstream = new WebSocket(`ws://${net.isIP(session.grant.backendHost) === 6 ? `[${session.grant.backendHost}]` : session.grant.backendHost}:${session.port}/ws`, {
				headers: backendHeaders(request, session),
				handshakeTimeout: 3e3,
				maxPayload: 16 * 1024 * 1024
			});
			webSockets.set(upstream, session.generation);
			socket.once("close", () => upstream.terminate());
			const handshakeError = () => {
				if (!socket.destroyed) rejectUpgrade(socket, 502);
			};
			upstream.once("error", handshakeError);
			upstream.once("close", () => webSockets.delete(upstream));
			upstream.once("open", () => {
				upstream.removeListener("error", handshakeError);
				upstream.on("error", () => socket.destroy());
				if (stopped || current(session.generation) !== session || socket.destroyed) {
					upstream.terminate();
					socket.destroy();
					return;
				}
				wss.handleUpgrade(request, socket, head, (client) => {
					webSockets.set(client, session.generation);
					const forward = (from, to) => {
						from.on("message", (data, binary) => {
							if (to.readyState !== WebSocket.OPEN) return;
							if (to.bufferedAmount > 8 * 1024 * 1024) {
								from.terminate();
								to.terminate();
								return;
							}
							to.send(data, { binary });
						});
						from.once("close", () => {
							webSockets.delete(from);
							to.terminate();
						});
						from.on("error", () => to.terminate());
					};
					forward(client, upstream);
					forward(upstream, client);
				});
			});
		} catch {
			rejectUpgrade(socket, 502);
		}
	});
	server.on("clientError", (_error, socket) => socket.destroy());
	const listen = (target, address, host) => new Promise((resolve, reject) => {
		target.once("error", reject);
		const ready = () => {
			target.removeListener("error", reject);
			resolve();
		};
		if (typeof address === "string") target.listen(address, ready);
		else target.listen(address, host, ready);
	});
	try {
		await listen(registry, config.socketPath);
		chmodSync(config.socketPath, 384);
		await listen(server, config.port, config.host);
		const port = server.address().port;
		url = `http://${config.host === "::1" ? "[::1]" : config.host}:${port}/`;
	} catch (error) {
		stopped = true;
		for (const peer of peers) peer.destroy();
		registry.close();
		server.close();
		throw error;
	}
	const sweep = setInterval(() => {
		for (const id of sessions.keys()) current(id);
	}, Math.min(1e3, config.leaseMs));
	sweep.unref();
	let closing;
	return {
		url,
		socketPath: config.socketPath,
		close() {
			if (closing) return closing;
			stopped = true;
			clearInterval(sweep);
			for (const id of sessions.keys()) retire(id);
			for (const peer of peers) peer.destroy();
			for (const connection of connections) connection.destroy();
			server.closeAllConnections();
			closing = Promise.all([
				new Promise((resolve) => server.close(() => resolve())),
				new Promise((resolve) => registry.close(() => resolve())),
				new Promise((resolve) => wss.close(() => resolve())),
				pending
			]).then(() => {});
			return closing;
		}
	};
}
//#endregion
//#region bin/pi-web-hub.mjs
var help = `Pi Web Hub — independent multi-session portal

  pi-web-hub init [--port 16180] [--public-url https://pi.example.com/]
  pi-web-hub serve
  pi-web-hub issue --label "Project A" --output /private/session-a.json [--backend-host 127.0.0.1]
  pi-web-hub revoke --run-id <session-capability-id>

All commands accept --config <file> (default ~/.pi/web-hub/config.json).
The hub never launches agents or deploys SSH/TLS/login. See docs/hub.md.
Mount only the runtime directory and the individual credential into a Pi container;
never expose the hub administrator state directory to agents.
`;
async function main(args) {
	const command = args.shift();
	if (!command || command === "--help" || command === "help") {
		process.stdout.write(help);
		return;
	}
	const permitted = new Map([
		["init", [
			"--config",
			"--port",
			"--public-url"
		]],
		["serve", ["--config"]],
		["issue", [
			"--config",
			"--label",
			"--output",
			"--backend-host"
		]],
		["revoke", ["--config", "--run-id"]]
	]).get(command);
	if (!permitted) throw new Error("Unknown hub command; use --help");
	const options = /* @__PURE__ */ new Map();
	while (args.length) {
		const key = args.shift();
		const value = args.shift();
		if (!permitted.includes(key) || options.has(key) || !value || value.startsWith("--")) throw new Error("Invalid hub arguments; use --help");
		options.set(key, value);
	}
	const configFile = path.resolve(options.get("--config") ?? process.env.PI_WEB_UI_HUB_CONFIG ?? path.join(homedir(), ".pi/web-hub/config.json"));
	if (command === "init") {
		const port = options.has("--port") ? Number(options.get("--port")) : 16180;
		if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid hub port");
		const publicUrl = options.get("--public-url");
		if (publicUrl !== void 0) {
			const { validatedPublicUrl } = await Promise.resolve().then(() => (init_connection_config(), connection_config_exports));
			if (new URL(validatedPublicUrl(publicUrl)).pathname !== "/") throw new Error("Hub public URL must use the domain root");
		}
		initializeHub(configFile, {
			port,
			...publicUrl ? { publicUrl } : {}
		});
		process.stdout.write(`${JSON.stringify({
			configured: true,
			configFile
		})}\n`);
		return;
	}
	const config = readHubConfig(configFile);
	if (command === "issue") {
		if (!options.has("--output") || !options.has("--label")) throw new Error("issue requires --output and --label");
		const credentialFile = path.resolve(options.get("--output"));
		const credential = issueSession(config, credentialFile, {
			label: options.get("--label"),
			backendHost: options.get("--backend-host")
		});
		process.stdout.write(`${JSON.stringify({
			runId: credential.run_id,
			credentialFile,
			socketPath: config.socketPath
		})}\n`);
	} else if (command === "revoke") {
		if (!options.has("--run-id")) throw new Error("revoke requires --run-id");
		revokeSession(config, options.get("--run-id"));
		process.stdout.write(`${JSON.stringify({ revoked: true })}\n`);
	} else if (command === "serve") {
		const hub = await startHub(config);
		process.stdout.write(`${JSON.stringify({
			localUrl: hub.url,
			portalUrl: `${config.publicUrl ?? hub.url}sessions/`,
			socketPath: hub.socketPath
		})}\n`);
		let closing = false;
		const stop = () => {
			if (closing) return;
			closing = true;
			hub.close().then(() => {
				process.exitCode = 0;
			}).catch(() => {
				process.exitCode = 1;
			});
		};
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
	} else throw new Error("Unknown hub command; use --help");
}
main(process.argv.slice(2)).catch(() => {
	process.stderr.write("Pi Web Hub failed. Check arguments, private file permissions, configuration and port/socket availability. Use --help.\n");
	process.exitCode = 1;
});
//#endregion
export {};
