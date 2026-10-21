#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import net, { Socket, isIP } from "node:net";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream";
import { constants as constants$1, createBrotliCompress, createGzip } from "node:zlib";
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
//#region hub/lifecycle.ts
function lifecycleConfig(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid lifecycle provider");
	const v = value;
	if (Object.keys(v).sort().join(",") !== "credentialFile,endpoint" || typeof v.endpoint !== "string" || typeof v.credentialFile !== "string" || !path.isAbsolute(v.credentialFile) || v.credentialFile.includes("\0")) throw new Error("Invalid lifecycle provider");
	const endpoint = new URL(v.endpoint);
	if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || !endpoint.port) throw new Error("Invalid lifecycle provider");
	return {
		endpoint: endpoint.origin,
		credentialFile: v.credentialFile
	};
}
var hex$5, text$1, GateLifecycle;
var init_lifecycle = __esmMin((() => {
	init_config();
	hex$5 = (v) => typeof v === "string" && /^[a-f0-9]{32}$/.test(v);
	text$1 = (v) => typeof v === "string" && v.length > 0 && v.length <= 256 && !/\p{Cc}/u.test(v);
	GateLifecycle = class {
		config;
		constructor(config) {
			this.config = lifecycleConfig(config);
		}
		async request(method, route, value) {
			const credential = readPrivateJson(this.config.credentialFile);
			if (!credential || typeof credential.token !== "string" || !/^[a-f0-9]{64}$/.test(credential.token)) throw new Error("Lifecycle provider unavailable");
			const body = value ? JSON.stringify(value) : void 0;
			return new Promise((resolve, reject) => {
				let done = false;
				const finish = (result) => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					request.destroy();
					if (result) resolve(result);
					else reject(/* @__PURE__ */ new Error("Lifecycle provider rejected or unavailable"));
				};
				const request = http.request(new URL(route, this.config.endpoint), {
					method,
					agent: false,
					headers: {
						Authorization: `Bearer ${credential.token}`,
						"Content-Type": "application/json",
						...body ? { "Content-Length": Buffer.byteLength(body) } : {}
					}
				}, (response) => {
					if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
						finish();
						return;
					}
					let raw = Buffer.alloc(0);
					response.on("data", (chunk) => {
						raw = Buffer.concat([raw, chunk]);
						if (raw.length > 16384) finish();
					});
					response.on("error", () => finish());
					response.on("end", () => {
						try {
							const result = JSON.parse(raw.toString("utf8"));
							if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
							finish(result);
						} catch {
							finish();
						}
					});
				});
				const timer = setTimeout(() => finish(), 5e3);
				request.on("error", () => finish());
				request.end(body);
			});
		}
		async target(runId) {
			if (!hex$5(runId)) throw new Error("Invalid lifecycle identity");
			const value = await this.request("GET", `/v1/pi-lifecycle/runs/${runId}`);
			if (value.managed === false) return { managed: false };
			if (value.managed !== true || value.run_id !== runId || !text$1(value.runtime_id) || !text$1(value.session_id) || value.leaf_id !== null && !text$1(value.leaf_id) || !text$1(value.version) || typeof value.idle !== "boolean" || typeof value.pending !== "boolean" || typeof value.busy !== "boolean" || ![
				"auto",
				"manual",
				"disabled"
			].includes(value.mode)) throw new Error("Invalid lifecycle target");
			return {
				managed: true,
				run_id: runId,
				runtime_id: value.runtime_id,
				session_id: value.session_id,
				leaf_id: value.leaf_id,
				version: value.version,
				idle: value.idle,
				pending: value.pending,
				busy: value.busy,
				mode: value.mode
			};
		}
		job(value) {
			if (!hex$5(value.id) || !hex$5(value.run_id) || typeof value.status !== "string" || ![
				"pending",
				"queued",
				"running",
				"succeeded",
				"failed",
				"recovery_required",
				"rejected",
				"stale"
			].includes(value.status) || typeof value.stage !== "string" || !/^[a-z_]{1,64}$/.test(value.stage)) throw new Error("Invalid lifecycle result");
			const result = {
				id: value.id,
				run_id: value.run_id,
				status: value.status,
				stage: value.stage
			};
			if (value.started_at !== void 0) {
				if (!Number.isSafeInteger(value.started_at) || Number(value.started_at) <= 0 || Number(value.started_at) > Date.now() + 5e3) throw new Error("Invalid lifecycle start time");
				result.started_at = Number(value.started_at);
			} else if (value.status === "running" || value.status === "succeeded") throw new Error("Missing lifecycle start time");
			for (const key of [
				"runtime_id",
				"session_id",
				"old_runtime_id",
				"new_runtime_id",
				"old_version",
				"expected_version",
				"new_version"
			]) if (value[key] !== void 0) {
				if (!text$1(value[key])) throw new Error("Invalid lifecycle result");
				result[key] = value[key];
			}
			if (value.leaf_id !== void 0) {
				if (value.leaf_id !== null && !text$1(value.leaf_id)) throw new Error("Invalid lifecycle result");
				result.leaf_id = value.leaf_id;
			}
			return result;
		}
		async restart(value) {
			if (Object.keys(value).sort().join(",") !== "idempotency_key,leaf_id,run_id,runtime_id,session_id" || !hex$5(value.run_id) || !hex$5(value.idempotency_key) || !text$1(value.runtime_id) || !text$1(value.session_id) || value.leaf_id !== null && !text$1(value.leaf_id)) throw new Error("Invalid lifecycle request");
			const result = this.job(await this.request("POST", "/v1/pi-lifecycle/restarts", value));
			if (result.run_id !== value.run_id) throw new Error("Lifecycle target changed");
			return result;
		}
		async operation(id) {
			if (!hex$5(id)) throw new Error("Invalid lifecycle identity");
			const job = this.job(await this.request("GET", `/v1/pi-lifecycle/restarts/${id}`));
			if (job.id !== id) throw new Error("Lifecycle operation changed");
			return job;
		}
	};
}));
//#endregion
//#region hub/state-budget.ts
function privateStat(stat) {
	if (process.platform !== "win32" && ((Number(stat.mode) & 63) !== 0 || stat.uid !== process.getuid?.())) throw new Error("Unsafe private Hub state");
}
function privateStateDirectory(directory) {
	const created = mkdirSync(directory, {
		recursive: true,
		mode: 448
	});
	const stat = lstatSync(directory);
	privateStat(stat);
	if (!stat.isDirectory()) throw new Error("Unsafe private Hub directory");
	if (created) {
		const parent = path.dirname(path.resolve(created));
		for (let current = path.resolve(directory);; current = path.dirname(current)) {
			syncDirectory(current);
			if (current === parent) break;
		}
	}
}
function readStateJson(file) {
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		privateStat(stat);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192) throw new Error("Invalid private Hub file");
		return JSON.parse(readFileSync(fd, "utf8"));
	} finally {
		closeSync(fd);
	}
}
function syncDirectory(directory) {
	const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
/** Empty directory locks are never stolen, even after a crash. No PID guessing. */
function acquireStateLock(config, name) {
	privateStateDirectory(config.stateDir);
	const root = realpathSync(config.stateDir);
	const lock = path.join(root, name);
	try {
		mkdirSync(lock, { mode: 448 });
	} catch {
		throw new Error("Hub state lock busy; trusted recovery may be required");
	}
	const identity = lstatSync(lock);
	let released = false;
	return {
		root,
		release() {
			if (released) return;
			try {
				const current = lstatSync(lock);
				if (current.ino !== identity.ino || current.dev !== identity.dev) throw new Error("Hub lock ownership changed");
				rmdirSync(lock);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			released = true;
		}
	};
}
function exportCharge(value) {
	const bytes = value?.exportBytes ?? 0;
	if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 8192) throw new Error("Invalid export reservation");
	return bytes;
}
function scan(root) {
	const totals = {
		logicalBytes: 0,
		files: 0,
		activeGrants: 0,
		revokedGrants: 0,
		generationFiles: 0,
		receiptFiles: 0,
		exportReservedBytes: 0
	};
	let entries = 0;
	const visit = (directory, depth) => {
		if (depth > 4) throw new StateBudgetError();
		const dir = opendirSync(directory);
		try {
			for (let item = dir.readSync(); item; item = dir.readSync()) {
				if (++entries > SCAN_ENTRIES) throw new StateBudgetError();
				const file = path.join(directory, item.name);
				const stat = lstatSync(file);
				privateStat(stat);
				if (stat.isDirectory()) {
					visit(file, depth + 1);
					continue;
				}
				if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe private Hub state");
				totals.files++;
				totals.logicalBytes += stat.size;
				const relative = path.relative(root, file);
				if (/^grants\/[a-f0-9]{32}\.json$/.test(relative)) {
					const grant = readStateJson(file);
					if (grant.revoked !== void 0 && typeof grant.revoked !== "boolean") throw new Error("Invalid grant state");
					if (grant.revoked) totals.revokedGrants++;
					else totals.activeGrants++;
					const charge = exportCharge(grant);
					totals.exportReservedBytes += charge;
					totals.logicalBytes += charge;
				}
				if (/^(generations|bounded)\//.test(relative)) totals.generationFiles++;
				if (relative.startsWith("restarts/")) totals.receiptFiles++;
			}
		} finally {
			dir.closeSync();
		}
	};
	visit(root, 0);
	return totals;
}
function withStateWriter(config, operation) {
	const lock = acquireStateLock(config, ".writer.lock");
	try {
		const result = operation(new StateWriter(lock.root));
		if (result && typeof result.then === "function") throw new Error("Hub writer cannot cross an await");
		return result;
	} finally {
		lock.release();
	}
}
/** Grant must already be durable and charged before publishing an export. */
function publishCredential(file, credential) {
	const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 384);
	try {
		writeFileSync(fd, `${JSON.stringify(credential)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	syncDirectory(path.dirname(file));
}
var STATE_LIMIT, SECURITY_RESERVE, SCAN_ENTRIES, StateBudgetError, StateWriter, storageDiagnostics;
var init_state_budget = __esmMin((() => {
	STATE_LIMIT = 8 * 1024 * 1024;
	SECURITY_RESERVE = 64 * 1024;
	SCAN_ENTRIES = 32768;
	StateBudgetError = class extends Error {
		constructor() {
			super("Hub state quota exceeded");
		}
	};
	StateWriter = class {
		totals;
		root;
		constructor(root) {
			this.root = root;
		}
		/** Also fence authority-only transitions, such as legacy lease renewal. */
		assertAdmission() {
			this.totals ??= scan(this.root);
			if (this.totals.activeGrants > 512 || this.totals.logicalBytes > 8388608) throw new StateBudgetError();
		}
		destination(relative) {
			if (!/^(?:grants\/[a-f0-9]{32}\.json|generations\/[a-f0-9]{32}\.json|bounded\/[a-f0-9]{32}\.json|restarts\/[a-f0-9]{32}(?:\.started|\.verified)?\.json|management\.json|terminal-auth\.json|registry\.json)$/.test(relative)) throw new Error("Invalid Hub state destination");
			const file = path.join(this.root, relative);
			privateStateDirectory(path.dirname(file));
			return file;
		}
		write(relative, value, options = {}) {
			const file = this.destination(relative);
			const data = Buffer.from(`${JSON.stringify(value)}\n`);
			if (data.length > 8192) throw new StateBudgetError();
			let oldBytes = 0;
			let old;
			let exists = false;
			try {
				const stat = lstatSync(file);
				privateStat(stat);
				if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe private Hub file");
				exists = true;
				oldBytes = stat.size;
				old = readStateJson(file);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			if (options.exclusive && exists) throw new Error("Hub state already exists");
			this.totals ??= scan(this.root);
			const totals = this.totals;
			const isGrant = relative.startsWith("grants/");
			const oldCharge = isGrant && exists ? exportCharge(old) : 0;
			const newCharge = isGrant ? exportCharge(value) : 0;
			const activeDelta = isGrant ? Number(!value.revoked) - Number(exists && !old?.revoked) : 0;
			const peak = totals.logicalBytes + data.length + Math.max(0, newCharge - oldCharge);
			const ceiling = options.security ? STATE_LIMIT : STATE_LIMIT - SECURITY_RESERVE;
			const revocation = options.security && isGrant && activeDelta === -1 && value.revoked === true && JSON.stringify(value) === JSON.stringify({
				...old,
				revoked: true
			});
			if (peak > ceiling || (totals.activeGrants > 512 || totals.activeGrants + activeDelta > 512) && !revocation) throw new StateBudgetError();
			const temporary = path.join(path.dirname(file), `.write-${randomBytes(16).toString("hex")}`);
			const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 384);
			try {
				writeFileSync(fd, data);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			if (options.exclusive) {
				linkSync(temporary, file);
				unlinkSync(temporary);
			} else renameSync(temporary, file);
			syncDirectory(path.dirname(file));
			totals.logicalBytes += data.length - oldBytes + newCharge - oldCharge;
			totals.activeGrants += activeDelta;
			this.totals = void 0;
		}
		diagnostics() {
			const totals = scan(this.root);
			return {
				...totals,
				limitBytes: STATE_LIMIT,
				activeGrantLimit: 512,
				securityReserveBytes: SECURITY_RESERVE,
				overBudget: totals.logicalBytes > 8388608 || totals.activeGrants > 512
			};
		}
	};
	storageDiagnostics = (config) => withStateWriter(config, (writer) => writer.diagnostics());
}));
//#endregion
//#region hub/terminal-contract.ts
function record$1(value, keys) {
	return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys;
}
function terminalId(value) {
	return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}
function identityText(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\p{Cc}\p{Cs}]/u.test(value);
}
function parseTerminalTarget(value) {
	if (!record$1(value, "inputState,managedRestartEligible,profile,runId,runtimeId,sessionId,terminalEpoch,v") || value.v !== 1 || !terminalId(value.runId) || !identityText(value.runtimeId) || !identityText(value.sessionId) || !terminalId(value.terminalEpoch) || value.profile !== "web-terminal-v1" || value.managedRestartEligible !== false || ![
		"local",
		"none",
		"remote",
		"fenced"
	].includes(value.inputState)) throw new Error("Invalid terminal target");
	return {
		v: 1,
		runId: value.runId,
		runtimeId: value.runtimeId,
		sessionId: value.sessionId,
		terminalEpoch: value.terminalEpoch,
		profile: "web-terminal-v1",
		inputState: value.inputState,
		managedRestartEligible: false
	};
}
function sameTerminal(left, right) {
	return left.runId === right.runId && left.runtimeId === right.runtimeId && left.sessionId === right.sessionId && left.terminalEpoch === right.terminalEpoch;
}
function validTerminalBinding(value) {
	return record$1(value, "authorizationId,connectionId") && terminalId(value.authorizationId) && terminalId(value.connectionId);
}
var init_terminal_contract = __esmMin((() => {}));
//#endregion
//#region hub/terminal-wire.ts
function exact(value, keys) {
	if (!record(value) || Object.keys(value).sort().join(",") !== keys) throw new Error("terminal_invalid_frame");
}
function terminalSize(columns, rows) {
	return Number.isInteger(columns) && Number(columns) >= 20 && Number(columns) <= 240 && Number.isInteger(rows) && Number(rows) >= 5 && Number(rows) <= 120;
}
/** Bounded JSON with duplicate-key, depth, nonfinite and lone-surrogate rejection. */
function parseTerminalJson(text) {
	if (textBytes(text) + 1 > 65536) throw new Error("terminal_invalid_frame");
	let at = 0;
	const space = () => {
		while (/[\t\r\n ]/.test(text[at] ?? "x")) at++;
	};
	const string = () => {
		const start = at++;
		while (at < text.length) {
			if (text[at] === "\\") {
				at += 2;
				continue;
			}
			if (text[at++] === "\"") {
				const result = JSON.parse(text.slice(start, at));
				if (/\p{Cs}/u.test(result)) throw new Error();
				return result;
			}
		}
		throw new Error();
	};
	const value = (depth) => {
		if (depth > 16) throw new Error();
		space();
		if (text[at] === "\"") return string();
		if (text[at] === "{") {
			at++;
			space();
			const result = Object.create(null);
			if (text[at] === "}") {
				at++;
				return result;
			}
			for (;;) {
				space();
				if (text[at] !== "\"") throw new Error();
				const key = string();
				space();
				if (text[at++] !== ":" || Object.hasOwn(result, key)) throw new Error();
				result[key] = value(depth + 1);
				space();
				const delimiter = text[at++];
				if (delimiter === "}") return result;
				if (delimiter !== ",") throw new Error();
			}
		}
		if (text[at] === "[") {
			at++;
			space();
			const result = [];
			if (text[at] === "]") {
				at++;
				return result;
			}
			for (;;) {
				result.push(value(depth + 1));
				space();
				const delimiter = text[at++];
				if (delimiter === "]") return result;
				if (delimiter !== ",") throw new Error();
			}
		}
		const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at))?.[0];
		if (!token) throw new Error();
		at += token.length;
		const result = JSON.parse(token);
		if (typeof result === "number" && !Number.isFinite(result)) throw new Error();
		return result;
	};
	try {
		const result = value(0);
		space();
		if (at !== text.length || !record(result)) throw new Error();
		return result;
	} catch {
		throw new Error("terminal_invalid_frame");
	}
}
function parseTerminalRequest(frame) {
	if (!Number.isSafeInteger(frame.id) || Number(frame.id) < 1) throw new Error("terminal_invalid_request");
	if (frame.type === "acquire" || frame.type === "release") exact(frame, "id,type");
	else if (frame.type === "resize") {
		exact(frame, "columns,id,leaseId,rows,type");
		if (!terminalId(frame.leaseId) || !terminalSize(frame.columns, frame.rows)) throw new Error("terminal_invalid_request");
	} else {
		exact(frame, "data,id,leaseId,sequence,terminalEpoch,type,v");
		if (frame.v !== 1 || frame.type !== "input" || !terminalId(frame.terminalEpoch) || !terminalId(frame.leaseId) || !Number.isSafeInteger(frame.sequence) || Number(frame.sequence) < 1 || typeof frame.data !== "string" || !frame.data || /\p{Cs}/u.test(frame.data) || textBytes(frame.data) > 8192) throw new Error("terminal_invalid_request");
	}
	return frame;
}
function parseTerminalResult(action, result) {
	if (!record(result)) throw new Error("terminal_invalid_result");
	if (action === "acquire") if (result.ok === true) {
		exact(result, "expiresInMs,leaseId,ok");
		if (!terminalId(result.leaseId) || result.expiresInMs !== 3e4) throw new Error();
	} else {
		exact(result, "error,ok");
		if (result.ok !== false || !["local_owns_input", "control_unavailable"].includes(String(result.error))) throw new Error();
	}
	else if (action === "input") if (result.ok === true) {
		exact(result, "delivery,ok");
		if (result.delivery !== "written") throw new Error();
	} else {
		exact(result, "delivery,error,ok");
		if (result.ok !== false || !(result.delivery === "unknown" && result.error === "input_delivery_unknown") && !(result.delivery === "rejected" && result.error === "input_rejected")) throw new Error();
	}
	else if (action === "release") {
		exact(result, "ok");
		if (result.ok !== true) throw new Error();
	} else if (result.error === void 0) {
		exact(result, "ok");
		if (typeof result.ok !== "boolean") throw new Error();
	} else {
		exact(result, "error,ok");
		if (result.ok !== false || !["resize_rejected", "resize_unknown"].includes(String(result.error))) throw new Error();
	}
	return result;
}
var TERMINAL_FRAME_BYTES, utf8, textBytes, record, TerminalSnapshotAssembly;
var init_terminal_wire = __esmMin((() => {
	init_terminal_contract();
	TERMINAL_FRAME_BYTES = 65536;
	utf8 = new TextEncoder();
	textBytes = (value) => utf8.encode(value).length;
	record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
	TerminalSnapshotAssembly = class {
		current;
		sequence = -1;
		target;
		constructor(target) {
			this.target = target;
		}
		clear() {
			this.current = void 0;
		}
		accept(frame) {
			if (frame.type === "screen-start") {
				exact(frame, "bytes,chunks,columns,rows,sequence,target,type");
				if (this.current || !sameTerminal(parseTerminalTarget(frame.target), this.target) || !Number.isSafeInteger(frame.sequence) || Number(frame.sequence) <= this.sequence || !terminalSize(frame.columns, frame.rows) || !Number.isInteger(frame.bytes) || Number(frame.bytes) < 0 || Number(frame.bytes) > 1048576 || frame.chunks !== Math.ceil(Number(frame.bytes) / 20480)) throw new Error("terminal_invalid_snapshot");
				this.current = {
					sequence: Number(frame.sequence),
					columns: Number(frame.columns),
					rows: Number(frame.rows),
					bytes: new Uint8Array(Number(frame.bytes)),
					chunks: Number(frame.chunks),
					index: 0,
					offset: 0
				};
				return;
			}
			const current = this.current;
			if (!current || frame.terminalEpoch !== this.target.terminalEpoch || frame.sequence !== current.sequence) throw new Error("terminal_invalid_snapshot");
			if (frame.type === "screen-chunk") {
				exact(frame, "data,index,sequence,terminalEpoch,type");
				if (frame.index !== current.index || current.index >= current.chunks || typeof frame.data !== "string" || frame.data.length > 27308 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) throw new Error("terminal_invalid_snapshot");
				const binary = atob(frame.data);
				if (btoa(binary) !== frame.data || binary.length !== Math.min(20480, current.bytes.length - current.offset)) throw new Error("terminal_invalid_snapshot");
				for (let i = 0; i < binary.length; i++) current.bytes[current.offset++] = binary.charCodeAt(i);
				current.index++;
				return;
			}
			exact(frame, "sequence,terminalEpoch,type");
			if (frame.type !== "screen-end" || current.index !== current.chunks || current.offset !== current.bytes.length) throw new Error("terminal_invalid_snapshot");
			const data = new TextDecoder("utf-8", { fatal: true }).decode(current.bytes);
			if (/\p{Cs}/u.test(data)) throw new Error("terminal_invalid_snapshot");
			this.sequence = current.sequence;
			this.current = void 0;
			return {
				sequence: current.sequence,
				columns: current.columns,
				rows: current.rows,
				data
			};
		}
	};
}));
//#endregion
//#region hub/terminal-provider.ts
/** Dedicated read-only secret mount only; never loosens the generic 0600 reader. */
function readTerminalProviderSecret(file) {
	if (!path.isAbsolute(file) || realpathSync(file) !== file) throw unavailable();
	const parent = lstatSync(path.dirname(file));
	const uid = process.getuid?.();
	if (!parent.isDirectory() || parent.isSymbolicLink()) throw unavailable();
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		const local = stat.uid === uid && (stat.mode & 4095) === 384 && parent.uid === uid && (parent.mode & 63) === 0;
		const mounted = stat.uid === 0 && stat.gid === 1e3 && (stat.mode & 4095) === 416 && parent.uid === 0 && parent.gid === 1e3 && (parent.mode & 4095) === 1528;
		if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 64 || !local && !mounted) throw unavailable();
		if (mounted && (process.platform !== "linux" || !readFileSync("/proc/self/mountinfo", "utf8").split("\n").some((line) => {
			const fields = line.split(" ");
			return fields[4] === path.dirname(file).replaceAll(" ", "\\040") && fields[5]?.split(",").includes("ro");
		}))) throw unavailable();
		let ancestor = path.dirname(path.dirname(file));
		for (;;) {
			const directory = lstatSync(ancestor);
			if (!directory.isDirectory() || directory.isSymbolicLink() || ![0, uid].includes(directory.uid) || (directory.mode & 18) !== 0 && !(directory.uid === 0 && directory.mode & 512)) throw unavailable();
			if (ancestor === path.dirname(ancestor)) break;
			ancestor = path.dirname(ancestor);
		}
		const token = readFileSync(fd, "utf8");
		if (!/^[a-f0-9]{64}$/.test(token)) throw unavailable();
		return token;
	} finally {
		closeSync(fd);
	}
}
function terminalProviderConfig(value) {
	exact(value, "credentialFile,socketPath");
	for (const key of ["socketPath", "credentialFile"]) if (typeof value[key] !== "string" || !path.isAbsolute(value[key]) || value[key].includes("\0") || path.normalize(value[key]) !== value[key]) throw unavailable();
	return {
		socketPath: value.socketPath,
		credentialFile: value.credentialFile
	};
}
async function terminalProviderStatus(config, runId) {
	if (!terminalId(runId)) throw unavailable();
	const client = new ProviderConnection(terminalProviderConfig(config), {
		v: 1,
		op: "status",
		runId
	});
	try {
		return await client.ready;
	} finally {
		client.close();
	}
}
async function connectTerminalProvider(config, value, scope, binding, callbacks) {
	const target = parseTerminalTarget(value);
	if (!["read", "write"].includes(scope) || !validTerminalBinding(binding)) throw unavailable();
	const client = new ProviderConnection(terminalProviderConfig(config), {
		v: 1,
		op: "connect",
		target,
		scope,
		binding
	}, callbacks);
	try {
		await client.ready;
		return client;
	} catch {
		client.close();
		throw unavailable();
	}
}
var unavailable, active, ProviderConnection;
var init_terminal_provider = __esmMin((() => {
	init_terminal_contract();
	init_terminal_wire();
	unavailable = () => /* @__PURE__ */ new Error("terminal_backend_unavailable");
	active = /* @__PURE__ */ new Set();
	ProviderConnection = class {
		ready;
		socket;
		buffer = Buffer.alloc(0);
		partialAt = 0;
		startedAt = Date.now();
		readyTarget;
		assembly;
		closed = false;
		lastId = 0;
		pending = /* @__PURE__ */ new Map();
		resolveReady;
		rejectReady;
		timer;
		abort = () => this.close();
		opening;
		callbacks;
		constructor(config, opening, callbacks) {
			this.opening = opening;
			this.callbacks = callbacks;
			if (active.size >= 8) throw unavailable();
			const token = readTerminalProviderSecret(config.credentialFile);
			this.ready = new Promise((resolve, reject) => {
				this.resolveReady = resolve;
				this.rejectReady = reject;
			});
			this.socket = new Socket({ onread: {
				buffer: Buffer.alloc(32768),
				callback: (length, buffer) => {
					const chunk = Buffer.from(buffer.subarray(0, length));
					this.consume(chunk).then(() => {
						if (!this.closed) this.socket.resume();
					}).catch(() => this.close());
					return false;
				}
			} });
			active.add(this.socket);
			this.timer = setInterval(() => {
				const now = Date.now();
				if (!this.readyTarget && now - this.startedAt >= 2e3 || this.partialAt && now - this.partialAt >= 2e3 || now - this.startedAt >= 3e5) this.close();
			}, 20);
			this.timer.unref();
			this.socket.once("connect", () => this.write({
				...opening,
				token
			}));
			this.socket.on("error", () => this.close());
			this.socket.on("end", () => this.close());
			this.socket.on("close", () => this.close());
			callbacks?.signal?.addEventListener("abort", this.abort, { once: true });
			if (callbacks?.signal?.aborted) this.close();
			else this.socket.connect(config.socketPath);
		}
		write(frame) {
			const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
			if (this.closed || bytes.length > 65536 || this.socket.writableLength + bytes.length > 262144) {
				this.close();
				return;
			}
			this.socket.write(bytes);
		}
		async consume(chunk) {
			let start = 0;
			while (!this.closed && start < chunk.length) {
				const newline = chunk.indexOf(10, start);
				const end = newline < 0 ? chunk.length : newline;
				if (this.buffer.length === 0 && end > start) this.partialAt = Date.now();
				if (this.buffer.length + end - start + 1 > 65536) throw unavailable();
				this.buffer = Buffer.concat([this.buffer, chunk.subarray(start, end)]);
				if (newline < 0) break;
				const text = new TextDecoder("utf-8", { fatal: true }).decode(this.buffer);
				const length = this.buffer.length + 1;
				this.buffer = Buffer.alloc(0);
				this.partialAt = 0;
				const frame = parseTerminalJson(text);
				if (frame.type === "screen-chunk" && length > 32768) throw unavailable();
				await this.frame(frame);
				start = newline + 1;
			}
		}
		async frame(frame) {
			if (!this.readyTarget) {
				exact(frame, "target,type");
				if (frame.type !== "ready") throw unavailable();
				const target = parseTerminalTarget(frame.target);
				if (this.opening.op === "status" ? target.runId !== this.opening.runId : !sameTerminal(target, this.opening.target)) throw unavailable();
				this.readyTarget = target;
				this.assembly = new TerminalSnapshotAssembly(target);
				this.resolveReady(target);
				if (this.opening.op === "status") this.close();
				return;
			}
			if (frame.type === "response") {
				exact(frame, "id,result,type");
				const pending = this.pending.get(Number(frame.id));
				if (!pending || frame.id !== Number(frame.id)) throw unavailable();
				const result = parseTerminalResult(pending.action, frame.result);
				clearTimeout(pending.timer);
				this.pending.delete(Number(frame.id));
				pending.resolve(result);
				return;
			}
			if (frame.type === "screen-unavailable") {
				exact(frame, "type");
				this.assembly?.clear();
				this.callbacks?.onUnavailable();
				return;
			}
			const snapshot = this.assembly?.accept(frame);
			if (snapshot) {
				let timer;
				try {
					await Promise.race([this.callbacks?.onSnapshot(snapshot), new Promise((_, reject) => {
						timer = setTimeout(() => reject(unavailable()), 2e3);
					})]);
				} finally {
					clearTimeout(timer);
				}
			}
		}
		request(value) {
			const frame = parseTerminalRequest(value);
			if (this.closed || !this.readyTarget || this.opening.scope !== "write" || frame.id <= this.lastId || this.pending.size >= 64) return Promise.reject(unavailable());
			this.lastId = frame.id;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => this.close(), 2e3);
				this.pending.set(frame.id, {
					action: frame.type,
					resolve,
					reject,
					timer
				});
				this.write(frame);
			});
		}
		close() {
			if (this.closed) return;
			this.closed = true;
			clearInterval(this.timer);
			this.callbacks?.signal?.removeEventListener("abort", this.abort);
			active.delete(this.socket);
			this.buffer = Buffer.alloc(0);
			this.assembly?.clear();
			this.rejectReady(unavailable());
			this.socket.destroy();
			for (const pending of this.pending.values()) {
				clearTimeout(pending.timer);
				if (pending.action === "input") pending.resolve({
					ok: false,
					delivery: "unknown",
					error: "input_delivery_unknown"
				});
				else pending.reject(unavailable());
			}
			this.pending.clear();
			this.callbacks?.onUnavailable();
		}
	};
}));
//#endregion
//#region hub/config.ts
var config_exports = /* @__PURE__ */ __exportAll({
	initializeHub: () => initializeHub,
	issueSession: () => issueSession,
	managementConfig: () => managementConfig,
	privateDirectory: () => privateDirectory,
	readGrant: () => readGrant,
	readHubConfig: () => readHubConfig,
	readPrivateJson: () => readPrivateJson,
	revokeSession: () => revokeSession,
	terminalConfig: () => terminalConfig
});
function privateDirectory(directory) {
	privateStateDirectory(directory);
}
function readPrivateJson(file) {
	return readStateJson(file);
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
	const lifecycle = value.lifecycle === void 0 ? void 0 : lifecycleConfig(value.lifecycle);
	const runtimeUpdates = value.runtimeUpdates === void 0 ? void 0 : lifecycleConfig(value.runtimeUpdates);
	const management = value.management === void 0 ? void 0 : managementConfig(value.management, port, publicUrl);
	const terminal = value.terminal === void 0 ? void 0 : terminalConfig(value.terminal, port, publicUrl, management);
	return {
		stateDir,
		runtimeDir,
		socketPath: path.join(runtimeDir, "registry.sock"),
		host,
		port,
		leaseMs,
		publicUrl,
		...lifecycle ? { lifecycle } : {},
		...runtimeUpdates ? { runtimeUpdates } : {},
		...management ? { management } : {},
		...terminal ? { terminal } : {}
	};
}
/** Separate listener and authorization domain; no terminal backend is implied. */
function terminalConfig(value, chatPort, chatPublicUrl, management) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid terminal configuration");
	const v = value;
	if (Object.keys(v).some((key) => ![
		"port",
		"publicUrl",
		"provider"
	].includes(key)) || !Number.isInteger(v.port) || Number(v.port) < 0 || Number(v.port) > 65535 || v.port !== 0 && (v.port === chatPort || v.port === management?.port)) throw new Error("Terminal requires a distinct port");
	const publicUrl = v.publicUrl === void 0 ? void 0 : validatedPublicUrl(v.publicUrl);
	if (publicUrl && (!chatPublicUrl || !publicUrl.startsWith("https:") || new URL(publicUrl).pathname !== "/" || [chatPublicUrl, management?.publicUrl].some((other) => other && new URL(other).hostname === new URL(publicUrl).hostname))) throw new Error("Terminal requires a distinct canonical HTTPS origin");
	const provider = v.provider === void 0 ? void 0 : terminalProviderConfig(v.provider);
	return {
		port: Number(v.port),
		...publicUrl ? { publicUrl } : {},
		...provider ? { provider } : {}
	};
}
function managementConfig(value, chatPort, chatPublicUrl) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid management configuration");
	const v = value;
	if (Object.keys(v).some((key) => ![
		"port",
		"publicUrl",
		"gateway"
	].includes(key)) || !Number.isInteger(v.port) || Number(v.port) < 0 || Number(v.port) > 65535 || v.port !== 0 && v.port === chatPort) throw new Error("Management requires a distinct port");
	const publicUrl = v.publicUrl === void 0 ? void 0 : validatedPublicUrl(v.publicUrl);
	if (publicUrl && (!chatPublicUrl || new URL(publicUrl).pathname !== "/" || new URL(publicUrl).origin === new URL(chatPublicUrl).origin)) throw new Error("Management requires a distinct canonical public origin");
	let gateway;
	if (v.gateway !== void 0) {
		const g = v.gateway;
		if (!g || typeof g !== "object" || Array.isArray(g) || Object.keys(g).join(",") !== "credentialFile" || typeof g.credentialFile !== "string" || !path.isAbsolute(g.credentialFile) || g.credentialFile.includes("\0") || publicUrl && !publicUrl.startsWith("https:")) throw new Error("Invalid management gateway configuration");
		gateway = { credentialFile: g.credentialFile };
	}
	return {
		port: Number(v.port),
		...publicUrl ? { publicUrl } : {},
		...gateway ? { gateway } : {}
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
	if (grant.run_id !== runId || !/^[0-9a-f]{64}$/.test(grant.token) || typeof grant.label !== "string" || grant.label.length > 120 || hasControls(grant.label) || typeof grant.backendHost !== "string" || !validHost(grant.backendHost) || grant.revoked !== void 0 && typeof grant.revoked !== "boolean") throw new Error("Invalid session capability");
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
		backendHost,
		revoked: false,
		exportBytes: Buffer.byteLength(`${JSON.stringify(credential)}\n`)
	};
	const resolvedOutput = path.join(realpathSync(path.dirname(path.resolve(output))), path.basename(output));
	const stateRoot = realpathSync(config.stateDir);
	if (resolvedOutput === config.socketPath || resolvedOutput === stateRoot || resolvedOutput.startsWith(`${stateRoot}${path.sep}`)) throw new Error("Session credential must be outside the administrator state directory");
	withStateWriter(config, (writer) => {
		try {
			lstatSync(resolvedOutput);
			throw new Error("Credential output already exists");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		writer.write(`grants/${credential.run_id}.json`, grant, { exclusive: true });
		publishCredential(resolvedOutput, credential);
	});
	return credential;
}
function revokeSession(config, runId) {
	withStateWriter(config, (writer) => {
		const grant = readGrant(config, runId);
		if (!grant.revoked) writer.write(`grants/${runId}.json`, {
			...grant,
			revoked: true
		}, { security: true });
	});
}
var init_config = __esmMin((() => {
	init_connection_config();
	init_lifecycle();
	init_state_budget();
	init_terminal_provider();
}));
//#endregion
//#region hub/gateway-auth.ts
init_config();
/** Gateway proof is server-to-server only; never accept a browser identity header by itself. */
function gatewayIdentity(config, request) {
	const gateway = config.management?.gateway;
	if (!gateway) return void 0;
	try {
		const value = readPrivateJson(gateway.credentialFile);
		const proof = request.headers["x-pi-hub-gateway"];
		const user = request.headers["x-pi-hub-user"];
		if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "token" || typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token) || typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof) || typeof user !== "string" || !/^[\p{L}\p{N}_.@+-]{1,128}$/u.test(user) || !timingSafeEqual(Buffer.from(proof), Buffer.from(value.token))) return void 0;
		return createHash("sha256").update(`${proof}\0${user}`).digest("hex");
	} catch {
		return;
	}
}
//#endregion
//#region hub/management.ts
init_config();
init_state_budget();
var digest$1 = (value) => createHash("sha256").update(value).digest("hex");
var hex$4 = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
var equal$2 = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
var stateFile$1 = (config) => path.join(config.stateDir, "management.json");
function readState$1(config) {
	const file = stateFile$1(config);
	if (!existsSync(file)) return void 0;
	const value = readPrivateJson(file);
	if (!hex$4(value.epoch, 64) || value.pairHash !== null && !hex$4(value.pairHash, 64) || !Number.isSafeInteger(value.expires) || !Number.isInteger(value.failures) || value.failures < 0 || value.failures > 10) throw new Error("Management state unavailable");
	return value;
}
function saveState$1(writer, value, security = false) {
	writer.write("management.json", value, { security });
}
/** Trusted CLI only: return a short-lived code to its administrator's terminal. */
function issueManagementCode(config, now = Date.now()) {
	if (config.management?.gateway) throw new Error("Management uses the configured gateway login, not pairing codes");
	return withStateWriter(config, (writer) => {
		const code = randomBytes(16).toString("hex");
		const epoch = readState$1(config)?.epoch ?? randomBytes(32).toString("hex");
		const expires = now + 6e5;
		saveState$1(writer, {
			epoch,
			pairHash: digest$1(code),
			expires,
			failures: 0
		});
		return {
			code,
			expiresAt: expires
		};
	});
}
function revokeManagement(config) {
	withStateWriter(config, (writer) => saveState$1(writer, {
		epoch: randomBytes(32).toString("hex"),
		pairHash: null,
		expires: 0,
		failures: 0
	}, true));
}
/** Additional management privilege, deliberately separate from gateway/list access. */
var HubManagement = class {
	sessions = /* @__PURE__ */ new Map();
	config;
	now;
	secure;
	cookieName;
	constructor(config, now = Date.now) {
		this.config = config;
		this.now = now;
		this.secure = config.management?.publicUrl?.startsWith("https:") ?? false;
		this.cookieName = this.secure ? "__Host-pi-hub-management" : "pi_hub_management_local";
	}
	session(request) {
		const values = (request.headers.cookie ?? "").split(";").map((item) => item.trim()).filter((item) => item.startsWith(`${this.cookieName}=`));
		if (values.length !== 1) return void 0;
		const token = values[0].slice(this.cookieName.length + 1);
		if (!hex$4(token, 64)) return void 0;
		const key = digest$1(token);
		const session = this.sessions.get(key);
		let state;
		try {
			state = readState$1(this.config);
		} catch {
			return;
		}
		if (!session || session.expires <= this.now() || !state || session.epoch !== state.epoch || this.config.management?.gateway && session.gateway !== gatewayIdentity(this.config, request)) {
			this.sessions.delete(key);
			return;
		}
		return {
			key,
			...session
		};
	}
	status(request) {
		const session = this.session(request);
		return session ? {
			authorized: true,
			csrf: session.csrf,
			expiresAt: session.expires
		} : { authorized: false };
	}
	authorize(request, write = false) {
		const session = this.session(request);
		const csrf = request.headers["x-pi-hub-csrf"];
		if (!session || write && (typeof csrf !== "string" || !hex$4(csrf, 64) || !equal$2(csrf, session.csrf))) throw new Error("Management authorization required");
		return session;
	}
	revalidate(request, expected, write = false) {
		const current = this.authorize(request, write);
		if (current.key !== expected.key || current.epoch !== expected.epoch || current.csrf !== expected.csrf || current.expires !== expected.expires) throw new Error("Management authorization changed");
	}
	unlock(code) {
		if (this.config.management?.gateway) throw new Error("Gateway login required");
		return withStateWriter(this.config, (writer) => {
			const state = readState$1(this.config);
			if (!state || !state.pairHash || state.expires <= this.now() || state.failures >= 10) throw new Error("Management unlock rejected");
			if (!hex$4(code, 32) || !equal$2(digest$1(code), state.pairHash)) {
				saveState$1(writer, {
					...state,
					failures: state.failures + 1
				}, true);
				throw new Error("Management unlock rejected");
			}
			saveState$1(writer, {
				...state,
				pairHash: null,
				expires: 0
			}, true);
			return this.createSession(state);
		});
	}
	unlockGateway(request) {
		const identity = gatewayIdentity(this.config, request);
		if (!identity) throw new Error("Verified gateway login required");
		return withStateWriter(this.config, (writer) => {
			let state = readState$1(this.config);
			if (!state) {
				state = {
					epoch: randomBytes(32).toString("hex"),
					pairHash: null,
					expires: 0,
					failures: 0
				};
				saveState$1(writer, state);
			}
			return this.createSession(state, identity);
		});
	}
	createSession(state, gateway) {
		for (const [key, value] of this.sessions) if (value.expires <= this.now()) this.sessions.delete(key);
		if (this.sessions.size >= 64) throw new Error("Management unlock rejected");
		const token = randomBytes(32).toString("hex");
		const csrf = randomBytes(32).toString("hex");
		const expires = this.now() + 18e5;
		this.sessions.set(digest$1(token), {
			epoch: state.epoch,
			expires,
			csrf,
			...gateway ? { gateway } : {}
		});
		return {
			csrf,
			expiresAt: expires,
			cookie: this.cookie(token, 1800)
		};
	}
	logout(request) {
		const session = this.authorize(request, true);
		this.sessions.delete(session.key);
		return this.cookie("", 0);
	}
	cookie(token, maxAge) {
		return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secure ? "; Secure" : ""}`;
	}
};
//#endregion
//#region extensions/hub-generation.ts
var BOUNDED_PROTOCOL = "bounded-v2";
var BOUNDED_GENERATION_SOURCE = "b2-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{32}";
var HUB_GENERATION_SOURCE = `(?:[a-f0-9]{32}|${BOUNDED_GENERATION_SOURCE})`;
var bounded = new RegExp(`^${BOUNDED_GENERATION_SOURCE}$`);
var generation = new RegExp(`^${HUB_GENERATION_SOURCE}$`);
var sessionPath = new RegExp(`^/s/${HUB_GENERATION_SOURCE}/$`);
var isBoundedGeneration = (value) => typeof value === "string" && bounded.test(value);
var isHubGeneration = (value) => typeof value === "string" && generation.test(value);
var isHubSessionPath = (value) => typeof value === "string" && sessionPath.test(value);
//#endregion
//#region extensions/runtime-metadata.ts
/** Display/identity metadata, never proof that a container is authorized for control. */
function readRuntimeMetadata(value) {
	if (value === void 0) return void 0;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid runtime metadata");
	const v = value;
	const valid = (item) => typeof item === "string" && item.length > 0 && item.length <= 256 && !/\p{Cc}/u.test(item);
	if (Object.keys(v).sort().join(",") !== "leafId,managed,runtimeId,sessionId,version" || v.managed !== true || !valid(v.runtimeId) || !valid(v.sessionId) || v.leafId !== null && !valid(v.leafId) || !valid(v.version)) throw new Error("Invalid runtime metadata");
	return {
		runtimeId: v.runtimeId,
		sessionId: v.sessionId,
		leafId: v.leafId,
		version: v.version,
		managed: true
	};
}
//#endregion
//#region extensions/software-metadata.ts
var SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
var STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
var SHA256$1 = /^[a-f0-9]{64}$/;
function validSemver(value, stableOnly) {
	if (typeof value !== "string" || value.length > 64) return false;
	const match = (stableOnly ? STABLE_SEMVER : SEMVER).exec(value);
	if (!match) return false;
	if ([
		match[1],
		match[2],
		match[3]
	].some((part) => !Number.isSafeInteger(Number(part)))) return false;
	return !match[4] || match[4].split(".").every((part) => !/^\d+$/.test(part) || part === "0" || !part.startsWith("0"));
}
function isStableSemver(value) {
	return validSemver(value, true);
}
function isDisplayVersion(value) {
	return validSemver(value, false);
}
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
	return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
/** Validate only bounded display metadata; this is never an authorization identity. */
function readSoftwareMetadata(value) {
	if (value === void 0) return void 0;
	if (!isRecord$1(value) || !hasExactKeys(value, value.webUi === void 0 ? ["piVersion"] : ["piVersion", "webUi"]) || !isDisplayVersion(value.piVersion)) throw new Error("Invalid software metadata");
	const webUi = value.webUi;
	if (webUi === void 0) return Object.freeze({ piVersion: value.piVersion });
	if (!isRecord$1(webUi) || !hasExactKeys(webUi, webUi.build === void 0 ? ["version"] : ["version", "build"])) throw new Error("Invalid software metadata");
	if (!isStableSemver(webUi.version) || webUi.build !== void 0 && (typeof webUi.build !== "string" || !SHA256$1.test(webUi.build))) throw new Error("Invalid software metadata");
	return Object.freeze({
		piVersion: value.piVersion,
		webUi: Object.freeze({
			version: webUi.version,
			...webUi.build === void 0 ? {} : { build: webUi.build }
		})
	});
}
//#endregion
//#region hub/limits.ts
var HUB_LIMITS = Object.freeze({
	browserPairs: 8,
	connections: 128,
	registrationPeers: 64,
	registrationOperations: 32,
	backendProbes: 4,
	websocketCompression: 2,
	httpCompression: 2,
	inFlightBytes: 16 * 1024 * 1024,
	waitingBytes: 512 * 1024,
	waitingMessages: 512
});
//#endregion
//#region hub/asset-transfer.ts
var activeCompressors = 0;
function encoding(accept) {
	if (!accept) return;
	const qualities = /* @__PURE__ */ new Map();
	for (const part of accept.split(",")) {
		const [name, ...parameters] = part.trim().toLowerCase().split(";");
		const weight = parameters.find((value) => value.trim().startsWith("q="));
		const quality = weight === void 0 ? 1 : Number(weight.trim().slice(2));
		qualities.set(name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
	}
	const quality = (name) => qualities.get(name) ?? qualities.get("*") ?? 0;
	if (quality("br") > 0 && quality("br") >= quality("gzip")) return "br";
	if (quality("gzip") > 0) return "gzip";
}
/** Compress only public build assets, never reflected session/API/download data. */
function proxySessionResponse(request, response, upstream, resource) {
	const headers = { ...upstream.headers };
	delete headers["set-cookie"];
	delete headers.connection;
	for (const key of Object.keys(headers)) if (key.startsWith("x-pi-hub-")) delete headers[key];
	headers["cache-control"] = "no-store";
	const asset = /^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(js|css)$/.exec(resource);
	const mime = upstream.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
	const staticAsset = asset && (request.method === "GET" || request.method === "HEAD") && upstream.statusCode === 200 && !request.headers.range && !upstream.headers["cache-control"] && !upstream.headers["content-range"] && !upstream.headers["content-disposition"] && !upstream.headers["content-encoding"] && !upstream.headers["set-cookie"] && (asset[1] === "css" ? mime === "text/css" : mime === "application/javascript" || mime === "text/javascript");
	let coding;
	if (staticAsset) {
		headers["cache-control"] = "private, max-age=86400, immutable";
		const vary = (headers.vary ?? "").split(",").map((value) => value.trim()).filter(Boolean);
		if (!vary.some((value) => value === "*" || value.toLowerCase() === "accept-encoding")) vary.push("Accept-Encoding");
		headers.vary = vary.join(", ");
		coding = encoding(request.headers["accept-encoding"]);
		if (request.method !== "HEAD" && activeCompressors >= HUB_LIMITS.httpCompression) coding = void 0;
		if (coding) {
			headers["content-encoding"] = coding;
			for (const name of [
				"content-length",
				"etag",
				"content-md5",
				"digest"
			]) delete headers[name];
		}
	}
	upstream.once("error", () => response.destroy());
	response.writeHead(upstream.statusCode ?? 502, headers);
	if (request.method === "HEAD") {
		upstream.resume();
		response.end();
	} else if (coding) {
		activeCompressors++;
		pipeline(upstream, coding === "br" ? createBrotliCompress({ params: { [constants$1.BROTLI_PARAM_QUALITY]: 4 } }) : createGzip({ level: 6 }), response, (error) => {
			activeCompressors--;
			if (error) response.destroy();
		});
	} else upstream.pipe(response);
}
//#endregion
//#region hub/bounded-registry.ts
init_config();
var ZERO = "0000000000000000";
var hex$3 = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
var RegistryError = class extends Error {
	code;
	constructor(code = "ENDED_GENERATION") {
		super(code === "ENDED_GENERATION" ? "ended generation" : "Registration rejected");
		this.code = code;
	}
};
var relative = (runId) => {
	if (!hex$3(runId, 32)) throw new RegistryError("AUTH_FAILED");
	return `bounded/${runId}.json`;
};
var hasBoundedRecord = (config, runId) => existsSync(path.join(config.stateDir, relative(runId)));
function boundedRecord(config, runId, boot) {
	const file = path.join(config.stateDir, relative(runId));
	if (!existsSync(file)) return {
		schema: 2,
		run_id: runId,
		boot,
		slot: ZERO,
		revision: 0
	};
	const value = readPrivateJson(file);
	if (value.schema !== 2 || value.run_id !== runId || !hex$3(value.boot, 32) || !hex$3(value.slot, 16) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new RegistryError("STATE_UNAVAILABLE");
	for (const tuple of [value.current, value.pending]) {
		if (tuple === void 0) continue;
		if (!isBoundedGeneration(tuple.generation) || !tuple.generation.startsWith(`b2-${value.boot}-`) || tuple.generation.split("-")[2] > value.slot || !hex$3(tuple.request_id, 32) || !Number.isInteger(tuple.port) || tuple.port < 1 || tuple.port > 65535 || !Number.isSafeInteger(tuple.expires)) throw new RegistryError("STATE_UNAVAILABLE");
	}
	return value.boot === boot ? value : {
		schema: 2,
		run_id: runId,
		boot,
		slot: ZERO,
		revision: 0
	};
}
function saveBounded(writer, record, security = false) {
	if (!Number.isSafeInteger(record.revision + 1)) throw new RegistryError("STATE_UNAVAILABLE");
	record.revision++;
	writer.write(relative(record.run_id), record, { security });
}
function issueBounded(writer, record, value, live) {
	if (value.boot !== record.boot || !hex$3(value.slot, 16) || !hex$3(value.request_id, 32) || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) throw new RegistryError("ISSUANCE_STALE");
	const now = Date.now();
	const result = (tuple) => ({
		generation: tuple.generation,
		boot: record.boot,
		slot: tuple.generation.split("-")[2],
		expires: tuple.expires
	});
	const pending = record.pending;
	if (pending?.request_id === value.request_id && pending.port === value.port && pending.expires > now && BigInt(`0x${value.slot}`) + 1n === BigInt(`0x${record.slot}`)) return result(pending);
	if (value.slot !== record.slot) throw new RegistryError("ISSUANCE_STALE");
	if (pending && pending.expires > now) throw new RegistryError("REGISTRY_BUSY");
	if (record.slot === "ffffffffffffffff") throw new RegistryError("STATE_UNAVAILABLE");
	record.slot = (BigInt(`0x${record.slot}`) + 1n).toString(16).padStart(16, "0");
	record.pending = {
		generation: `b2-${record.boot}-${record.slot}-${randomBytes(16).toString("hex")}`,
		port: Number(value.port),
		request_id: value.request_id,
		expires: now + 5e3
	};
	if (record.current && !live(record.current.generation)) delete record.current;
	saveBounded(writer, record);
	return result(record.pending);
}
function boundedTuple(record, generation, port, live) {
	if (record.pending?.generation === generation && record.pending.port === port && record.pending.expires > Date.now()) return "pending";
	if (record.current?.generation === generation && record.current.port === port && live) return "current";
	throw new RegistryError();
}
//#endregion
//#region hub/forward-queue.ts
var size = (data) => typeof data === "string" ? Buffer.byteLength(data) : Array.isArray(data) ? data.reduce((sum, part) => sum + part.byteLength, 0) : data.byteLength;
/** One accounted send, plus a bounded unsent FIFO. No pending-send promises. */
var ForwardQueue = class {
	waiting = [];
	waitingBytes = 0;
	inFlight;
	closed = false;
	poll;
	deadline;
	socket;
	onSlow;
	constructor(socket, onSlow = () => {}) {
		this.socket = socket;
		this.onSlow = onSlow;
		socket.once("close", () => this.dispose());
		socket.once("error", () => this.dispose());
	}
	enqueue(data, binary = false) {
		if (this.closed || this.socket.readyState !== 1) return false;
		const bytes = size(data);
		if (bytes > HUB_LIMITS.inFlightBytes) return this.slow();
		if (!this.inFlight && !this.waiting.length && this.socket.bufferedAmount === 0) {
			this.send({
				data,
				binary,
				bytes
			});
			return !this.closed;
		}
		if (this.waitingBytes + bytes > HUB_LIMITS.waitingBytes || this.waiting.length >= HUB_LIMITS.waitingMessages) return this.slow();
		this.waitingBytes += bytes;
		this.waiting.push({
			data,
			binary,
			bytes
		});
		this.watch();
		return true;
	}
	snapshot() {
		return {
			inFlightBytes: this.inFlight?.bytes ?? 0,
			waitingBytes: this.waitingBytes,
			waitingMessages: this.waiting.length
		};
	}
	send(frame) {
		const flight = {
			bytes: frame.bytes,
			complete: false
		};
		this.inFlight = flight;
		this.watch();
		try {
			this.socket.send(frame.data, { binary: frame.binary }, (error) => {
				if (this.closed || this.inFlight !== flight) return;
				if (error) {
					this.slow();
					return;
				}
				flight.complete = true;
				this.drain();
			});
		} catch {
			this.slow();
		}
	}
	watch() {
		if (!this.poll) {
			this.poll = setInterval(() => this.drain(), 10);
			this.poll.unref();
		}
		if (!this.deadline) {
			this.deadline = setTimeout(() => this.slow(), 5e3);
			this.deadline.unref();
		}
	}
	drain() {
		if (this.closed || this.socket.bufferedAmount !== 0 || this.inFlight && !this.inFlight.complete) return;
		this.inFlight = void 0;
		clearTimeout(this.deadline);
		this.deadline = void 0;
		const frame = this.waiting.shift();
		if (frame) {
			this.waitingBytes -= frame.bytes;
			this.send(frame);
		} else {
			clearInterval(this.poll);
			this.poll = void 0;
		}
	}
	slow() {
		if (!this.closed) {
			this.dispose();
			this.socket.close(1013, "Slow consumer; reconnect");
			this.onSlow();
			const timer = setTimeout(() => this.socket.terminate(), 250);
			timer.unref();
			this.socket.once("close", () => clearTimeout(timer));
		}
		return false;
	}
	dispose() {
		this.closed = true;
		this.waiting = [];
		this.waitingBytes = 0;
		this.inFlight = void 0;
		clearInterval(this.poll);
		clearTimeout(this.deadline);
		this.poll = void 0;
		this.deadline = void 0;
	}
};
//#endregion
//#region hub/runtime-portal.ts
/** Browser source injected into the trusted management portal script. */
var runtimePortalJs = String.raw`
  const runtimeUpdates = (() => {
    const storageKey = 'pi-hub-runtime-update';
    const terminalStatuses = new Set(['succeeded', 'failed', 'recovery_required', 'rejected', 'stale', 'manual_restart_required']);
    const activeStatuses = new Set(['pending', 'queued', 'running']);
    const jobs = new Map();
    let policy;
    let pending;
    let uncertain = false;
    let polling;
    let submitting = false;
    const stableVersion = (value) => typeof value === 'string' && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value);
    const validId = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (saved && validId(saved.id) && stableVersion(saved.version)) pending = { id: saved.id, version: saved.version };
    } catch {}
    function configured() { return auth.runtimeUpdatesAvailable === true; }
    function savePending() {
      try {
        if (pending) {
          const value = JSON.stringify({ id: pending.id, version: pending.version });
          sessionStorage.setItem(storageKey, value);
          return sessionStorage.getItem(storageKey) === value;
        }
        sessionStorage.removeItem(storageKey);
        return sessionStorage.getItem(storageKey) === null;
      } catch { return false; }
    }
    function clearPending() { pending = undefined; uncertain = false; savePending(); }
    function isJob(value) {
      return value && validId(value.id) && stableVersion(value.version) && typeof value.status === 'string' && typeof value.stage === 'string' && Array.isArray(value.targets);
    }
    function remember(value) {
      if (!isJob(value)) return;
      jobs.set(value.id, value);
      if (pending?.id === value.id && terminalStatuses.has(value.status)) clearPending();
    }
    const stageLabel = (stage) => ({
      awaiting_approval: '等待宿主机审批', queued_by_policy: '按策略排队', approved_by_host: '宿主机已批准', policy_changed: '策略已变更',
      preparing: '准备安装', prepared: '安装准备完成', activating: '正在激活新版本', refreshing: '正在刷新受管 Pi 进程',
      waiting_for_idle: '等待忙碌目标空闲', waiting_for_consumer_readiness: '等待共享运行时使用者就绪',
      unmanaged_or_unavailable_consumer: '存在未受管或不可用的共享运行时使用者，需要迁移或检查',
      install_failed: '安装失败', installation_outcome_unknown: '安装结果不确定，需要管理员检查',
      refresh_requires_inspection: '刷新结果需要管理员检查', complete: '任务已完成',
      installed_manual_restart_required: '共享包已安装；终端需要手动退出并重新启动',
    })[stage] || String(stage || 'unknown').replaceAll('_', ' ');
    const statusLabel = (status) => ({
      pending: '等待处理', queued: '已排队', running: '任务进行中', succeeded: '安装成功；所有受管 Pi 进程已刷新或退出', failed: '安装失败',
      recovery_required: '结果不确定，需要管理员检查', rejected: '任务已拒绝', stale: '任务已过期',
      manual_restart_required: '共享包已安装；终端子进程尚未刷新，请手动退出并重新启动',
    })[status] || '结果未知';
    const targetLabel = (status) => ({
      waiting_for_idle: '等待目标空闲', refreshing: '正在刷新 Pi 进程', succeeded: '已加载新版本', exited: '已退出',
      manual_restart_required: '需要手动退出并重新启动；正在运行的子进程版本未知，未计为已刷新',
    })[status] || String(status || 'unknown').replaceAll('_', ' ');
    const reasonLabel = (reason) => ({
      consumer_not_ready: '共享运行时使用者尚未就绪', awaiting_state_change: '等待运行状态变化', busy_race: '空闲确认期间再次忙碌',
      terminal_profile_unaudited: '终端进程不允许受管重启',
    })[reason] || String(reason || '').replaceAll('_', ' ');
    function renderJob(value) {
      const row = document.createElement('div'); row.className = 'runtime-update-result';
      const heading = document.createElement('p'); heading.className = 'runtime-update-heading';
      heading.textContent = 'Pi ' + value.version + ' · ' + statusLabel(value.status);
      const identity = document.createElement('p'); identity.className = 'runtime-update-identity'; identity.textContent = '任务编号：' + value.id;
      const stage = document.createElement('p'); stage.textContent = '阶段：' + stageLabel(value.stage);
      row.append(heading, identity, stage);
      if (value.status === 'pending' && policy?.mode === 'manual') {
        const approval = document.createElement('p'); approval.textContent = '手动策略：请在主机使用 runtime-approve ' + value.id + ' 批准；本页面不会批准更新。'; row.append(approval);
      }
      if (value.status === 'recovery_required' && value.resolved !== true) {
        const unresolved = document.createElement('p'); unresolved.textContent = '此结果尚未解决，将阻止新的运行时更新任务；需要管理员检查并在 Gate 侧解决，本页面不会自动解决。'; row.append(unresolved);
      }
      const visibleTargets = [];
      for (const target of value.targets) if (target?.status !== 'exited' && visibleTargets.length < 128) visibleTargets.push(target);
      for (const target of value.targets) if (target?.status === 'exited' && visibleTargets.length < 128) visibleTargets.push(target);
      if (value.targets.length > 128) {
        const limit = document.createElement('p'); limit.textContent = '共' + value.targets.length + '个目标记录，仅显示前128条'; row.append(limit);
      }
      for (const target of visibleTargets) {
        if (!target || !validId(target.run_id) || typeof target.status !== 'string') continue;
        const line = document.createElement('p'); line.className = 'runtime-update-target';
        let text = '目标 ' + target.run_id + ' · ' + targetLabel(target.status);
        if (typeof target.old_version === 'string') text += ' · 原版本 ' + target.old_version;
        if (typeof target.version === 'string') text += ' · 当前版本 ' + target.version;
        if (['waiting_for_idle', 'manual_restart_required'].includes(target.status) && typeof target.wait_reason === 'string') text += ' · ' + reasonLabel(target.wait_reason);
        line.textContent = text; row.append(line);
      }
      return row;
    }
    function render() {
      const status = get('runtime-update-status');
      const policyNode = get('runtime-update-policy');
      const results = get('runtime-update-results');
      const query = get('runtime-update-query');
      results.replaceChildren(); query.hidden = true;
      if (!configured()) status.textContent = '运行时更新未配置';
      else if (!auth.authorized) status.textContent = '解锁管理后可提交运行时更新';
      else if (!policy) status.textContent = '正在查询运行时更新策略';
      else if (policy.mode === 'disabled') status.textContent = '运行时更新策略已禁用';
      else status.textContent = '运行时更新已就绪';
      policyNode.textContent = !policy ? '' : policy.mode === 'manual' ? '策略：手动审批（manual）' : policy.mode === 'auto' ? '策略：自动执行（auto）' : '策略：已禁用（disabled）';
      if (!auth.authorized) {
        policyNode.textContent = '';
        get('runtime-update-submit').disabled = true;
        return;
      }
      for (const value of jobs.values()) results.append(renderJob(value));
      if (pending && !jobs.has(pending.id)) {
        const unknown = document.createElement('div'); unknown.className = 'runtime-update-result';
        const summary = document.createElement('p'); summary.textContent = 'Pi ' + pending.version + ' · 结果不确定，尚未找到任务；不会重新提交。';
        const identity = document.createElement('p'); identity.textContent = '任务编号：' + pending.id; unknown.append(summary, identity); results.append(unknown);
        query.hidden = !uncertain;
      }
      const active = [...jobs.values()].some((value) => activeStatuses.has(value.status) || (value.status === 'recovery_required' && value.resolved !== true));
      get('runtime-update-submit').disabled = authTransition || !configured() || !policy || policy.mode === 'disabled' || active || !!pending || submitting;
    }
    async function lookupPending() {
      if (!pending || !auth.authorized || !configured()) return;
      const generation = authGeneration;
      const identity = pending;
      try {
        const result = await api('runtime-updates/' + identity.id);
        if (generation !== authGeneration || pending !== identity) return;
        if (isJob(result) && result.id === identity.id && result.version === identity.version) { uncertain = false; remember(result); }
        else { uncertain = true; notice('任务查询响应不完整；将保留原任务编号继续查询，不会重新提交。'); }
      } catch (error) {
        if (generation !== authGeneration || pending !== identity) return;
        uncertain = true;
        if (error.status !== 404) notice('暂时无法确认运行时更新任务；请保留任务编号并稍后按原编号查询。');
      }
      render();
    }
    async function poll() {
      const generation = authGeneration;
      if (polling === generation || !auth.authorized || !configured()) return;
      polling = generation;
      try {
        const result = await api('runtime-updates');
        if (generation !== authGeneration) return;
        policy = result?.policy && ['manual', 'auto', 'disabled'].includes(result.policy.mode) ? { mode: result.policy.mode } : undefined;
        jobs.clear();
        for (const value of [...(Array.isArray(result?.jobs) ? result.jobs : []), ...(Array.isArray(result?.active) ? result.active : [])].slice(0, 128)) remember(value);
        if (pending && !jobs.has(pending.id)) await lookupPending();
      } catch { if (generation === authGeneration) notice('暂时无法查询运行时更新状态。'); }
      finally { if (polling === generation) polling = undefined; if (generation === authGeneration) render(); }
    }
    get('runtime-update-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (get('runtime-update-submit').disabled) return;
      const version = get('runtime-update-version').value.trim();
      if (!stableVersion(version)) { notice('请输入精确稳定版本，例如 1.3.0；不接受 latest、范围、预发布版或构建标记。'); return; }
      const manual = policy?.mode === 'manual' ? '\n当前是手动策略；提交后仍需主机管理员使用 runtime-approve 批准。' : '';
      if (!window.confirm('确认向 Gate 提交 Pi ' + version + ' 的全局运行时更新任务？\n这会影响所有共享运行时使用者；忙碌目标会等待空闲，不会被强制中断。\n旧镜像中的使用者需要先迁移到受管运行环境。\n本页面只创建任务，不批准更新。' + manual)) return;
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, '0')).join('');
      pending = { id, version }; uncertain = true; submitting = true;
      if (!savePending()) {
        pending = undefined; uncertain = false; submitting = false;
        notice('未提交运行时更新：浏览器会话存储无法保存任务编号，请恢复存储后重试。'); render(); return;
      }
      render();
      const generation = authGeneration;
      try {
        const result = await api('runtime-updates', { version, idempotencyKey: id });
        if (generation !== authGeneration) return;
        if (isJob(result) && result.id === id && result.version === version) {
          uncertain = false; remember(result); notice('运行时更新任务已提交。请按任务编号监控安装与空闲等待。');
        } else {
          uncertain = true; notice('提交响应不完整，将按原任务编号查询；不会自动再次提交。');
        }
      } catch (error) {
        if (generation !== authGeneration) return;
        if (error.status === 400) { clearPending(); notice('版本无效或尚未通过审计；请输入 Gate 已审计的精确稳定版本。'); }
        else if (error.status === 409) { clearPending(); notice('Gate 正在处理其他任务，或运行时更新策略已禁用。'); }
        else notice('未收到确定的提交结果，将按原任务编号查询；不会自动再次提交。');
      } finally {
        submitting = false; render();
        if (generation === authGeneration) {
          if (pending && uncertain) await lookupPending();
          else if (!pending) await poll();
        }
      }
    });
    get('runtime-update-query').addEventListener('click', async () => { await lookupPending(); });
    function updateAuth() { render(); }
    function clearProtected() { jobs.clear(); policy = undefined; render(); }
    return { updateAuth, clearProtected, poll };
  })();
`;
//#endregion
//#region hub/portal.ts
var portalHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi · 会话总览</title><link rel="stylesheet" href="/hub.css"><script src="/hub-management.js" defer><\/script><script src="/hub.js" defer><\/script></head>
<body><main><header><a class="brand" href="/sessions/" aria-label="Pi 会话首页"><span class="logo">π</span> Pi Web <span class="tag">HUB</span></a><span id="health" role="status">正在连接</span></header>
<section class="intro"><span class="eyebrow">你的工作，随时接续</span><h1>所有会话，一个入口。</h1><p>选择正在运行的 Pi，在手机与电脑之间继续工作。</p></section>
<section class="version-overview" aria-labelledby="versions-title"><div class="version-heading"><div><span class="eyebrow">SOFTWARE STATUS</span><h2 id="versions-title">版本与更新</h2></div><span id="version-summary" role="status">正在检查发布版本</span></div><div id="version-details" class="version-details"></div><p class="version-help">仅检查 Pi 与本 Web 扩展的公开发布版本，不自动安装或重启。会话版本为进程上报值，不等于磁盘已安装版本。构建不同不一定代表落后；其他扩展不在本次检查范围。</p></section>
<details class="management"><summary>运行管理 <span id="management-status" role="status">正在检查能力</span></summary><p>管理操作需要身份验证。重启只刷新选中的空闲 Pi；全局运行时更新由 Gate 安装精确的已审计版本，两项操作彼此独立。</p><p id="management-help">正在检查管理登录方式…</p><form id="management-unlock" hidden><label for="management-code">一次性管理码</label><div class="controls"><input id="management-code" type="password" autocomplete="off" spellcheck="false" maxlength="32" placeholder="输入 32 位管理码" required><button type="submit">解锁管理</button></div></form><button id="management-gateway" type="button" hidden>使用网页登录解锁</button><button id="management-logout" type="button" hidden>锁定管理</button><p id="management-notice" role="status" aria-live="polite"></p><section class="runtime-updates" aria-labelledby="runtime-update-title"><div class="runtime-update-heading"><h3 id="runtime-update-title">全局 Pi 运行时更新</h3><span id="runtime-update-status" role="status">正在检查能力</span></div><p>向 Gate 提交精确稳定版本；不会重建 Docker 镜像，也不会在网页批准更新。更新影响所有共享运行时使用者，忙碌目标会等待空闲，旧镜像需要迁移后才能受管。</p><p id="runtime-update-policy"></p><form id="runtime-update-form"><label for="runtime-update-version">精确稳定版本</label><div class="controls"><input id="runtime-update-version" type="text" inputmode="text" autocomplete="off" spellcheck="false" maxlength="64" placeholder="例如 1.3.0" required><button id="runtime-update-submit" type="submit" disabled>提交给 Gate</button></div></form><button id="runtime-update-query" type="button" hidden>按原任务编号查询</button><div id="runtime-update-results" aria-live="polite"></div></section><section class="restart-results" aria-label="进程重启结果"><div id="management-results" aria-live="polite"></div></section></details>
<section class="toolbar" aria-label="会话操作"><div><h2>在线会话 <span id="count">0</span></h2><p id="updated">等待登记</p></div><div class="controls"><label><span class="sr-only">搜索会话</span><input id="search" type="search" placeholder="搜索项目或会话…"></label><button id="refresh" type="button">刷新</button></div></section>
<div id="notice" role="status"></div><section id="sessions" class="grid" aria-label="在线 Pi 会话"></section>
<section id="empty" class="empty" hidden><span class="empty-icon">π</span><h3>还没有在线会话</h3><p>为 Pi 配置本总管的登记 socket 和独立凭据。<br>已启动的会话会自动出现在这里。</p></section>
<footer><span>每个会话独立连接 · 退出一个不影响其他会话</span><span>Pi Web Hub</span></footer></main></body></html>`;
function renderPortalHtml(admin, chatUrl, managementUrl) {
	const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		"\"": "&quot;",
		"'": "&#39;"
	})[c] ?? c);
	if (admin) return portalHtml.replace("<head>", `<head><meta name="pi-chat-origin" content="${escapeHtml(chatUrl)}">`);
	return portalHtml.replace("<script src=\"/hub-management.js\" defer><\/script>", "").replace(/<details class="management">[\s\S]*?<\/details>/, managementUrl ? `<p class="management"><a href="${escapeHtml(managementUrl)}sessions/" rel="noopener noreferrer">打开运行管理 ↗</a></p>` : "");
}
var portalJs = `(() => {
  const get = (id) => document.getElementById(id);
  let items = [];
  let versions = { status: 'checking' };
  let loading = false;
  let refreshAgain = false;
  let lastRender = '';
  let navigationTimer;
  const resetNavigation = () => {
    clearTimeout(navigationTimer);
    for (const link of document.querySelectorAll('.open[aria-busy]')) {
      link.removeAttribute('aria-busy'); link.textContent = '打开会话 ↗';
    }
  };
  // Legacy launchers append a short run ID to the grant's project label.
  // Display-only: keep the original API label and capability route untouched.
  const projectLabel = (label) => label.replace(/ · [a-f0-9]{8}$/i, '').trim() || label;
  const element = (tag, className, text) => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const semver = (version) => {
    if (typeof version !== 'string' || version.length > 64 || !/^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$/.test(version)) return null;
    const parts = version.split('+')[0].split('.').map(Number); return parts.every(Number.isSafeInteger) ? parts : null;
  };
  function comparison(current, target, build) {
    if (!current) return { tone: 'unknown', text: '版本未上报' };
    if (!target) return { tone: 'unknown', text: '更新状态未知' };
    const a = semver(current.version); const b = semver(target.version);
    if (!a || !b) return { tone: 'unknown', text: '版本无法比较' };
    for (let i = 0; i < 3; i++) {
      if (a[i] < b[i]) return { tone: 'update', text: '可更新至 ' + target.version };
      if (a[i] > b[i]) return { tone: 'different', text: '高于发布版本' };
    }
    if (build) {
      if (!current.build || !target.build) return { tone: 'unknown', text: '构建未上报 · 无法确认一致' };
      if (current.build !== target.build) return { tone: 'different', text: '与发布构建不同' };
    }
    return { tone: 'current', text: '与发布版本一致' };
  }
  function versionLine(label, current, target, build) {
    const line = element('span', 'version-line', '');
    line.append(element('span', 'version-label', label));
    const value = element('span', 'version-value', current?.version || '未上报');
    if (current?.build) { value.textContent += ' · ' + current.build.slice(0, 8); value.title = '构建 SHA-256：' + current.build; }
    const result = comparison(current, target, build);
    const badge = element('span', 'version-badge ' + result.tone, result.text);
    if (result.tone === 'different') badge.title = '构建或版本不同不证明落后，可能来自本地修改、其他分支或较新开发版本。';
    else if (result.tone === 'update') badge.title = label === 'Pi' ? '检测到较新的公开稳定版本；安装和进程刷新仍需独立的更新流程。' : '检测到较新的包版本；更新安装不代表运行中的扩展或 Hub 已重新加载。';
    line.append(value, badge);
    return line;
  }
  function renderVersions() {
    const known = versions.status === 'ok' || versions.status === 'partial';
    const targetPi = known ? versions.pi : undefined;
    const targetWeb = known ? versions.webUi : undefined;
    let updates = 0; let differences = 0;
    for (const session of items) {
      const pi = session.software?.piVersion || session.runtime?.version;
      const states = [comparison(pi ? { version: pi } : undefined, targetPi, false), comparison(session.software?.webUi, targetWeb, true)];
      if (states.some((s) => s.tone === 'update')) updates++;
      if (states.some((s) => s.tone === 'different')) differences++;
    }
    const hubState = comparison(versions.hub, targetWeb, true);
    let status = versions.status === 'checking' ? '正在检查发布版本' : !known ? '发布检查不可用 · 更新状态未知' : versions.status === 'partial' ? '部分发布信息不可用' : '已检查公开发布版本';
    if (updates) status += ' · ' + updates + ' 个会话可更新';
    if (differences) status += ' · ' + differences + ' 个会话存在版本差异';
    if (hubState.tone === 'update' || hubState.tone === 'different') status += ' · Hub 存在版本差异';
    const summary = get('version-summary'); summary.textContent = status;
    summary.className = 'version-summary' + (updates ? ' has-update' : '');
    const details = get('version-details'); details.replaceChildren();
    details.append(versionLine('Hub', versions.hub, targetWeb, true));
    details.append(element('span', 'release-target', '公开发布：Pi ' + (targetPi?.version || '未知') + ' / Web 扩展 ' + (targetWeb?.version || '未知') + (targetWeb?.build ? ' · ' + targetWeb.build.slice(0, 8) : '')));
    if (versions.checkedAt) details.append(element('span', 'release-target', '检查时间：' + new Date(versions.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · 发布检查最多每 5 分钟一次'));
  }
  function render() {
    const query = get('search').value.toLocaleLowerCase();
    const visible = items.filter((s) => projectLabel(s.label).toLocaleLowerCase().includes(query) || (s.sessionName || '未命名会话').toLocaleLowerCase().includes(query));
    get('notice').textContent = items.length && !visible.length ? '没有匹配的会话，请尝试其他关键词。' : '';
    const renderKey = JSON.stringify([items, query, versions]);
    if (renderKey === lastRender) return;
    lastRender = renderKey;
    renderVersions();
    get('sessions').replaceChildren();
    get('count').textContent = String(items.length);
    get('empty').hidden = items.length !== 0;
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
      const known = versions.status === 'ok' || versions.status === 'partial';
      const software = element('span', 'version-lines', '');
      const piVersion = session.software?.piVersion || session.runtime?.version;
      software.append(versionLine('Pi', piVersion ? { version: piVersion } : undefined, known ? versions.pi : undefined, false));
      software.append(versionLine('Web 扩展', session.software?.webUi, known ? versions.webUi : undefined, true));
      if (session.runtime?.managed) software.append(element('span', 'runtime-note', '受管运行 · 重启资格需另行检查'));
      meta.append(software);
      const link = document.createElement('a'); link.className = 'open'; link.href = session.path; link.textContent = '打开会话 ↗';
      link.addEventListener('click', (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        resetNavigation(); link.textContent = '正在打开…'; link.setAttribute('aria-busy', 'true');
        navigationTimer = setTimeout(resetNavigation, 10000);
      });
      card.append(top, title, meta, link); window.piHubManagement?.attach(card, session); get('sessions').append(card);
    }
  }
  async function refresh(afterCurrent = false) {
    if (loading) { if (afterCurrent) refreshAgain = true; return; } loading = true; get('refresh').disabled = true;
    try {
      const response = await fetch('/api/sessions', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error();
      const data = await response.json(); items = data.sessions; versions = data.versions || { status: 'unavailable' }; render();
      get('health').textContent = '● 总管已连接'; get('health').className = 'connected';
      get('updated').textContent = '刚刚更新 · 每 5 秒自动刷新';
    } catch {
      // Do not leave stale sessions looking online when the hub is unavailable.
      items = []; versions = { status: 'unavailable' }; render(); get('health').textContent = '连接中断'; get('health').className = 'disconnected';
      get('notice').textContent = '暂时无法连接总管。请检查服务，或点击刷新重试。';
    } finally {
      loading = false; get('refresh').disabled = false;
      if (refreshAgain) { refreshAgain = false; void refresh(); }
    }
  }
  window.addEventListener('pagehide', () => clearTimeout(navigationTimer));
  window.addEventListener('pageshow', (event) => {
    resetNavigation();
    if (event.persisted) refresh(true);
  });
  get('search').addEventListener('input', render); get('refresh').addEventListener('click', () => refresh(true));
  window.addEventListener('pi-hub-management', () => { lastRender = ''; render(); });
  refresh(); setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
})();`;
var portalManagementCss = `.management{border:1px solid #dce5d7;background:#ffffffa8;border-radius:14px;padding:16px 20px;margin:0 0 28px;font-size:13px;line-height:1.7}.management summary{cursor:pointer;font-weight:600}.management summary span{font-weight:400;color:#718076;margin-left:10px}.management p{color:#657768;margin:12px 0}.management form label{display:block;margin-bottom:7px}.management .controls{flex-wrap:wrap}.management input{flex:1;max-width:360px;width:auto;min-width:0}.management button{min-height:42px}.management code{overflow-wrap:anywhere}.runtime-updates{border-top:1px solid #e1e7dd;margin-top:18px;padding-top:18px}.runtime-update-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.runtime-update-heading h3{font-size:14px;margin:0}.runtime-update-heading span,#runtime-update-policy{color:#718076;font-size:12px}.runtime-update-result,.restart-result{border-top:1px solid #e1e7dd;padding:10px 0}.runtime-update-result p,.restart-result p{overflow-wrap:anywhere}.runtime-update-result .runtime-update-heading{color:#334c3d;font-weight:600}.runtime-update-identity,.runtime-update-target{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}.runtime-update-target{padding-left:12px;border-left:3px solid #e4ebe0}.restart{display:block;width:100%;margin-top:10px;background:transparent;color:#64795e;font-size:12px}.restart-result .open{width:fit-content}#management-notice{color:#97613c}@media(max-width:600px){.management{padding:14px 16px}.management input{width:100%;flex-basis:100%;max-width:none}.management summary span{display:block;margin-left:0}.management .controls button{width:100%}}`;
/** Separate trusted Hub script: never served by an individual Pi backend. */
var portalManagementJs = `(() => {
  const get = (id) => document.getElementById(id);
  let auth = { available: false, authorized: false };
  let authGeneration = 0;
  let authTransition = false;
  const operations = new Map();
  let polling;
  const notice = (text) => { get('management-notice').textContent = text; };
  const changed = () => window.dispatchEvent(new Event('pi-hub-management'));
  async function api(route, value) {
    const generation = authGeneration;
    const current = () => { if (generation !== authGeneration) { const error = new Error('旧管理请求已失效'); error.stale = true; throw error; } };
    const response = await fetch('/api/management/' + route, { method: value === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(7000),
      headers: { 'Content-Type': 'application/json', ...(auth.csrf ? { 'X-Pi-Hub-Csrf': auth.csrf } : {}) }, body: value === undefined ? undefined : JSON.stringify(value) });
    current();
    if (!response.ok) {
      if (response.status === 401) { authGeneration++; auth.authorized = false; auth.csrf = undefined; runtimeUpdates.clearProtected(); updateAuth(); }
      const error = new Error('管理请求未完成'); error.status = response.status; throw error;
    }
    const result = await response.json(); current(); return result;
  }
${runtimePortalJs}
  const restartAvailable = () => auth.restartAvailable ?? auth.available;
  function updateAuth() {
    get('management-status').textContent = authTransition ? '正在处理管理登录或锁定…' : !auth.available ? '未配置' : auth.authorized ? '已解锁 · 30 分钟有效' : '已锁定';
    const gateway = auth.authMode === 'gateway';
    get('management-unlock').hidden = gateway || !auth.available || auth.authorized || authTransition;
    get('management-gateway').hidden = !gateway || !auth.available || auth.authorized || authTransition;
    get('management-gateway').disabled = authTransition;
    get('management-code').disabled = authTransition;
    get('management-logout').hidden = !auth.authorized;
    get('management-logout').disabled = authTransition;
    get('management-help').textContent = !auth.available ? '本 Hub 尚未接入 Gate 管理能力。旧容器需使用新镜像重新启动一次，不能通过 /reload 获得受管能力。' : gateway ? '使用已验证的网页登录身份，无需管理码。管理会话 30 分钟有效；过期或锁定后可点击使用网页登录解锁。申请更新仍遵循 Gate 审批策略。' : '管理员在 Hub 的可信终端运行 pi-web-hub pair --config 配置文件，生成一次性管理码。管理授权与网页登录分开，过期后需重新解锁。';
    renderResults(); runtimeUpdates.updateAuth();
    changed();
  }
  function save() {
    try { sessionStorage.setItem('pi-hub-restarts', JSON.stringify([...operations.values()].filter((o) => !o.done).map(({ id, generation, label }) => ({ id, generation, label })))); } catch {}
  }
  function renderResults() {
    get('management-results').replaceChildren();
    if (!auth.authorized) return;
    for (const op of operations.values()) {
      const row = document.createElement('div'); row.className = 'restart-result';
      const text = document.createElement('p');
      const labels = { pending: '等待管理员审批', queued: '已排队', running: '正在重启并核对原会话', succeeded: '已恢复原会话', failed: '失败，请检查后手动处理', recovery_required: '结果不确定，需要管理员检查', rejected: '已拒绝', stale: '身份或授权已变化' };
      text.textContent = op.label + ' · ' + (labels[op.status] || '结果未知，正在查询；不会重复执行') + (op.new_version ? ' · Pi ' + op.new_version : '');
      row.append(text);
      if (op.status === 'succeeded' && typeof op.path === 'string' && /^\\/s\\/${HUB_GENERATION_SOURCE}\\/$/.test(op.path)) {
        const link = document.createElement('a'); link.href = new URL(op.path, document.querySelector('meta[name="pi-chat-origin"]').content).href; link.className = 'open'; link.textContent = '打开恢复后的会话 ↗'; row.append(link);
      } else if (op.status === 'succeeded') {
        const unavailable = document.createElement('p'); unavailable.textContent = '重启已成功完成；当前恢复链接不可用（会话可能已继续、切换或退出）。请从在线会话列表选择当前会话。'; row.append(unavailable);
      }
      get('management-results').append(row);
    }
  }
  async function poll() {
    const generation = authGeneration;
    if (polling === generation || !auth.authorized || !restartAvailable()) return;
    polling = generation;
    try {
      for (const op of operations.values()) {
        if (op.done) continue;
        try {
          const result = await api('restarts/' + op.id);
          delete op.path;
          Object.assign(op, result);
          op.done = ['succeeded', 'failed', 'recovery_required', 'rejected', 'stale'].includes(op.status);
        } catch { if (generation !== authGeneration) return; op.status = 'unknown'; }
      }
      if (generation === authGeneration) { save(); renderResults(); }
    } finally { if (polling === generation) polling = undefined; }
  }
  window.piHubManagement = { attach(card, session) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'restart'; button.textContent = '重启 Pi · 应用已安装更新';
    button.disabled = !restartAvailable() || !auth.authorized || [...operations.values()].some((o) => o.generation === session.generation && !o.done);
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      let submitted = false;
      try {
        const target = await api('targets/' + session.generation);
        if (!target.managed) { notice('此容器不支持进程重启，请先用新镜像重新启动一次。'); return; }
        if (target.mode === 'disabled') { notice('门禁尚未启用该能力，需要管理员配置独立生命周期策略。'); return; }
        if (!target.idle || target.pending || target.busy) { notice('此会话正在工作，或终端/未知命令使本进程无法证明可安全重启。工作完成后仍不可用时，需要在本地启动新的 Pi 进程；等待、取消和 /reload 不会清除输入不确定性。'); return; }
        if (!window.confirm('确认重启选中的 Pi？\\n项目：' + session.label + '\\n会话：' + (session.sessionName || '未命名') + '\\n当前 Pi：' + target.version + '\\n将加载已安装版本并恢复原会话及分支。网页会短暂断开；不会更新其他会话。' + (target.mode === 'manual' ? '\\n门禁仍需管理员审批。' : ''))) return;
        if (operations.size >= 64) { notice('本页操作记录已满，请重新打开管理页。'); return; }
        const id = [...crypto.getRandomValues(new Uint8Array(16))].map((v) => v.toString(16).padStart(2, '0')).join('');
        const op = { id, generation: session.generation, label: session.label, status: 'unknown', done: false };
        operations.set(id, op); save(); renderResults(); submitted = true;
        try { Object.assign(op, await api('restarts', { generation: session.generation, runtimeId: target.runtime_id, sessionId: target.session_id, leafId: target.leaf_id, idempotencyKey: id })); }
        catch { notice('未收到提交结果，将按原操作编号查询。不要重新点击重启。'); }
        renderResults();
      } catch { notice('无法确认目标或授权已过期，请刷新管理状态后重试。'); }
      finally { if (!submitted) button.disabled = !restartAvailable() || !auth.authorized; }
    });
    card.append(button);
  } };
  async function loginWithGateway() {
    if (authTransition || auth.authMode !== 'gateway' || !auth.available || auth.authorized) return;
    authTransition = true; updateAuth();
    try { const result = await api('gateway', {}); authGeneration++; auth = { ...auth, ...result }; runtimeUpdates.clearProtected(); updateAuth(); notice('已使用网页登录身份解锁管理，无需管理码。'); void poll(); void runtimeUpdates.poll(); }
    catch (error) { if (!error.stale) notice('无法验证网页登录身份，请重新登录管理入口后重试；不会自动提交更新。'); }
    finally { authTransition = false; updateAuth(); }
  }
  get('management-gateway').addEventListener('click', loginWithGateway);
  get('management-unlock').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (authTransition || auth.authMode === 'gateway') return;
    const input = get('management-code'); const code = input.value.trim(); input.value = '';
    authTransition = true; updateAuth();
    try { const result = await api('unlock', { code }); authGeneration++; auth = { ...auth, ...result }; runtimeUpdates.clearProtected(); updateAuth(); notice('管理已解锁。可独立选择进程重启或全局运行时更新。'); void poll(); void runtimeUpdates.poll(); }
    catch (error) { if (!error.stale) notice('管理码无效、已使用或过期，请从可信终端重新获取。'); }
    finally { authTransition = false; updateAuth(); }
  });
  get('management-logout').addEventListener('click', async () => {
    if (authTransition) return;
    authTransition = true; updateAuth();
    try { await api('logout', {}); authGeneration++; auth.authorized = false; auth.csrf = undefined; runtimeUpdates.clearProtected(); updateAuth(); notice('管理已锁定。已提交操作仍由门禁处理。'); }
    catch (error) { if (!error.stale) notice('锁定请求未完成，请关闭此页并让管理员撤销管理授权。'); }
    finally { authTransition = false; updateAuth(); }
  });
  try {
    const saved = JSON.parse(sessionStorage.getItem('pi-hub-restarts') || '[]');
    if (Array.isArray(saved)) for (const o of saved.slice(0, 64)) if (/^[a-f0-9]{32}$/.test(o.id) && /^${HUB_GENERATION_SOURCE}$/.test(o.generation) && typeof o.label === 'string' && o.label.length <= 256) operations.set(o.id, { id: o.id, generation: o.generation, label: o.label, done: false, status: 'unknown' });
  } catch {}
  void (async () => { try { auth = await api('status'); updateAuth(); if (auth.authMode === 'gateway') await loginWithGateway(); await poll(); await runtimeUpdates.poll(); } catch { notice('无法查询运行管理能力。'); } })();
  setInterval(async () => { await poll(); await runtimeUpdates.poll(); }, 2000);
})();`;
var portalCss = `:root{color-scheme:light;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#21312c;background:#f6f8f5;font-synthesis:none}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 90% 0,#e6efdf,transparent 55%)}main{max-width:1080px;margin:auto;padding:32px 40px 24px;min-height:100dvh}header{display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:flex;align-items:center;gap:12px;font-size:20px;font-weight:650;color:inherit;text-decoration:none}.logo{display:grid;place-items:center;border-radius:12px;background:#234c3c;color:#e8f3dd;width:42px;height:42px;font:32px Georgia,serif}.tag{font-size:10px;letter-spacing:2px;color:#758478;border:1px solid #d7dfd5;border-radius:5px;padding:4px 6px}#health{font-size:12px;color:#697c70}.connected{color:#347652!important}.disconnected{color:#a35437!important}.intro{padding:48px 0 34px}.eyebrow{font-size:12px;letter-spacing:2px;color:#718478}h1{margin:14px 0 16px;font-size:clamp(30px,4vw,46px);font-weight:600;letter-spacing:-1.5px}.intro p{margin:0;color:#718076;font-size:15px;line-height:1.8}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:22px}h2{font-size:17px;font-weight:600;margin:0}#count{display:inline-grid;place-items:center;min-width:25px;height:23px;margin-left:8px;background:#e2ebe0;border-radius:7px;color:#476347;font-size:12px}#updated{font-size:12px;color:#879287;margin:8px 0 0}.controls{display:flex;gap:10px}input,button{font:inherit;border:1px solid #dce3d9;border-radius:9px;background:#fff;padding:11px 14px;font-size:13px;color:#415447}input{width:230px}button{cursor:pointer}button:hover{background:#eef3eb}button:disabled{opacity:.55}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #93ad91;outline-offset:3px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}.card{display:flex;flex-direction:column;background:#ffffffdc;border:1px solid #e0e7dc;border-radius:16px;padding:24px;box-shadow:0 6px 24px #29412c04;min-width:0}.card-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}.project-icon{display:grid;place-items:center;width:40px;height:40px;background:#edf3e8;color:#587452;border-radius:11px;font-size:23px}.online{font-size:11px;color:#39734e;background:#eff5eb;border-radius:20px;padding:5px 10px}.online:before{content:'●';font-size:8px;margin-right:5px}.card h3{font-size:18px;font-weight:600;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{font-size:12px;color:#899587;margin:10px 0 20px;display:flex;flex-wrap:wrap;min-width:0;align-items:baseline}.session-name{max-width:calc(100% - 52px);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.card>.open{margin-top:auto}.meta>span:nth-child(2){flex-shrink:0}.version-lines{display:flex;flex-direction:column;gap:9px;flex-basis:100%;min-width:0;margin-top:18px;padding-top:16px;border-top:1px solid #edf0e9}.version-line{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;min-width:0;line-height:1.65}.version-label{font-weight:600;color:#64765f;min-width:48px}.version-value{color:#415447;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;min-width:0}.version-badge{border-radius:6px;padding:2px 7px;font-size:10px;line-height:1.6;overflow-wrap:anywhere}.version-badge.current{color:#356044;background:#edf4e9}.version-badge.update{color:#8a531d;background:#fff1d7}.version-badge.different{color:#805d2f;background:#f6efe0}.version-badge.unknown{color:#778174;background:#f1f3ef}.runtime-note{font-size:10px;color:#879180}.version-overview{border:1px solid #dce5d7;border-radius:16px;padding:22px 24px;background:#ffffffa8;margin-bottom:20px}.version-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}.version-heading .eyebrow{font-size:9px;letter-spacing:1.5px}.version-heading h2{margin-top:6px}.version-summary{font-size:12px;color:#72816e;line-height:1.8}.version-summary.has-update{color:#8a531d}.version-details{display:flex;flex-direction:column;gap:10px;margin-top:18px;font-size:12px}.release-target{color:#7c8975;font-size:11px;line-height:1.8;overflow-wrap:anywhere}.version-help{font-size:11px;color:#7c8975;line-height:1.8;margin:14px 0 0;padding-top:12px;border-top:1px solid #e8eee3}.open{display:block;text-align:center;color:#365b42;background:#f2f6ee;border:1px solid #e4ebdf;text-decoration:none;border-radius:8px;padding:11px;font-size:13px}.open:hover{background:#e7efdf}.empty{text-align:center;border:1px dashed #d6dfd0;border-radius:16px;padding:55px 20px;background:#ffffff70}.empty-icon{font:44px Georgia,serif;color:#8a9e82}.empty h3{font-size:17px;font-weight:500;margin:18px 0 10px}.empty p{font-size:13px;color:#7a8978;line-height:1.9}#notice{font-size:13px;color:#a35c3d;line-height:1.6;margin-bottom:14px}#notice:empty{display:none}footer{display:flex;justify-content:space-between;gap:15px;border-top:1px solid #e0e6db;margin-top:48px;padding-top:20px;font-size:11px;color:#96a18f}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}[hidden]{display:none!important}@media(max-width:600px){main{padding:24px 20px}header{gap:8px}.brand{font-size:17px;gap:8px}.logo{width:36px;height:36px;font-size:27px}#health{font-size:11px}.intro{padding:48px 0 34px}h1{letter-spacing:-1px;line-height:1.35}.toolbar{flex-direction:column;align-items:stretch;gap:18px}.controls label{flex:1;min-width:0}input{width:100%;min-width:0}.grid{grid-template-columns:1fr}.card{padding:22px}.card-top{margin-bottom:18px}footer{flex-direction:column;margin-top:32px;line-height:1.6}}`;
//#endregion
//#region hub/runtime-updates.ts
init_config();
init_lifecycle();
var runtimeVersion = (value) => typeof value === "string" && value.length <= 64 && value.trim() === value && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value);
var hex$2 = (value) => typeof value === "string" && value.length === 32 && /^[a-f0-9]{32}$/.test(value);
var word = (value) => typeof value === "string" && value.trim() === value && /^[a-z_]{1,64}$/.test(value);
var object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var states = [
	"pending",
	"queued",
	"running",
	"succeeded",
	"failed",
	"recovery_required",
	"rejected",
	"stale",
	"manual_restart_required"
];
/** A bounded error category, never the upstream response body or credential. */
var RuntimeUpdateError = class extends Error {
	status;
	constructor(status = 503) {
		super("Runtime update provider unavailable or outcome unknown");
		this.status = status;
	}
};
function job(value) {
	if (!object(value) || !hex$2(value.id) || !runtimeVersion(value.version) || !states.includes(value.status) || !word(value.stage) || !Array.isArray(value.targets)) throw new RuntimeUpdateError();
	const targets = value.targets.map((target) => {
		if (!object(target) || !hex$2(target.run_id) || !word(target.status)) throw new RuntimeUpdateError();
		const result = {
			run_id: target.run_id,
			status: target.status
		};
		if (target.profile !== void 0) {
			if (target.profile !== "web-terminal-v1") throw new RuntimeUpdateError();
			result.profile = target.profile;
		}
		if (target.status === "manual_restart_required" && (target.old_version !== void 0 || target.version !== void 0 || target.restart_id !== void 0 || target.wait_reason !== "terminal_profile_unaudited")) throw new RuntimeUpdateError();
		for (const key of ["old_version", "version"]) if (target[key] !== void 0) {
			if (!runtimeVersion(target[key])) throw new RuntimeUpdateError();
			result[key] = target[key];
		}
		if (target.wait_reason !== void 0) {
			if (!word(target.wait_reason)) throw new RuntimeUpdateError();
			result.wait_reason = target.wait_reason;
		}
		return result;
	});
	const result = {
		id: value.id,
		version: value.version,
		status: value.status,
		stage: value.stage,
		targets
	};
	for (const key of ["created_at", "resolved_at"]) if (value[key] !== void 0) {
		if (!Number.isSafeInteger(value[key]) || Number(value[key]) <= 0) throw new RuntimeUpdateError();
		result[key] = Number(value[key]);
	}
	if (value.resolved !== void 0) {
		if (typeof value.resolved !== "boolean") throw new RuntimeUpdateError();
		result.resolved = value.resolved;
	}
	return result;
}
/** Request-only Gate capability; no policy, approval, Docker or shell operations. */
var GateRuntimeUpdates = class {
	config;
	constructor(config) {
		this.config = lifecycleConfig(config);
	}
	request(method, route, value) {
		let credential;
		try {
			credential = readPrivateJson(this.config.credentialFile);
		} catch {
			throw new RuntimeUpdateError();
		}
		if (!object(credential) || Object.keys(credential).join(",") !== "token" || typeof credential.token !== "string" || !/^[a-f0-9]{64}$/.test(credential.token)) throw new RuntimeUpdateError();
		const token = credential.token;
		const payload = value ? JSON.stringify(value) : void 0;
		return new Promise((resolve, reject) => {
			let done = false;
			const finish = (error, result) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				request.destroy();
				if (error) reject(error);
				else resolve(result);
			};
			const request = http.request(new URL(route, this.config.endpoint), {
				method,
				agent: false,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					...payload ? { "Content-Length": Buffer.byteLength(payload) } : {}
				}
			}, (response) => {
				const status = response.statusCode ?? 503;
				if (status < 200 || status >= 300) {
					finish(new RuntimeUpdateError([
						400,
						404,
						409
					].includes(status) ? status : 503));
					return;
				}
				const chunks = [];
				let bytes = 0;
				response.on("data", (chunk) => {
					bytes += chunk.length;
					if (bytes > 16 * 1024 * 1024) {
						finish(new RuntimeUpdateError());
						return;
					}
					chunks.push(chunk);
				});
				response.on("error", () => finish(new RuntimeUpdateError()));
				response.on("aborted", () => finish(new RuntimeUpdateError()));
				response.on("end", () => {
					try {
						finish(void 0, JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
					} catch {
						finish(new RuntimeUpdateError());
					}
				});
			});
			const timer = setTimeout(() => finish(new RuntimeUpdateError()), 5e3);
			request.on("error", () => finish(new RuntimeUpdateError()));
			request.end(payload);
		});
	}
	async status() {
		const value = await this.request("GET", "/v1/runtime-updates");
		if (!object(value) || !object(value.policy) || ![
			"manual",
			"auto",
			"disabled"
		].includes(value.policy.mode) || !Array.isArray(value.jobs) || value.jobs.length > 100 || !Array.isArray(value.active) || value.active.length > 100) throw new RuntimeUpdateError();
		return {
			policy: { mode: value.policy.mode },
			jobs: value.jobs.map(job),
			active: value.active.map(job)
		};
	}
	async submit(version, id) {
		if (!runtimeVersion(version) || !hex$2(id)) throw new RuntimeUpdateError(400);
		const result = job(await this.request("POST", "/v1/runtime-updates", {
			version,
			idempotency_key: id
		}));
		if (result.id !== id || result.version !== version) throw new RuntimeUpdateError();
		return result;
	}
	async operation(id) {
		if (!hex$2(id)) throw new RuntimeUpdateError(400);
		const result = job(await this.request("GET", `/v1/runtime-updates/${id}`));
		if (result.id !== id) throw new RuntimeUpdateError();
		return result;
	}
};
//#endregion
//#region hub/restart-api.ts
init_config();
init_lifecycle();
init_state_budget();
var hex$1 = (v) => typeof v === "string" && /^[a-f0-9]{32}$/.test(v);
var text = (v) => typeof v === "string" && v.length > 0 && v.length <= 256 && !/\p{Cc}/u.test(v);
async function body(request) {
	if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new Error();
	const data = await new Promise((resolve, reject) => {
		let data = Buffer.alloc(0);
		const finish = (error) => {
			clearTimeout(timer);
			request.off("data", onData);
			request.off("end", onEnd);
			request.off("error", onError);
			request.off("aborted", onError);
			if (error) reject(error);
			else resolve(data);
		};
		const onData = (chunk) => {
			data = Buffer.concat([data, chunk]);
			if (data.length > 8192) {
				request.resume();
				finish(/* @__PURE__ */ new Error());
			}
		};
		const onEnd = () => finish();
		const onError = () => finish(/* @__PURE__ */ new Error());
		const timer = setTimeout(onError, 5e3);
		request.on("data", onData);
		request.once("end", onEnd);
		request.once("error", onError);
		request.once("aborted", onError);
	});
	const value = JSON.parse(data.toString("utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
	return value;
}
function createRestartApi(config, hooks) {
	const management = new HubManagement(config);
	const provider = config.lifecycle ? new GateLifecycle(config.lifecycle) : void 0;
	const runtimeProvider = config.runtimeUpdates ? new GateRuntimeUpdates(config.runtimeUpdates) : void 0;
	const receipts = path.join(config.stateDir, "restarts");
	if (provider) privateDirectory(receipts);
	const file = (id) => {
		if (!hex$1(id)) throw new Error();
		return path.join(receipts, `${id}.json`);
	};
	const read = (id) => {
		const value = readPrivateJson(file(id));
		if (value.id !== id || !hex$1(value.run_id) || !isHubGeneration(value.generation) || value.idempotency_key !== id || !text(value.runtime_id) || !text(value.session_id) || value.leaf_id !== null && !text(value.leaf_id)) throw new Error();
		return value;
	};
	const save = (value, publish) => withStateWriter(config, (writer) => {
		if (!hooks.granted(value.run_id)) throw new Error();
		if (readdirSync(receipts).filter((name) => /^[a-f0-9]{32}\.json$/.test(name)).length >= 1e3) throw new Error();
		writer.write(`restarts/${value.id}.json`, value, { exclusive: true });
		publish();
	});
	const resolve = async (id, submitted) => {
		if (!provider) throw new Error();
		const receipt = read(id);
		if (!hooks.granted(receipt.run_id)) throw new Error();
		const job = submitted ?? await provider.operation(id);
		if (job.run_id !== receipt.run_id || !hooks.granted(receipt.run_id)) throw new Error();
		const clockFile = path.join(receipts, `${id}.started.json`);
		if (job.started_at !== void 0) withStateWriter(config, (writer) => {
			if (!hooks.granted(receipt.run_id)) throw new Error();
			if (!existsSync(clockFile)) writer.write(`restarts/${id}.started.json`, { started_at: job.started_at }, { exclusive: true });
		});
		if (existsSync(clockFile) && readPrivateJson(clockFile).started_at !== job.started_at) throw new Error();
		const result = {
			id,
			status: job.status,
			stage: job.stage
		};
		const failed = (stage) => {
			hooks.clearHandoff(id);
			return {
				...result,
				status: "failed",
				stage
			};
		};
		if ([
			"failed",
			"recovery_required",
			"rejected",
			"stale"
		].includes(job.status)) hooks.clearHandoff(id);
		for (const key of [
			"old_version",
			"expected_version",
			"new_version"
		]) if (job[key]) result[key] = job[key];
		if (job.status === "succeeded") {
			if (job.old_runtime_id !== receipt.runtime_id || job.session_id !== receipt.session_id || job.leaf_id !== receipt.leaf_id || !job.new_runtime_id || job.new_runtime_id === receipt.runtime_id || !job.new_version || job.new_version !== job.expected_version) return failed("restored_identity_mismatch");
			if (job.started_at === void 0) throw new Error();
			const deadline = job.started_at + 21e4;
			const verifiedFile = path.join(receipts, `${id}.verified.json`);
			const completed = existsSync(verifiedFile) ? readPrivateJson(verifiedFile) : void 0;
			if (completed && (completed.id !== id || completed.run_id !== receipt.run_id || completed.generation !== receipt.generation || completed.old_runtime_id !== receipt.runtime_id || completed.session_id !== receipt.session_id || completed.leaf_id !== receipt.leaf_id || completed.started_at !== job.started_at || !Number.isSafeInteger(completed.at) || completed.at >= deadline || completed.at < job.started_at || completed.at > Date.now() || completed.runtimeId !== job.new_runtime_id || completed.version !== job.new_version || !isHubSessionPath(completed.path))) throw new Error();
			if (!completed && Date.now() >= deadline) return failed("registration_timeout");
			let route;
			try {
				route = await hooks.successor(receipt.run_id, job.new_runtime_id, receipt.session_id, receipt.leaf_id, job.new_version);
			} catch (error) {
				if (!completed) throw error;
			}
			if (!hooks.granted(receipt.run_id)) throw new Error();
			if (completed) {
				if (route === completed.path) result.path = route;
				return result;
			}
			if (Date.now() >= deadline) return failed("registration_timeout");
			if (route) {
				if (!isHubSessionPath(route)) throw new Error();
				withStateWriter(config, (writer) => {
					if (!hooks.granted(receipt.run_id) || Date.now() >= deadline) throw new Error();
					if (!existsSync(verifiedFile)) writer.write(`restarts/${id}.verified.json`, {
						id,
						run_id: receipt.run_id,
						generation: receipt.generation,
						old_runtime_id: receipt.runtime_id,
						session_id: receipt.session_id,
						leaf_id: receipt.leaf_id,
						started_at: job.started_at,
						at: Date.now(),
						path: route,
						runtimeId: job.new_runtime_id,
						version: job.new_version
					}, { exclusive: true });
				});
				result.path = route;
			} else {
				result.status = "running";
				result.stage = "waiting_for_registration";
			}
		}
		return result;
	};
	return {
		resolve,
		async handle(request, response, sameOrigin) {
			const pathname = request.url?.split("?")[0] ?? "";
			if (!pathname.startsWith("/api/management/")) return false;
			const reply = (status, value, cookie) => {
				response.writeHead(status, {
					"Content-Type": "application/json",
					"Cache-Control": "no-store",
					"Referrer-Policy": "no-referrer",
					...cookie ? { "Set-Cookie": cookie } : {}
				}).end(JSON.stringify(value));
			};
			let phase = "authorization";
			try {
				if (config.management?.gateway && !gatewayIdentity(config, request)) {
					reply(401, { error: "Verified gateway login required" });
					return true;
				}
				if (request.method === "GET" && pathname === "/api/management/status") {
					reply(200, {
						available: !!provider || !!runtimeProvider,
						...config.management?.gateway ? { authMode: "gateway" } : {},
						...runtimeProvider ? {
							runtimeUpdatesAvailable: true,
							restartAvailable: !!provider
						} : {},
						...management.status(request)
					});
					return true;
				}
				if (request.method === "POST" && !sameOrigin) {
					reply(403, { error: "Same-origin management request required" });
					return true;
				}
				if (request.method === "POST" && pathname === "/api/management/unlock") {
					if (config.management?.gateway) {
						reply(404, { error: "Pairing is not enabled" });
						return true;
					}
					const value = await body(request);
					if (Object.keys(value).join(",") !== "code") throw new Error();
					const result = management.unlock(value.code);
					reply(200, {
						authorized: true,
						csrf: result.csrf,
						expiresAt: result.expiresAt
					}, result.cookie);
					return true;
				}
				if (request.method === "POST" && pathname === "/api/management/gateway") {
					if (!config.management?.gateway) {
						reply(404, { error: "Gateway login is not configured" });
						return true;
					}
					try {
						if (Object.keys(await body(request)).length !== 0) throw new Error();
					} catch {
						reply(400, { error: "Empty gateway session request required" });
						return true;
					}
					const result = management.unlockGateway(request);
					reply(200, {
						authorized: true,
						csrf: result.csrf,
						expiresAt: result.expiresAt
					}, result.cookie);
					return true;
				}
				const authorization = management.authorize(request, request.method !== "GET");
				const revalidate = () => {
					phase = "authorization";
					management.revalidate(request, authorization, request.method !== "GET");
					phase = "provider";
				};
				if (request.method === "POST" && pathname === "/api/management/logout") {
					reply(200, { authorized: false }, management.logout(request));
					return true;
				}
				if (request.method === "GET" && pathname === "/api/management/storage") {
					reply(200, storageDiagnostics(config));
					return true;
				}
				phase = "provider";
				if (pathname === "/api/management/runtime-updates" || /^\/api\/management\/runtime-updates\/[a-f0-9]{32}$/.test(pathname)) {
					if (!runtimeProvider) {
						reply(503, { error: "Global Pi updates are not configured" });
						return true;
					}
					let result;
					let status = 200;
					try {
						if (request.method === "GET") result = pathname === "/api/management/runtime-updates" ? await runtimeProvider.status() : await runtimeProvider.operation(pathname.slice(32));
						else if (request.method === "POST" && pathname === "/api/management/runtime-updates") {
							let value;
							try {
								value = await body(request);
							} catch {
								revalidate();
								reply(400, { error: "Invalid runtime update request" });
								return true;
							}
							revalidate();
							if (Object.keys(value).sort().join(",") !== "idempotencyKey,version" || !runtimeVersion(value.version) || !hex$1(value.idempotencyKey)) {
								reply(400, { error: "Exact stable Pi version and idempotency identity required" });
								return true;
							}
							result = await runtimeProvider.submit(value.version, value.idempotencyKey);
							status = 202;
						} else {
							reply(405, { error: "Method not allowed" });
							return true;
						}
					} catch (error) {
						if (!(error instanceof RuntimeUpdateError)) throw error;
						revalidate();
						reply(error.status, { error: error.status === 400 ? "Pi version rejected; use an audited exact stable version" : error.status === 409 ? "Gate is busy or global updates are disabled" : error.status === 404 ? "Runtime update not found; verify the original task ID" : "Runtime provider unavailable or outcome unknown; query the original task ID before retrying" });
						return true;
					}
					revalidate();
					reply(status, result);
					return true;
				}
				if (pathname.startsWith("/api/management/runtime-updates")) {
					reply(404, { error: "Management route not found" });
					return true;
				}
				if (!provider) {
					reply(503, { error: "Managed restart is not configured" });
					return true;
				}
				const targetMatch = new RegExp(`^/api/management/targets/(${HUB_GENERATION_SOURCE})$`).exec(pathname);
				if (request.method === "GET" && targetMatch) {
					const selected = await hooks.lookup(targetMatch[1]);
					if (!selected) {
						reply(410, { error: "Session changed" });
						return true;
					}
					if (!selected.runtime?.managed) {
						reply(200, { managed: false });
						return true;
					}
					const target = await provider.target(selected.runId);
					if (!hooks.granted(selected.runId)) throw new Error();
					const { run_id: _runId, ...safe } = target;
					if (target.managed && (target.runtime_id !== selected.runtime.runtimeId || target.session_id !== selected.runtime.sessionId || target.leaf_id !== selected.runtime.leafId)) {
						reply(409, { error: "Session identity changed; refresh before restarting" });
						return true;
					}
					reply(200, safe);
					return true;
				}
				if (request.method === "POST" && pathname === "/api/management/restarts") {
					const value = await body(request);
					revalidate();
					if (Object.keys(value).sort().join(",") !== "generation,idempotencyKey,leafId,runtimeId,sessionId" || !isHubGeneration(value.generation) || !hex$1(value.idempotencyKey) || !text(value.runtimeId) || !text(value.sessionId) || value.leafId !== null && !text(value.leafId)) {
						reply(400, { error: "Invalid restart request" });
						return true;
					}
					const id = value.idempotencyKey;
					let receipt;
					if (existsSync(file(id))) {
						receipt = read(id);
						if (receipt.generation !== value.generation || receipt.runtime_id !== value.runtimeId || receipt.session_id !== value.sessionId || receipt.leaf_id !== value.leafId) throw new Error();
						reply(200, await resolve(id));
						return true;
					}
					const selected = await hooks.lookup(value.generation);
					revalidate();
					if (!selected?.runtime?.managed || selected.runtime.runtimeId !== value.runtimeId || selected.runtime.sessionId !== value.sessionId || selected.runtime.leafId !== value.leafId) {
						reply(409, { error: "Session changed or needs a managed image" });
						return true;
					}
					receipt = {
						id,
						generation: value.generation,
						requestedAt: Date.now(),
						run_id: selected.runId,
						runtime_id: value.runtimeId,
						session_id: value.sessionId,
						leaf_id: value.leafId,
						idempotency_key: id
					};
					revalidate();
					save(receipt, () => {
						revalidate();
						hooks.prepareHandoff(selected.runId, {
							id,
							generation: receipt.generation,
							runtimeId: receipt.runtime_id,
							sessionId: receipt.session_id,
							leafId: receipt.leaf_id
						});
					});
					revalidate();
					const job = await provider.restart({
						run_id: receipt.run_id,
						runtime_id: receipt.runtime_id,
						session_id: receipt.session_id,
						leaf_id: receipt.leaf_id,
						idempotency_key: id
					});
					if (job.id !== id || !hooks.granted(receipt.run_id)) throw new Error();
					reply(202, await resolve(id, job));
					return true;
				}
				const match = /^\/api\/management\/restarts\/([a-f0-9]{32})$/.exec(pathname);
				if (request.method === "GET" && match) {
					reply(200, await resolve(match[1]));
					return true;
				}
				reply(404, { error: "Management route not found" });
			} catch {
				reply(phase === "authorization" ? 401 : 409, { error: phase === "authorization" ? "Management authorization required" : "Restart unavailable or outcome unknown; refresh status before retrying" });
			}
			return true;
		}
	};
}
//#endregion
//#region hub/terminal-auth.ts
init_config();
init_state_budget();
init_terminal_contract();
var digest = (value) => createHash("sha256").update(value).digest("hex");
var hex = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
var equal$1 = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
var stateFile = (config) => path.join(config.stateDir, "terminal-auth.json");
function parseTerminalScope(value) {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "access,runId,runtimeId,sessionId,terminalEpoch") throw new Error("Invalid terminal scope");
	const v = value;
	if (v.access !== "read" && v.access !== "write") throw new Error("Invalid terminal scope");
	const target = parseTerminalTarget({
		v: 1,
		runId: v.runId,
		runtimeId: v.runtimeId,
		sessionId: v.sessionId,
		terminalEpoch: v.terminalEpoch,
		profile: "web-terminal-v1",
		inputState: "none",
		managedRestartEligible: false
	});
	return {
		runId: target.runId,
		runtimeId: target.runtimeId,
		sessionId: target.sessionId,
		terminalEpoch: target.terminalEpoch,
		access: v.access
	};
}
function readState(config) {
	if (!existsSync(stateFile(config))) return void 0;
	const v = readPrivateJson(stateFile(config));
	if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join(",") !== "epoch,expires,failures,pairHash,scope" || !hex(v.epoch, 64) || v.pairHash !== null && !hex(v.pairHash, 64) || !Number.isSafeInteger(v.expires) || v.expires < 0 || !Number.isInteger(v.failures) || v.failures < 0 || v.failures > 10 || v.pairHash !== null && v.scope === null) throw new Error("Terminal authorization unavailable");
	return {
		...v,
		scope: v.scope === null ? null : parseTerminalScope(v.scope)
	};
}
function saveState(writer, value, security = false) {
	writer.write("terminal-auth.json", value, { security });
}
/** Trusted CLI only. Scope names a child, but does not prove that it is live. */
function issueTerminalCode(config, value, now = Date.now()) {
	if (!config.terminal) throw new Error("Terminal listener is disabled");
	const scope = parseTerminalScope(value);
	if (readGrant(config, scope.runId).revoked) throw new Error("Terminal run revoked");
	const code = randomBytes(16).toString("hex");
	return withStateWriter(config, (writer) => {
		if (readGrant(config, scope.runId).revoked) throw new Error("Terminal run revoked");
		const epoch = readState(config)?.epoch ?? randomBytes(32).toString("hex");
		const expiresAt = now + 6e5;
		saveState(writer, {
			epoch,
			pairHash: digest(code),
			expires: expiresAt,
			failures: 0,
			scope
		});
		return {
			code,
			expiresAt
		};
	});
}
function revokeTerminal(config) {
	withStateWriter(config, (writer) => {
		saveState(writer, {
			epoch: randomBytes(32).toString("hex"),
			pairHash: null,
			expires: 0,
			failures: 0,
			scope: null
		}, true);
	});
}
/** Independent of management/chat auth. Caller MUST enforce terminal Host/Origin. */
var HubTerminalAuth = class {
	sessions = /* @__PURE__ */ new Map();
	config;
	now;
	secure;
	cookieName;
	constructor(config, now = Date.now) {
		if (!config.terminal) throw new Error("Terminal listener is disabled");
		this.config = config;
		this.now = now;
		this.secure = !!config.terminal.publicUrl;
		this.cookieName = this.secure ? "__Host-pi-hub-terminal" : "pi_hub_terminal_local";
	}
	session(request) {
		const values = (request.headers.cookie ?? "").split(";").map((item) => item.trim()).filter((item) => item.startsWith(`${this.cookieName}=`));
		if (values.length !== 1) return void 0;
		const token = values[0].slice(this.cookieName.length + 1);
		if (!hex(token, 64)) return void 0;
		const key = digest(token);
		const session = this.sessions.get(key);
		if (!session) return void 0;
		try {
			const state = readState(this.config);
			if (session.expires <= this.now() || !state || session.epoch !== state.epoch || readGrant(this.config, session.scope.runId).revoked) throw new Error();
		} catch {
			this.sessions.delete(key);
			return;
		}
		return {
			key,
			...session,
			scope: { ...session.scope }
		};
	}
	status(request) {
		const session = this.session(request);
		return session ? {
			authorized: true,
			csrf: session.csrf,
			expiresAt: session.expires,
			scope: session.scope
		} : { authorized: false };
	}
	authorize(request, requireCsrf = false, access = "read") {
		const session = this.session(request);
		const csrf = request.headers["x-pi-hub-terminal-csrf"];
		if (!session || access === "write" && session.scope.access !== "write" || requireCsrf && (!hex(csrf, 64) || !equal$1(csrf, session.csrf))) throw new Error("Terminal authorization required");
		return session;
	}
	/** Target check is mandatory before any future provider/PTY operation. */
	authorizeTarget(request, expected, requireCsrf = true, access = "read") {
		const session = this.authorize(request, requireCsrf, access);
		if (!sameTerminal(session.scope, expected)) throw new Error("Terminal target authorization required");
		return session;
	}
	revalidate(request, expected, requireCsrf = false, access = "read") {
		const current = this.authorize(request, requireCsrf, access);
		if (current.key !== expected.key || current.epoch !== expected.epoch || current.expires !== expected.expires) throw new Error("Terminal authorization changed");
	}
	unlock(code) {
		return withStateWriter(this.config, (writer) => this.unlockLocked(writer, code));
	}
	unlockLocked(writer, code) {
		const state = readState(this.config);
		if (!state?.scope || !state.pairHash || state.expires <= this.now() || state.failures >= 10) throw new Error("Terminal unlock rejected");
		if (!hex(code, 32) || !equal$1(digest(code), state.pairHash)) {
			saveState(writer, {
				...state,
				failures: state.failures + 1
			}, true);
			throw new Error("Terminal unlock rejected");
		}
		if (readGrant(this.config, state.scope.runId).revoked) throw new Error("Terminal unlock rejected");
		for (const [key, session] of this.sessions) try {
			if (session.expires <= this.now() || session.epoch !== state.epoch || readGrant(this.config, session.scope.runId).revoked) this.sessions.delete(key);
		} catch {
			this.sessions.delete(key);
		}
		if (this.sessions.size >= 64) throw new Error("Terminal unlock rejected");
		saveState(writer, {
			...state,
			pairHash: null,
			expires: 0,
			scope: null
		});
		const token = randomBytes(32).toString("hex");
		const session = {
			epoch: state.epoch,
			expires: this.now() + 18e5,
			csrf: randomBytes(32).toString("hex"),
			authorizationId: randomBytes(16).toString("hex"),
			scope: { ...state.scope }
		};
		this.sessions.set(digest(token), session);
		return {
			csrf: session.csrf,
			expiresAt: session.expires,
			cookie: this.cookie(token, 1800)
		};
	}
	logout(request) {
		return withStateWriter(this.config, () => {
			const session = this.authorize(request, true);
			this.sessions.delete(session.key);
			return this.cookie("", 0);
		});
	}
	close() {
		this.sessions.clear();
	}
	cookie(token, maxAge) {
		return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secure ? "; Secure" : ""}`;
	}
};
//#endregion
//#region hub/terminal-server.ts
init_terminal_contract();
init_terminal_provider();
init_terminal_wire();
/** Third-origin listener; only this fixed asset bundle and the private provider. */
async function startTerminalServer(config, otherOrigins) {
	if (!config.terminal) throw new Error("Terminal listener is disabled");
	const terminal = config.terminal;
	const auth = new HubTerminalAuth(config);
	const connections = /* @__PURE__ */ new Set();
	const nonces = /* @__PURE__ */ new Map();
	const peers = /* @__PURE__ */ new Set();
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: TERMINAL_FRAME_BYTES,
		perMessageDeflate: false
	});
	let url = "", closed = false, pending = 0;
	const assets = /* @__PURE__ */ new Map();
	const assetRoot = new URL(import.meta.url.endsWith(".ts") ? "../dist/terminal/" : "../terminal/", import.meta.url);
	for (const [route, name, mime] of [
		[
			"/",
			"index.html",
			"text/html"
		],
		[
			"/terminal.js",
			"app.js",
			"text/javascript"
		],
		[
			"/terminal.css",
			"app.css",
			"text/css"
		]
	]) try {
		const bytes = readFileSync(fileURLToPath(new URL(name, assetRoot)));
		if (bytes.length <= 2 * 1024 * 1024) assets.set(route, [mime, bytes]);
	} catch {}
	const allowed = (request, write) => {
		if (closed || !url || request.headers["service-worker"] !== void 0 || request.headers["sec-fetch-site"] === "cross-site") return false;
		const matched = [new URL(url).origin, ...terminal.publicUrl ? [new URL(terminal.publicUrl).origin] : []].find((candidate) => new URL(candidate).host === request.headers.host);
		return !!matched && (request.headers.origin === void 0 ? !write : request.headers.origin === matched);
	};
	const respond = (res, status, value) => {
		if (!res.destroyed && !res.writableEnded) res.writeHead(status, { "Content-Type": "application/json" }).end(value === void 0 ? void 0 : JSON.stringify(value));
	};
	const validate = (req, expected, target, access) => {
		if (!allowed(req, true)) throw new Error();
		const current = auth.authorizeTarget(req, target, true, access);
		auth.revalidate(req, expected, true, access);
		if (current.authorizationId !== expected.authorizationId) throw new Error();
	};
	const prune = () => {
		for (const [key, nonce] of nonces) if (nonce.expires <= Date.now()) nonces.delete(key);
		for (const peer of peers) peer.check();
	};
	const admit = (target, access) => {
		const all = [...nonces.values(), ...[...peers].flatMap((peer) => peer.reservation ? [peer.reservation] : [])].filter((r) => r.target.runId === target.runId);
		return all.length < 2 && (access !== "write" || !all.some((r) => r.access === "write"));
	};
	const handle = async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'");
		res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
		res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
		if (!allowed(req, req.method !== "GET")) return respond(res, 403);
		const route = req.url;
		const asset = assets.get(route ?? "");
		if (req.method === "GET" && asset) {
			const [mime, bytes] = asset;
			res.writeHead(200, { "Content-Type": `${mime}; charset=utf-8` }).end(bytes);
			return;
		}
		if (req.method === "GET" && route === "/api/terminal/status") {
			const status = auth.status(req);
			if (!status.authorized || !terminal.provider) return respond(res, 200, {
				...status,
				available: false,
				reason: "terminal_backend_unavailable"
			});
			if (pending >= 8) return respond(res, 503);
			pending++;
			try {
				const session = auth.authorize(req);
				const target = await terminalProviderStatus(terminal.provider, session.scope.runId);
				auth.revalidate(req, session);
				if (!allowed(req, false) || !sameTerminal(target, session.scope)) throw new Error();
				return respond(res, 200, {
					...auth.status(req),
					available: true,
					target
				});
			} catch {
				return respond(res, 200, {
					...auth.status(req),
					available: false,
					reason: "terminal_backend_unavailable"
				});
			} finally {
				pending--;
			}
		}
		if (req.method !== "POST" || ![
			"/api/terminal/unlock",
			"/api/terminal/logout",
			"/api/terminal/attach"
		].includes(route ?? "")) return respond(res, 404);
		if (req.headers["content-type"] !== "application/json" || req.headers["transfer-encoding"] !== void 0 || !/^[0-9]{1,4}$/.test(req.headers["content-length"] ?? "") || Number(req.headers["content-length"]) > 2048) {
			res.setHeader("Connection", "close");
			return respond(res, 413);
		}
		const timer = setTimeout(() => req.destroy(), 2e3);
		try {
			const chunks = [];
			let length = 0;
			for await (const chunk of req) {
				length += chunk.length;
				if (length > 2048) throw new Error();
				chunks.push(chunk);
			}
			if (!allowed(req, true)) throw new Error();
			const data = parseTerminalJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
			if (route === "/api/terminal/unlock") {
				exact(data, "code");
				const result = auth.unlock(data.code);
				res.setHeader("Set-Cookie", result.cookie);
				return respond(res, 200, {
					csrf: result.csrf,
					expiresAt: result.expiresAt
				});
			}
			if (route === "/api/terminal/logout") {
				exact(data, "");
				res.setHeader("Set-Cookie", auth.logout(req));
				prune();
				return respond(res, 200, { authorized: false });
			}
			exact(data, "access,target");
			if (data.access !== "read" && data.access !== "write") throw new Error();
			const target = parseTerminalTarget(data.target), access = data.access;
			const session = auth.authorizeTarget(req, target, true, access);
			if (!terminal.provider) return respond(res, 503, {
				available: false,
				reason: "terminal_backend_unavailable"
			});
			prune();
			if (nonces.size >= 8 || !admit(target, access)) return respond(res, 409);
			const nonce = randomBytes(32).toString("hex"), expiresAt = Date.now() + 1e4;
			nonces.set(nonce, {
				session,
				target,
				access,
				expires: expiresAt
			});
			return respond(res, 200, {
				nonce,
				expiresAt
			});
		} catch {
			return respond(res, 403);
		} finally {
			clearTimeout(timer);
		}
	};
	const server = http.createServer({
		maxHeaderSize: 8192,
		headersTimeout: 5e3,
		requestTimeout: 5e3
	}, (req, res) => {
		handle(req, res).catch(() => respond(res, 403));
	});
	server.maxConnections = 32;
	server.on("connection", (socket) => {
		connections.add(socket);
		socket.on("error", () => socket.destroy());
		socket.once("close", () => connections.delete(socket));
	});
	server.on("clientError", (_error, socket) => socket.destroy());
	server.on("connect", (_request, socket) => socket.destroy());
	server.on("upgrade", (request, socket, head) => {
		try {
			if (!allowed(request, true) || request.url !== "/api/terminal/ws" || pending >= 8 || peers.size >= 8) throw new Error();
			auth.authorize(request);
			wss.handleUpgrade(request, socket, head, (ws) => attachSocket(ws, request));
		} catch {
			socket.destroy();
		}
	});
	function attachSocket(ws, request) {
		let reservation;
		let provider;
		let dead = false, initialized = false, inputAllowed = false, acquiring = false, lastId = 0, generation = 0;
		const abort = new AbortController();
		const peer = {
			close,
			check: () => {
				if (reservation) try {
					validate(request, reservation.session, reservation.target, reservation.access);
				} catch {
					close();
				}
			},
			get reservation() {
				return reservation;
			}
		};
		peers.add(peer);
		pending++;
		const timer = setTimeout(close, 2e3);
		const lifespan = setTimeout(close, 3e5);
		function close() {
			if (dead) return;
			dead = true;
			inputAllowed = false;
			generation++;
			abort.abort();
			provider?.close();
			peers.delete(peer);
			if (!initialized) {
				initialized = true;
				pending--;
			}
			clearTimeout(timer);
			clearTimeout(lifespan);
			ws.terminate();
		}
		const check = () => {
			if (dead || !reservation || ws.readyState !== WebSocket.OPEN) throw new Error();
			validate(request, reservation.session, reservation.target, reservation.access);
		};
		const send = (frame) => new Promise((resolve, reject) => {
			try {
				check();
				const text = JSON.stringify(frame);
				if (Buffer.byteLength(text) > 65536 || ws.bufferedAmount + Buffer.byteLength(text) > 262144) throw new Error();
				const timeout = setTimeout(() => {
					close();
					reject(/* @__PURE__ */ new Error());
				}, 2e3);
				ws.send(text, (error) => {
					clearTimeout(timeout);
					if (error) {
						close();
						reject(/* @__PURE__ */ new Error());
					} else resolve();
				});
			} catch {
				close();
				reject(/* @__PURE__ */ new Error());
			}
		});
		const snapshot = async (value) => {
			check();
			if (!reservation) throw new Error();
			const bytes = Buffer.from(value.data), target = reservation.target;
			await send({
				type: "screen-start",
				target,
				sequence: value.sequence,
				columns: value.columns,
				rows: value.rows,
				bytes: bytes.length,
				chunks: Math.ceil(bytes.length / 20480)
			});
			for (let index = 0; index * 20480 < bytes.length; index++) await send({
				type: "screen-chunk",
				terminalEpoch: target.terminalEpoch,
				sequence: value.sequence,
				index,
				data: bytes.subarray(index * 20480, (index + 1) * 20480).toString("base64")
			});
			await send({
				type: "screen-end",
				terminalEpoch: target.terminalEpoch,
				sequence: value.sequence
			});
		};
		ws.on("error", close);
		ws.on("close", close);
		ws.on("message", (raw, binary) => {
			(async () => {
				if (dead || binary) throw new Error();
				const frame = parseTerminalJson(new TextDecoder("utf-8", { fatal: true }).decode(raw));
				if (!reservation) {
					exact(frame, "access,csrf,nonce,target,type");
					if (frame.type !== "attach" || typeof frame.nonce !== "string") throw new Error();
					const nonce = nonces.get(frame.nonce);
					nonces.delete(frame.nonce);
					if (!nonce || nonce.expires <= Date.now() || frame.access !== nonce.access || !sameTerminal(parseTerminalTarget(frame.target), nonce.target)) throw new Error();
					request.headers["x-pi-hub-terminal-csrf"] = frame.csrf;
					validate(request, nonce.session, nonce.target, nonce.access);
					reservation = nonce;
					const identity = generation;
					let sentReady = false;
					const ensureReady = async () => {
						if (!sentReady) {
							sentReady = true;
							await send({
								type: "ready",
								target: nonce.target
							});
						}
					};
					if (!terminal.provider) throw new Error();
					const live = await connectTerminalProvider(terminal.provider, nonce.target, nonce.access, {
						authorizationId: nonce.session.authorizationId,
						connectionId: randomBytes(16).toString("hex")
					}, {
						signal: abort.signal,
						onSnapshot: async (value) => {
							check();
							await ensureReady();
							await snapshot(value);
						},
						onUnavailable: close
					});
					if (dead || generation !== identity) {
						live.close();
						return;
					}
					provider = live;
					check();
					if (!initialized) {
						initialized = true;
						pending--;
						clearTimeout(timer);
					}
					await ensureReady();
					return;
				}
				check();
				const { csrf, target, ...action } = frame;
				if (csrf !== request.headers["x-pi-hub-terminal-csrf"] || !sameTerminal(parseTerminalTarget(target), reservation.target) || reservation.access !== "write" || !provider) throw new Error();
				const command = parseTerminalRequest(action);
				if (command.id <= lastId) throw new Error();
				lastId = command.id;
				if (command.type === "release") {
					close();
					return;
				}
				if (command.type === "acquire") {
					if (acquiring || inputAllowed) throw new Error();
					acquiring = true;
				} else if (!inputAllowed) throw new Error();
				const identity = generation;
				const result = await provider.request(command);
				check();
				if (identity !== generation) throw new Error();
				if (command.type === "acquire") {
					acquiring = false;
					inputAllowed = result.ok === true;
				}
				if (command.type === "input" && result.delivery !== "written") inputAllowed = false;
				await send({
					type: "response",
					id: command.id,
					result
				});
			})().catch(close);
		});
	}
	const sweep = setInterval(prune, 100);
	sweep.unref();
	try {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(terminal.port, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		url = `http://127.0.0.1:${server.address().port}/`;
		if ([url, terminal.publicUrl].some((origin) => origin && otherOrigins.some((other) => terminal.publicUrl && new URL(origin).protocol === "https:" ? new URL(other).hostname === new URL(origin).hostname : new URL(other).origin === new URL(origin).origin))) throw new Error("Terminal origin must differ from chat and management");
	} catch (error) {
		closed = true;
		clearInterval(sweep);
		auth.close();
		for (const socket of connections) socket.destroy();
		await new Promise((resolve) => server.close(() => resolve()));
		wss.close();
		throw error;
	}
	let closing;
	return {
		url,
		close() {
			if (closing) return closing;
			closed = true;
			clearInterval(sweep);
			for (const peer of peers) peer.close();
			nonces.clear();
			auth.close();
			for (const socket of connections) socket.destroy();
			closing = Promise.all([new Promise((resolve) => server.close(() => resolve())), new Promise((resolve) => wss.close(() => resolve()))]).then(() => {});
			return closing;
		}
	};
}
//#endregion
//#region hub/version-status.ts
var SHA256 = /^[a-f0-9]{64}$/;
var COMMIT = /^[a-f0-9]{40}$/;
var CACHE_MS = 300 * 1e3;
var REQUEST_TIMEOUT_MS = 8e3;
var MAX_BODY_BYTES = 256 * 1024;
var PACKAGE_NAME = "@kkkiio/pi-web-ui";
var PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function boundedBody(response, signal) {
	if (!response.ok || response.redirected) {
		await response.body?.cancel().catch(() => {});
		throw new Error("Version source unavailable");
	}
	const length = response.headers.get("content-length");
	if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
		await response.body?.cancel().catch(() => {});
		throw new Error("Version source response too large");
	}
	if (!response.body) throw new Error("Version source response unavailable");
	const reader = response.body.getReader();
	const cancel = () => {
		reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	const chunks = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_BODY_BYTES) {
				await reader.cancel();
				throw new Error("Version source response too large");
			}
			chunks.push(value);
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}
async function boundedJson(response, signal) {
	try {
		return JSON.parse((await boundedBody(response, signal)).toString("utf8"));
	} catch {
		throw new Error("Invalid version source response");
	}
}
async function boundedText(response, signal) {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(response, signal));
	} catch {
		throw new Error("Invalid version source response");
	}
}
async function getResponse(fetcher, url, signal, headers, timeoutMs, read) {
	if (signal.aborted) throw new Error("Version source aborted");
	const controller = new AbortController();
	const requestSignal = AbortSignal.any([signal, controller.signal]);
	let timer;
	let onAbort;
	const expired = new Promise((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(/* @__PURE__ */ new Error("Version source timed out"));
			controller.abort();
		}, timeoutMs);
		timer.unref?.();
	});
	const cancelled = new Promise((_resolve, reject) => {
		onAbort = () => reject(/* @__PURE__ */ new Error("Version source aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([
			Promise.resolve().then(async () => {
				return read(await fetcher(url, {
					method: "GET",
					redirect: "error",
					signal: requestSignal,
					headers: {
						Accept: "application/json",
						...headers
					}
				}), requestSignal);
			}),
			expired,
			cancelled
		]);
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}
function getJson(fetcher, url, signal, headers, timeoutMs) {
	return getResponse(fetcher, url, signal, headers, timeoutMs, boundedJson);
}
function getText(fetcher, url, signal, headers, timeoutMs) {
	return getResponse(fetcher, url, signal, headers, timeoutMs, boundedText);
}
var ATOM_NAMESPACE = "http://www.w3.org/2005/Atom";
var ATOM_COMMIT_ID = /^tag:github.com,2008:Grit::Commit\/([a-f0-9]{40})$/;
/** A deliberately narrow Atom reader: accept only GitHub's fixed feed and its first direct entry ID. */
function firstAtomCommit(xml) {
	const stack = [];
	let index = 0;
	let rootSeen = false;
	let entrySeen = false;
	let idSeen = false;
	let idClosed = false;
	let idInvalid = false;
	let idText = "";
	const inFirstId = () => entrySeen && stack.length === 3 && stack[0] === "feed" && stack[1] === "entry" && stack[2] === "id";
	while (index < xml.length) {
		const nextTag = xml.indexOf("<", index);
		const textEnd = nextTag < 0 ? xml.length : nextTag;
		const text = xml.slice(index, textEnd);
		if (inFirstId()) {
			if (text.includes("&")) idInvalid = true;
			idText += text;
		} else if (!stack.length && text.trim()) return;
		if (nextTag < 0) break;
		index = nextTag;
		if (xml.startsWith("<!--", index)) {
			const end = xml.indexOf("-->", index + 4);
			if (end < 0) return void 0;
			if (inFirstId()) idInvalid = true;
			index = end + 3;
			continue;
		}
		if (xml.startsWith("<?", index)) {
			const end = xml.indexOf("?>", index + 2);
			if (end < 0) return void 0;
			if (inFirstId()) idInvalid = true;
			index = end + 2;
			continue;
		}
		if (xml.startsWith("<![CDATA[", index)) {
			const end = xml.indexOf("]]>", index + 9);
			if (end < 0) return void 0;
			if (inFirstId()) idInvalid = true;
			index = end + 3;
			continue;
		}
		if (xml.startsWith("<!", index)) return void 0;
		let end = index + 1;
		let quote = "";
		for (; end < xml.length; end++) {
			const char = xml[end];
			if (quote) {
				if (char === quote) quote = "";
			} else if (char === "\"" || char === "'") quote = char;
			else if (char === ">") break;
		}
		if (end === xml.length || quote) return void 0;
		const source = xml.slice(index + 1, end).trim();
		index = end + 1;
		if (source.startsWith("/")) {
			const match = /^\/([A-Za-z][A-Za-z0-9._-]*(?::[A-Za-z][A-Za-z0-9._-]*)?)\s*$/.exec(source);
			if (!match || stack.at(-1) !== match[1]) return void 0;
			const name = stack.pop();
			if (name === "id" && entrySeen && stack.length === 2 && stack[1] === "entry") idClosed = true;
			if (name === "entry" && entrySeen && stack.length === 1 && stack[0] === "feed") return (idSeen && idClosed && !idInvalid ? ATOM_COMMIT_ID.exec(idText) : void 0)?.[1];
			if (name === "feed" && stack.length === 0) rootSeen = true;
			continue;
		}
		const selfClosing = source.endsWith("/");
		const opening = selfClosing ? source.slice(0, -1).trimEnd() : source;
		const tag = /^([A-Za-z][A-Za-z0-9._-]*(?::[A-Za-z][A-Za-z0-9._-]*)?)([\s\S]*)$/.exec(opening);
		if (!tag) return void 0;
		const name = tag[1];
		let attributes = tag[2];
		const attrs = {};
		while (attributes.trim()) {
			attributes = attributes.trimStart();
			const attribute = /^([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/.exec(attributes);
			if (!attribute || Object.hasOwn(attrs, attribute[1])) return void 0;
			attrs[attribute[1]] = attribute[3] ?? attribute[4];
			attributes = attributes.slice(attribute[0].length);
		}
		if (!rootSeen && !stack.length) {
			if (name !== "feed" || attrs.xmlns !== ATOM_NAMESPACE || selfClosing) return void 0;
		} else if (!stack.length) return;
		else if (Object.hasOwn(attrs, "xmlns")) return;
		else if (name === "entry" && stack.length === 1 && stack[0] === "feed" && !entrySeen) entrySeen = true;
		else if (inFirstId()) idInvalid = true;
		if (entrySeen && name === "id" && stack.length === 2 && stack[0] === "feed" && stack[1] === "entry") {
			if (idSeen) idInvalid = true;
			idSeen = true;
			if (Object.keys(attrs).length) idInvalid = true;
		}
		if (selfClosing) {
			if (name === "id" && entrySeen && stack.length === 2 && stack[1] === "entry") idClosed = true;
			if (name === "entry" && entrySeen && stack.length === 1 && stack[0] === "feed") return void 0;
		} else stack.push(name);
	}
}
/** Read only the fixed, public package sources; a single immutable Git revision supplies Web UI version and build. */
async function fetchLatestVersions(fetcher, signal, requestTimeoutMs = 2e3) {
	const settled = await Promise.allSettled([getJson(fetcher, "https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest", signal, void 0, requestTimeoutMs), getJson(fetcher, "https://api.github.com/repos/swordfate3/pi-web-ui/git/ref/heads/main", signal, {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "pi-web-ui-hub-version-check"
	}, requestTimeoutMs)]);
	let pi;
	const piPayload = settled[0].status === "fulfilled" ? settled[0].value : void 0;
	if (isRecord(piPayload) && piPayload.name === PI_PACKAGE_NAME && isStableSemver(piPayload.version)) pi = Object.freeze({ version: piPayload.version });
	let refPayload = settled[1].status === "fulfilled" ? settled[1].value : void 0;
	const isValidRef = (payload) => {
		const object = isRecord(payload) ? payload.object : void 0;
		return isRecord(object) && object.type === "commit" && typeof object.sha === "string" && COMMIT.test(object.sha);
	};
	if (!isValidRef(refPayload)) {
		refPayload = void 0;
		if (signal.aborted) throw new Error("Version source aborted");
		try {
			const revision = firstAtomCommit(await getText(fetcher, "https://github.com/swordfate3/pi-web-ui/commits/main.atom", signal, { Accept: "application/atom+xml" }, requestTimeoutMs));
			if (revision) refPayload = { object: {
				type: "commit",
				sha: revision
			} };
		} catch {
			if (signal.aborted) throw new Error("Version source aborted");
		}
	}
	const object = isRecord(refPayload) ? refPayload.object : void 0;
	let webUi;
	if (isRecord(object) && object.type === "commit" && typeof object.sha === "string" && COMMIT.test(object.sha)) {
		if (signal.aborted) throw new Error("Version source aborted");
		const revision = object.sha;
		const webResults = await Promise.allSettled([getJson(fetcher, `https://raw.githubusercontent.com/swordfate3/pi-web-ui/${revision}/package.json`, signal, void 0, requestTimeoutMs), getJson(fetcher, `https://raw.githubusercontent.com/swordfate3/pi-web-ui/${revision}/dist/build-manifest.json`, signal, void 0, requestTimeoutMs)]);
		const webPayload = webResults[0].status === "fulfilled" ? webResults[0].value : void 0;
		const manifestPayload = webResults[1].status === "fulfilled" ? webResults[1].value : void 0;
		const source = isRecord(manifestPayload) ? manifestPayload.source : void 0;
		if (isRecord(webPayload) && webPayload.name === PACKAGE_NAME && isStableSemver(webPayload.version) && isRecord(source) && typeof source.sha256 === "string" && SHA256.test(source.sha256)) webUi = Object.freeze({
			version: webPayload.version,
			build: source.sha256
		});
	}
	if (signal.aborted) throw new Error("Version source aborted");
	if (!pi && !webUi) throw new Error("Public version metadata unavailable");
	return Object.freeze({
		...pi ? { pi } : {},
		...webUi ? { webUi } : {}
	});
}
/** Capture the Hub's loaded build identity, even when deployed without the surrounding package. */
function captureHubMetadata(moduleUrl = import.meta.url) {
	{
		const embedded = {
			"version": "1.0.1",
			"build": "0c26c986bc6f800373bfb269299b1055651c2119a9299e63b4b5ae4bb93e854f"
		};
		if (embedded && isStableSemver(embedded.version) && SHA256.test(embedded.build)) return Object.freeze({
			version: embedded.version,
			build: embedded.build
		});
		return;
	}
	let directory = path.dirname(fileURLToPath(moduleUrl));
	let root;
	for (let depth = 0; depth < 8; depth++) {
		try {
			const packagePath = path.join(directory, "package.json");
			if (statSync(packagePath).size > 32 * 1024) throw new Error();
			const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
			if (isRecord(manifest) && manifest.name === PACKAGE_NAME && isStableSemver(manifest.version)) {
				root = directory;
				break;
			}
		} catch {}
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	if (!root) return void 0;
	try {
		const packagePath = path.join(root, "package.json");
		const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
		let build;
		try {
			const buildPath = path.join(root, "dist", "build-manifest.json");
			if (statSync(buildPath).size > MAX_BODY_BYTES) throw new Error();
			const buildManifest = JSON.parse(readFileSync(buildPath, "utf8"));
			const source = isRecord(buildManifest) ? buildManifest.source : void 0;
			if (isRecord(source) && typeof source.sha256 === "string" && SHA256.test(source.sha256)) build = source.sha256;
		} catch {}
		return Object.freeze({
			version: manifest.version,
			...build ? { build } : {}
		});
	} catch {
		return;
	}
}
/** Background-only, single-flight version lookup with bounded requests and cooldown even after failures. */
function createVersionStatus(options = {}) {
	const now = options.now ?? Date.now;
	const cacheMs = Math.max(CACHE_MS, options.cacheMs ?? 0);
	const timeoutMs = Math.max(1, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
	const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
	const source = options.source ?? (process.env.PI_OFFLINE === "1" ? async (_signal) => {
		throw new Error("Version checks disabled in offline mode");
	} : (signal) => fetchLatestVersions(fetcher, signal));
	const localHub = options.hub ?? captureHubMetadata();
	const hub = localHub ? Object.freeze({ ...localHub }) : void 0;
	let status = Object.freeze({
		status: "checking",
		...hub ? { hub } : {}
	});
	let inFlight;
	let timer;
	let controller;
	let activeTimeout;
	let rejectActive;
	let nextCheckAt = 0;
	let closed = false;
	const check = () => {
		if (closed || inFlight) return inFlight ?? Promise.resolve();
		if (now() < nextCheckAt) return Promise.resolve();
		if (timer) clearTimeout(timer);
		timer = void 0;
		controller = new AbortController();
		const active = controller;
		let rejectTimeout;
		const expired = new Promise((_resolve, reject) => {
			rejectTimeout = reject;
		});
		rejectActive = rejectTimeout;
		activeTimeout = setTimeout(() => {
			active.abort();
			rejectTimeout(/* @__PURE__ */ new Error("Version check timed out"));
		}, timeoutMs);
		activeTimeout.unref?.();
		inFlight = (async () => {
			try {
				const result = await Promise.race([Promise.resolve().then(() => source(active.signal)), expired]);
				if (closed || active.signal.aborted) return;
				if (!isRecord(result) || Object.keys(result).some((key) => key !== "pi" && key !== "webUi")) throw new Error("Invalid version source result");
				const pi = result.pi;
				const webUi = result?.webUi;
				const validPi = isRecord(pi) && Object.keys(pi).join(",") === "version" && isStableSemver(pi.version);
				const validWeb = isRecord(webUi) && Object.keys(webUi).sort().join(",") === "build,version" && isStableSemver(webUi.version) && typeof webUi.build === "string" && SHA256.test(webUi.build);
				if (!validPi && !validWeb) throw new Error("Invalid version source result");
				status = Object.freeze({
					status: validPi && validWeb ? "ok" : "partial",
					checkedAt: now(),
					...validPi ? { pi: Object.freeze({ version: pi.version }) } : {},
					...validWeb ? { webUi: Object.freeze({
						version: webUi.version,
						build: webUi.build
					}) } : {},
					...hub ? { hub } : {}
				});
			} catch {
				if (closed) return;
				status = Object.freeze({
					status: "unavailable",
					checkedAt: now(),
					...hub ? { hub } : {}
				});
			} finally {
				if (activeTimeout) clearTimeout(activeTimeout);
				activeTimeout = void 0;
				rejectActive = void 0;
				if (controller === active) controller = void 0;
				inFlight = void 0;
				if (!closed) {
					nextCheckAt = now() + cacheMs;
					timer = setTimeout(() => {
						timer = void 0;
						check();
					}, Math.max(0, nextCheckAt - now()));
					timer.unref?.();
				}
			}
		})();
		return inFlight;
	};
	return {
		snapshot: () => status,
		ensureStarted: () => {
			check();
		},
		/** Test/maintenance seam. HTTP handlers use snapshot only and never await this. */
		refresh: check,
		close: () => {
			if (closed) return;
			closed = true;
			if (timer) clearTimeout(timer);
			timer = void 0;
			if (activeTimeout) clearTimeout(activeTimeout);
			activeTimeout = void 0;
			controller?.abort();
			rejectActive?.(/* @__PURE__ */ new Error("Version checker closed"));
			rejectActive = void 0;
		}
	};
}
//#endregion
//#region hub/server.ts
init_config();
init_state_budget();
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
	for (const [key, value] of Object.entries(request.headers)) if (!hop.has(key) && !key.startsWith("x-pi-web-") && !key.startsWith("x-pi-hub-") && !key.startsWith("x-forwarded-") && key !== "forwarded") headers[key] = value;
	headers["x-pi-web-generation"] = session.generation;
	headers["x-pi-web-proof"] = mac(session.grant.token, session.generation);
	return headers;
}
function boundedDeflateOffer(header) {
	if (!header) return false;
	const [extension, ...parameters] = header.split(";").map((value) => value.trim());
	if (extension !== "permessage-deflate") return false;
	const seen = /* @__PURE__ */ new Set();
	for (const parameter of parameters) {
		const [name, value, ...extra] = parameter.split("=");
		if (seen.has(name) || extra.length) return false;
		seen.add(name);
		if (name === "client_no_context_takeover" || name === "server_no_context_takeover") {
			if (value !== void 0) return false;
		} else if (name === "client_max_window_bits") {
			if (value !== void 0 && !/^1[2-5]$/.test(value)) return false;
		} else if (name === "server_max_window_bits") {
			if (value === void 0 || !/^1[2-5]$/.test(value)) return false;
		} else return false;
	}
	return seen.has("client_max_window_bits");
}
/** Explicitly launched independent process; never imported as a Pi extension entry. */
async function startHub(config, options = {}) {
	if (config.management) managementConfig(config.management, config.port, config.publicUrl);
	if (config.terminal) terminalConfig(config.terminal, config.port, config.publicUrl, config.management);
	const serving = acquireStateLock(config, ".serving.lock");
	config = {
		...config,
		stateDir: serving.root
	};
	try {
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
			const hub = await startLockedHub(config, options);
			let closing;
			return {
				...hub,
				close: () => {
					closing ??= hub.close().finally(() => {
						release();
						serving.release();
					});
					return closing;
				}
			};
		} catch (error) {
			release();
			throw error;
		}
	} catch (error) {
		serving.release();
		throw error;
	}
}
async function startLockedHub(config, options) {
	privateDirectory(config.stateDir);
	privateDirectory(config.runtimeDir);
	privateDirectory(path.join(config.stateDir, "grants"));
	privateDirectory(path.join(config.stateDir, "generations"));
	privateDirectory(path.join(config.stateDir, "bounded"));
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
	withStateWriter(config, (writer) => writer.write("registry.json", {
		schema: 2,
		boot
	}, { security: true }));
	const sessions = /* @__PURE__ */ new Map();
	const peers = /* @__PURE__ */ new Set();
	const connections = /* @__PURE__ */ new Set();
	const webSockets = /* @__PURE__ */ new Map();
	const outbound = /* @__PURE__ */ new Map();
	const sendControl = (client, value) => outbound.get(client)?.enqueue(value);
	let activeProbes = 0;
	const proof = async (grant, generation, port) => {
		if (activeProbes >= HUB_LIMITS.backendProbes) throw new RegistryError("HUB_BUSY");
		activeProbes++;
		try {
			return await proveBackend(grant, generation, port);
		} finally {
			activeProbes--;
		}
	};
	const handoffs = /* @__PURE__ */ new Map();
	const pruneHandoffs = () => {
		for (const [token, item] of handoffs) if (item.expires <= Date.now()) handoffs.delete(token);
	};
	let stopped = false;
	let pending = Promise.resolve();
	let admittedRegistrations = 0;
	const versionStatus = createVersionStatus(options.versions);
	let url = "";
	let managementUrl;
	let terminalServer;
	const restarting = /* @__PURE__ */ new Map();
	const activateRestart = (generation) => {
		const restart = restarting.get(generation);
		if (!restart) return;
		restart.deadline ??= Date.now() + 21e4;
		for (const item of handoffs.values()) if (item.restart === restart) item.expires = restart.deadline;
	};
	const retire = (generation, writer) => {
		activateRestart(generation);
		const session = sessions.get(generation);
		sessions.delete(generation);
		for (const [ws, id] of webSockets) if (id === generation) ws.terminate();
		if (session && isBoundedGeneration(generation)) {
			const clear = (transaction) => {
				const record = boundedRecord(config, session.grant.run_id, boot);
				if (record.current?.generation === generation) {
					delete record.current;
					saveBounded(transaction, record, true);
				}
			};
			try {
				if (writer) clear(writer);
				else withStateWriter(config, clear);
			} catch {}
		}
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
	const granted = (runId) => {
		try {
			return !readGrant(config, runId).revoked;
		} catch {
			return false;
		}
	};
	const verified = async (generation) => {
		const session = current(generation);
		if (!session || !await proof(session.grant, generation, session.port) || stopped || current(generation) !== session) return void 0;
		return session;
	};
	const restartApi = createRestartApi(config, {
		clearHandoff: (id) => {
			for (const [generation, item] of restarting) if (item.id === id) restarting.delete(generation);
			for (const [token, item] of handoffs) {
				if (item.restart?.id !== id) continue;
				const original = current(item.from);
				if (item.client?.readyState !== WebSocket.OPEN || webSockets.get(item.client) !== item.from || original?.grant.run_id !== item.grant.run_id || original.runtime?.runtimeId !== item.restart.runtimeId) {
					handoffs.delete(token);
					continue;
				}
				item.originalRuntimeId = item.restart.runtimeId;
				item.restart = void 0;
				item.successor = item.from;
				item.expires = Infinity;
				sendControl(item.client, JSON.stringify({
					type: "event",
					event: "hub_route",
					payload: {
						generation: item.from,
						token
					}
				}));
			}
		},
		granted,
		lookup: async (generation) => {
			const session = await verified(generation);
			return session ? {
				runId: session.grant.run_id,
				generation,
				runtime: session.runtime
			} : void 0;
		},
		successor: async (runId, runtimeId, sessionId, leafId, version) => {
			for (const generation of sessions.keys()) {
				const session = current(generation);
				const runtime = session?.runtime;
				if (session?.grant.run_id !== runId || !runtime?.managed || runtime.runtimeId !== runtimeId || runtime.sessionId !== sessionId || runtime.leafId !== leafId || runtime.version !== version) continue;
				const proved = await verified(generation);
				const fresh = proved?.runtime;
				if (proved?.grant.run_id === runId && fresh?.managed && fresh.runtimeId === runtimeId && fresh.sessionId === sessionId && fresh.leafId === leafId && fresh.version === version) return `/s/${generation}/`;
			}
		},
		prepareHandoff: (runId, receipt) => {
			const selected = current(receipt.generation);
			if (!selected || selected.grant.run_id !== runId || selected.runtime?.runtimeId !== receipt.runtimeId || selected.runtime.sessionId !== receipt.sessionId || selected.runtime.leafId !== receipt.leafId) throw new Error("Session changed");
			const restart = {
				id: receipt.id,
				runtimeId: receipt.runtimeId
			};
			restarting.set(receipt.generation, restart);
			for (const [token, item] of handoffs) {
				if (item.from !== receipt.generation || item.grant.run_id !== runId) continue;
				item.restart = restart;
				item.expires = Infinity;
				if (!item.client) activateRestart(receipt.generation);
				if (item.client?.readyState === WebSocket.OPEN) sendControl(item.client, JSON.stringify({
					type: "event",
					event: "hub_route",
					payload: {
						generation: item.from,
						token,
						restart: {
							id: receipt.id,
							timeoutMs: 12e4
						}
					}
				}));
			}
		}
	});
	const register = async (value) => {
		const authenticate = () => {
			if (stopped || typeof value.run_id !== "string") throw new RegistryError("AUTH_FAILED");
			const grant = readGrant(config, value.run_id);
			if (grant.revoked || !equal(value.token, grant.token)) throw new RegistryError("AUTH_FAILED");
			return grant;
		};
		if (value.action === "registry_negotiate") return withStateWriter(config, () => {
			const grant = authenticate();
			if (typeof value.nonce !== "string" || !/^[a-f0-9]{32}$/.test(value.nonce) || typeof value.protocol !== "string" || !/^[a-z0-9-]{1,64}$/.test(value.protocol)) throw new RegistryError("PROTOCOL_REJECTED");
			if (value.protocol !== "bounded-v2") {
				const legacy = hasBoundedRecord(config, grant.run_id) ? void 0 : "legacy-v1";
				return {
					unsupported: true,
					protocol: value.protocol,
					nonce: value.nonce,
					...legacy ? { legacy } : {},
					proof: mac(grant.token, `${value.nonce}:${value.protocol}:UNSUPPORTED_PROTOCOL:${legacy ?? ""}`)
				};
			}
			const record = boundedRecord(config, grant.run_id, boot);
			return {
				protocol: BOUNDED_PROTOCOL,
				nonce: value.nonce,
				boot,
				slot: record.slot,
				proof: mac(grant.token, `${value.nonce}:${BOUNDED_PROTOCOL}:${boot}:${record.slot}`)
			};
		});
		const bounded = [
			"bounded_issue",
			"bounded_register",
			"bounded_unregister"
		].includes(String(value.action));
		if (bounded ? value.protocol !== "bounded-v2" || value.boot !== boot : value.protocol !== void 0) throw new RegistryError("PROTOCOL_REJECTED");
		if (value.action === "bounded_issue") return withStateWriter(config, (writer) => {
			const grant = authenticate();
			writer.assertAdmission();
			return issueBounded(writer, boundedRecord(config, grant.run_id, boot), value, (generation) => !!current(generation));
		});
		if (typeof value.generation !== "string" || !(bounded ? isBoundedGeneration(value.generation) : /^[a-f0-9]{32}$/.test(value.generation))) throw new RegistryError("PROTOCOL_REJECTED");
		const generation = value.generation;
		const ledger = path.join(config.stateDir, "generations", `${generation}.json`);
		const readOwner = () => existsSync(ledger) ? readPrivateJson(ledger) : void 0;
		if (value.action === "unregister" || value.action === "bounded_unregister") return withStateWriter(config, (writer) => {
			const grant = authenticate();
			const session = current(generation);
			if (bounded) {
				const record = boundedRecord(config, grant.run_id, boot);
				let changed = false;
				for (const key of ["current", "pending"]) if (record[key]?.generation === generation) {
					delete record[key];
					changed = true;
				}
				if (changed) saveBounded(writer, record, true);
			} else {
				if (hasBoundedRecord(config, grant.run_id)) throw new RegistryError("PROTOCOL_REJECTED");
				const owner = readOwner();
				if (session && session.grant.run_id !== grant.run_id || owner && owner.run_id !== grant.run_id) throw new RegistryError("AUTH_FAILED");
				if (!owner || session && !owner.retired) writer.write(`generations/${generation}.json`, {
					boot,
					run_id: grant.run_id,
					retired: true
				}, {
					exclusive: !owner,
					security: !!owner
				});
			}
			if (session?.grant.run_id === grant.run_id) retire(generation, writer);
			return {};
		});
		if (value.action !== "register" && value.action !== "bounded_register" || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) throw new RegistryError("PROTOCOL_REJECTED");
		if (value.sessionName !== void 0 && value.sessionName !== null && (typeof value.sessionName !== "string" || value.sessionName.length > 256)) throw new Error("Registration rejected");
		const sessionName = typeof value.sessionName === "string" ? value.sessionName.replace(/\p{Cc}/gu, " ").trim() || null : null;
		const runtime = value.runtime === void 0 ? void 0 : readRuntimeMetadata(value.runtime);
		const software = value.software === void 0 ? void 0 : readSoftwareMetadata(value.software);
		const port = Number(value.port);
		const prepared = withStateWriter(config, (writer) => {
			const grant = authenticate();
			writer.assertAdmission();
			const session = current(generation);
			if (bounded) {
				const record = boundedRecord(config, grant.run_id, boot);
				boundedTuple(record, generation, port, !!session);
				return {
					grant,
					session,
					revision: record.revision,
					owner: void 0
				};
			}
			if (hasBoundedRecord(config, grant.run_id)) throw new RegistryError("PROTOCOL_REJECTED");
			const owner = readOwner();
			if (owner && (owner.retired || owner.boot !== boot || owner.run_id !== grant.run_id || !session || session.port !== port)) throw new RegistryError();
			return {
				grant,
				session,
				revision: void 0,
				owner: JSON.stringify(owner)
			};
		});
		const { grant, session } = prepared;
		if (!await proof(grant, generation, port) || stopped) throw new RegistryError("PROOF_FAILED");
		return withStateWriter(config, (writer) => {
			const latestGrant = authenticate();
			writer.assertAdmission();
			if (latestGrant.token !== grant.token || latestGrant.backendHost !== grant.backendHost) throw new RegistryError("AUTH_FAILED");
			if (session && current(generation) !== session) throw new RegistryError();
			if (bounded) {
				const record = boundedRecord(config, grant.run_id, boot);
				if (record.revision !== prepared.revision) throw new RegistryError();
				if (boundedTuple(record, generation, port, !!session && current(generation) === session) === "pending") {
					record.current = record.pending;
					delete record.pending;
				}
				record.current.expires = Date.now() + config.leaseMs;
				saveBounded(writer, record);
			} else {
				if (hasBoundedRecord(config, grant.run_id) || JSON.stringify(readOwner()) !== prepared.owner) throw new RegistryError();
				if (!readOwner()) writer.write(`generations/${generation}.json`, {
					boot,
					run_id: grant.run_id
				}, { exclusive: true });
			}
			for (const other of sessions.values()) if (other.grant.run_id === grant.run_id && other.generation !== generation) retire(other.generation, writer);
			if (session) {
				session.expires = Date.now() + config.leaseMs;
				session.sessionName = sessionName;
				session.runtime = runtime;
				session.software = software;
			} else sessions.set(generation, {
				grant,
				generation,
				port,
				expires: Date.now() + config.leaseMs,
				since: Date.now(),
				sessionName,
				runtime,
				software
			});
			pruneHandoffs();
			if (!session) {
				for (const item of handoffs.values()) if (!item.restart && item.grant.run_id === grant.run_id && item.from !== generation && !item.successor) item.successor = generation;
			}
			return { url: `${config.publicUrl ?? url}s/${generation}/` };
		});
	};
	const registry = net.createServer((socket) => {
		if (peers.size >= HUB_LIMITS.registrationPeers) {
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
		const reply = (ok, result, error = "Registration rejected", code) => {
			if (!socket.destroyed) socket.end(`${JSON.stringify(ok ? {
				ok,
				result
			} : {
				ok,
				error,
				...code ? { code } : {}
			})}\n`);
		};
		socket.on("data", (chunk) => {
			if (received) return;
			if (data.length + chunk.length > 8192) {
				received = true;
				reply(false);
				return;
			}
			data = Buffer.concat([data, chunk]);
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
			data = Buffer.alloc(0);
			if (admittedRegistrations >= HUB_LIMITS.registrationOperations) {
				reply(false, void 0, "Registration rejected", "HUB_BUSY");
				return;
			}
			admittedRegistrations++;
			pending = pending.then(async () => {
				if (socket.destroyed) return;
				try {
					const result = await register(value);
					if ("unsupported" in result) {
						const { unsupported: _unsupported, ...details } = result;
						if (!socket.destroyed) socket.end(`${JSON.stringify({
							ok: false,
							error: "Unsupported registration protocol",
							code: "UNSUPPORTED_PROTOCOL",
							...details
						})}\n`);
					} else reply(true, result);
				} catch (error) {
					reply(false, void 0, error instanceof Error && error.message === "ended generation" ? "ended generation" : "Registration rejected", error instanceof RegistryError ? error.code : error instanceof StateBudgetError ? "STATE_QUOTA" : void 0);
				}
			}).finally(() => {
				admittedRegistrations--;
			});
		});
	});
	const allowedBrowser = (request, requireOrigin = false, admin = false) => {
		const local = admin ? managementUrl : url;
		const canonical = admin ? config.management?.publicUrl : config.publicUrl;
		if (!local) return false;
		const allowed = new Set([new URL(local).origin, ...canonical ? [new URL(canonical).origin] : []]);
		const hosts = new Set([...allowed].map((origin) => new URL(origin).host));
		const origin = request.headers.origin;
		return hosts.has(request.headers.host ?? "") && request.headers["sec-fetch-site"] !== "cross-site" && (origin === void 0 ? !requireOrigin : allowed.has(origin) && (!admin || new URL(origin).host === request.headers.host));
	};
	const routePattern = new RegExp(`^/s/(${HUB_GENERATION_SOURCE})(/.*)?$`);
	const matchRoute = (request) => routePattern.exec(request.url ?? "");
	const fail = (response, code) => response.writeHead(code, { "Cache-Control": "no-store" }).end();
	const handle = async (request, response, admin = false) => {
		try {
			if (!allowedBrowser(request, false, admin)) {
				fail(response, 403);
				return;
			}
			const pathname = request.url?.split("?")[0];
			if (admin) {
				if (config.management?.gateway && !gatewayIdentity(config, request)) {
					fail(response, 401);
					return;
				}
				if (await restartApi.handle(request, response, allowedBrowser(request, true, true))) return;
				if (![
					"/",
					"/sessions/",
					"/api/sessions",
					"/hub.js",
					"/hub-management.js",
					"/hub.css"
				].includes(pathname ?? "") || request.headers["service-worker"] !== void 0) {
					fail(response, 404);
					return;
				}
			} else if (pathname?.startsWith("/api/management/")) {
				if (request.method === "GET" && pathname === "/api/management/status") response.writeHead(200, {
					"Content-Type": "application/json",
					"Cache-Control": "no-store"
				}).end(JSON.stringify({
					available: false,
					authorized: false,
					...managementUrl ? { managementUrl: config.management?.publicUrl ?? managementUrl } : {}
				}));
				else fail(response, 404);
				return;
			}
			if (pathname === "/api/session-handoff") {
				if (request.method !== "POST") {
					fail(response, 405);
					return;
				}
				if (!allowedBrowser(request, true)) {
					fail(response, 403);
					return;
				}
				pruneHandoffs();
				const token = request.headers["x-pi-web-handoff"];
				const item = typeof token === "string" && /^[a-f0-9]{48}$/.test(token) ? handoffs.get(token) : void 0;
				if (!item) {
					fail(response, 410);
					return;
				}
				const grant = readGrant(config, item.grant.run_id);
				if (grant.revoked || !equal(grant.token, item.grant.token) || grant.backendHost !== item.grant.backendHost) {
					handoffs.delete(token);
					fail(response, 410);
					return;
				}
				if (item.restart) {
					try {
						const result = await restartApi.resolve(item.restart.id);
						if (item.expires <= Date.now() || !granted(item.grant.run_id)) throw new Error();
						if (result.status === "succeeded" && typeof result.path === "string") response.writeHead(200, {
							"Content-Type": "application/json",
							"Cache-Control": "no-store"
						}).end(JSON.stringify({ path: result.path }));
						else if ([
							"pending",
							"queued",
							"running"
						].includes(result.status)) response.writeHead(202, {
							"Content-Type": "application/json",
							"Cache-Control": "no-store"
						}).end(JSON.stringify({ pending: true }));
						else fail(response, 410);
					} catch {
						fail(response, 410);
					}
					return;
				}
				const targetGeneration = item.successor ?? item.from;
				const successor = current(targetGeneration);
				const proved = successor && await proof(grant, successor.generation, successor.port);
				const latestGrant = readGrant(config, grant.run_id);
				if (stopped || handoffs.get(token) !== item || item.expires <= Date.now() || latestGrant.revoked || !equal(latestGrant.token, grant.token) || latestGrant.backendHost !== grant.backendHost) {
					handoffs.delete(token);
					fail(response, 410);
					return;
				}
				if (!item.successor && (!proved || current(targetGeneration) !== successor) || targetGeneration !== item.successor && item.successor && current(item.successor)) {
					response.writeHead(202, {
						"Content-Type": "application/json",
						"Cache-Control": "no-store"
					}).end(JSON.stringify({ pending: true }));
					return;
				}
				if (!successor || successor.grant.run_id !== grant.run_id || !proved || stopped || current(targetGeneration) !== successor || item.originalRuntimeId !== void 0 && successor.runtime?.runtimeId !== item.originalRuntimeId || item.expires <= Date.now()) {
					fail(response, 410);
					return;
				}
				response.writeHead(200, {
					"Content-Type": "application/json",
					"Cache-Control": "no-store"
				}).end(JSON.stringify({ path: `/s/${successor.generation}/` }));
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
				if (!await proof(session.grant, session.generation, session.port)) {
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
					proxySessionResponse(request, response, result, route[2]);
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
				versionStatus.ensureStarted();
				const items = [...sessions.keys()].map(current).filter((s) => Boolean(s)).map((s) => ({
					label: s.grant.label,
					sessionName: s.sessionName,
					generation: s.generation,
					path: admin ? `${config.publicUrl ?? url}s/${s.generation}/` : `/s/${s.generation}/`,
					since: s.since,
					...s.runtime ? { runtime: {
						version: s.runtime.version,
						managed: s.runtime.managed
					} } : {},
					...s.software ? { software: s.software } : {}
				}));
				response.writeHead(200, {
					"Content-Type": "application/json",
					"Cache-Control": "no-store"
				}).end(JSON.stringify({
					sessions: items,
					versions: versionStatus.snapshot()
				}));
				return;
			}
			if (!admin && pathname === "/api/terminal-link") {
				response.writeHead(200, {
					"Content-Type": "application/json",
					"Cache-Control": "no-store"
				}).end(JSON.stringify({ url: terminalServer ? config.terminal?.publicUrl ?? terminalServer.url : null }));
				return;
			}
			const asset = pathname === "/sessions/" ? ["text/html", renderPortalHtml(admin, config.publicUrl ?? url, config.management?.publicUrl ?? managementUrl)] : pathname === "/hub.js" ? ["text/javascript", portalJs] : admin && pathname === "/hub-management.js" ? ["text/javascript", portalManagementJs] : pathname === "/hub.css" ? ["text/css", portalCss + portalManagementCss] : void 0;
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
		} catch (error) {
			if (!response.headersSent) fail(response, error instanceof RegistryError && error.code === "HUB_BUSY" ? 503 : 500);
			else response.destroy();
		}
	};
	const server = http.createServer((request, response) => void handle(request, response));
	const managementServer = config.management ? http.createServer((request, response) => void handle(request, response, true)) : void 0;
	managementServer?.on("connection", (socket) => {
		if (connections.size >= HUB_LIMITS.connections) {
			socket.destroy();
			return;
		}
		connections.add(socket);
		socket.on("error", () => socket.destroy());
		socket.once("close", () => connections.delete(socket));
	});
	managementServer?.on("clientError", (_error, socket) => socket.destroy());
	managementServer?.on("upgrade", (_request, socket) => socket.destroy());
	managementServer?.on("connect", (_request, socket) => socket.destroy());
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: HUB_LIMITS.inFlightBytes,
		perMessageDeflate: {
			serverNoContextTakeover: true,
			clientNoContextTakeover: true,
			serverMaxWindowBits: 12,
			clientMaxWindowBits: 12,
			concurrencyLimit: HUB_LIMITS.websocketCompression,
			threshold: 1024,
			zlibDeflateOptions: {
				level: 3,
				memLevel: 7
			}
		}
	});
	server.on("connection", (socket) => {
		if (connections.size >= HUB_LIMITS.connections) {
			socket.destroy();
			return;
		}
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
	let browserAdmissions = 0;
	server.on("upgrade", async (request, socket, head) => {
		let reserved = false;
		let upgradePending = true;
		let browserClosed = false;
		let upstreamSocket;
		let upstreamClosed = false;
		const release = () => {
			if (reserved && !upgradePending && browserClosed && (!upstreamSocket || upstreamClosed)) {
				reserved = false;
				browserAdmissions--;
			}
		};
		try {
			if (!allowedBrowser(request, true)) {
				rejectUpgrade(socket, 403);
				return;
			}
			if (browserAdmissions >= HUB_LIMITS.browserPairs) {
				rejectUpgrade(socket, 503);
				return;
			}
			browserAdmissions++;
			reserved = true;
			socket.once("close", () => {
				browserClosed = true;
				upstreamSocket?.terminate();
				release();
			});
			const route = matchRoute(request);
			const session = route && route[2] === "/ws" ? current(route[1]) : void 0;
			if (!session || !await proof(session.grant, session.generation, session.port) || stopped || current(session.generation) !== session) {
				if (!socket.destroyed) rejectUpgrade(socket, 410);
				return;
			}
			if (browserClosed || socket.destroyed || !reserved) return;
			const host = net.isIP(session.grant.backendHost) === 6 ? `[${session.grant.backendHost}]` : session.grant.backendHost;
			const headers = backendHeaders(request, session);
			delete headers["sec-websocket-extensions"];
			const upstream = new WebSocket(`ws://${host}:${session.port}/ws`, {
				headers,
				perMessageDeflate: false,
				handshakeTimeout: 3e3,
				maxPayload: HUB_LIMITS.inFlightBytes
			});
			upstreamSocket = upstream;
			webSockets.set(upstream, session.generation);
			const handshakeError = () => {
				if (!socket.destroyed) rejectUpgrade(socket, 502);
			};
			upstream.once("error", handshakeError);
			upstream.once("close", () => {
				upstreamClosed = true;
				webSockets.delete(upstream);
				release();
			});
			upstream.once("open", () => {
				upstream.removeListener("error", handshakeError);
				upstream.on("error", () => socket.destroy());
				if (stopped || current(session.generation) !== session || socket.destroyed) {
					upstream.terminate();
					socket.destroy();
					return;
				}
				if (!boundedDeflateOffer(request.headers["sec-websocket-extensions"])) delete request.headers["sec-websocket-extensions"];
				wss.handleUpgrade(request, socket, head, (client) => {
					webSockets.set(client, session.generation);
					let slowClosing = false;
					const slowPair = () => {
						if (slowClosing) return;
						slowClosing = true;
						for (const peer of [client, upstream]) {
							if (peer.readyState === WebSocket.OPEN) peer.close(1013, "Slow consumer; reconnect");
							const timer = setTimeout(() => peer.terminate(), 250);
							timer.unref();
							peer.once("close", () => clearTimeout(timer));
						}
					};
					const clientQueue = new ForwardQueue(client, slowPair);
					const upstreamQueue = new ForwardQueue(upstream, slowPair);
					outbound.set(client, clientQueue);
					const forward = (from, to) => {
						const queue = to === client ? clientQueue : upstreamQueue;
						from.on("message", (data, binary) => {
							if (slowClosing) return;
							if (from === upstream && !binary) try {
								const value = JSON.parse(data.toString());
								if (value?.type === "event" && value.event === "hub_route") return;
							} catch {}
							if (!queue.enqueue(data, binary)) slowPair();
						});
						from.once("close", () => {
							webSockets.delete(from);
							outbound.delete(from);
							clientQueue.dispose();
							upstreamQueue.dispose();
							if (!slowClosing) to.terminate();
						});
						from.on("error", () => to.terminate());
					};
					forward(client, upstream);
					forward(upstream, client);
					pruneHandoffs();
					if (handoffs.size < 512) {
						const token = randomBytes(24).toString("hex");
						const restart = restarting.get(session.generation);
						const activeRestart = restart && (restart.deadline === void 0 || restart.deadline > Date.now()) ? restart : void 0;
						const item = {
							grant: session.grant,
							from: session.generation,
							expires: activeRestart?.deadline ?? Infinity,
							client,
							restart: activeRestart
						};
						handoffs.set(token, item);
						client.once("close", () => {
							item.client = void 0;
							activateRestart(item.from);
							item.expires = item.restart?.deadline ?? Date.now() + 45e3;
						});
						sendControl(client, JSON.stringify({
							type: "event",
							event: "hub_route",
							payload: {
								generation: session.generation,
								token,
								...activeRestart ? { restart: {
									id: activeRestart.id,
									timeoutMs: 12e4
								} } : {}
							}
						}));
					}
				});
			});
		} catch {
			upstreamSocket?.terminate();
			if (!socket.destroyed) rejectUpgrade(socket, 502);
		} finally {
			upgradePending = false;
			release();
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
		if (managementServer && config.management) {
			await listen(managementServer, config.management.port, "127.0.0.1");
			managementUrl = `http://127.0.0.1:${managementServer.address().port}/`;
			const chatOrigins = [new URL(url).origin, ...config.publicUrl ? [new URL(config.publicUrl).origin] : []];
			if ([managementUrl, config.management.publicUrl].some((value) => value && chatOrigins.includes(new URL(value).origin))) throw new Error("Management origin must differ from chat origin");
		}
		if (config.terminal) terminalServer = await startTerminalServer(config, [
			url,
			config.publicUrl,
			managementUrl,
			config.management?.publicUrl
		].filter((value) => !!value));
	} catch (error) {
		stopped = true;
		versionStatus.close();
		await terminalServer?.close();
		for (const peer of peers) peer.destroy();
		for (const connection of connections) connection.destroy();
		await Promise.all([
			new Promise((resolve) => registry.close(() => resolve())),
			new Promise((resolve) => server.close(() => resolve())),
			...managementServer ? [new Promise((resolve) => managementServer.close(() => resolve()))] : []
		]);
		throw error;
	}
	const sweep = setInterval(() => {
		for (const id of sessions.keys()) current(id);
		pruneHandoffs();
		for (const [generation, item] of restarting) if (item.deadline !== void 0 && item.deadline <= Date.now()) restarting.delete(generation);
	}, Math.min(1e3, config.leaseMs));
	sweep.unref();
	let closing;
	return {
		url,
		...managementUrl ? { managementUrl } : {},
		...terminalServer ? { terminalUrl: terminalServer.url } : {},
		socketPath: config.socketPath,
		close() {
			if (closing) return closing;
			stopped = true;
			handoffs.clear();
			versionStatus.close();
			clearInterval(sweep);
			for (const id of sessions.keys()) retire(id);
			for (const peer of peers) peer.destroy();
			for (const connection of connections) connection.destroy();
			server.closeAllConnections();
			managementServer?.closeAllConnections();
			closing = Promise.all([
				new Promise((resolve) => server.close(() => resolve())),
				new Promise((resolve) => registry.close(() => resolve())),
				new Promise((resolve) => wss.close(() => resolve())),
				...managementServer ? [new Promise((resolve) => managementServer.close(() => resolve()))] : [],
				...terminalServer ? [terminalServer.close()] : [],
				pending
			]).then(() => {});
			return closing;
		}
	};
}
//#endregion
//#region bin/pi-web-hub.mjs
init_config();
var help = `Pi Web Hub — independent multi-session portal

  pi-web-hub init [--port 16180] [--public-url https://pi.example.com/]
    [--management-port 16181] [--management-public-url https://admin.example.com/]
    [--terminal-port 16182] [--terminal-public-url https://terminal.example.com/]
    [--terminal-provider-socket /run/pi-terminal-provider/provider.sock]
    [--terminal-provider-credential-file /run/pi-terminal-credentials/provider.token]
  pi-web-hub serve
  pi-web-hub issue --label "Project A" --output /private/session-a.json [--backend-host 127.0.0.1]
  pi-web-hub revoke --run-id <session-capability-id>
  pi-web-hub pair                     Generate a single-use management code (10 minutes)
  pi-web-hub revoke-management        Revoke all browser management sessions
  pi-web-hub pair-terminal --run-id <id> --runtime-id <id> --session-id <id>
    --terminal-epoch <id> --access <read|write>  Generate a scoped terminal code (10 minutes)
  pi-web-hub revoke-terminal          Revoke all browser terminal sessions

Terminal is opt-in and requires a real private Gate provider. Configure a distinct
public HTTPS hostname, not another port on the chat/admin hostname. Paste the
terminal code manually into that origin; no automatic attach, retry or renewal.
Hub UID/GID1000:1000 mounts only dedicated provider IPC/credential volumes read-only;
no Docker socket on Hub, no provider credential or authority on Pi. Keep cap-drop
ALL and no-new-privileges; no sudo. Missing input ACK means unknown, never resend.

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
			"--public-url",
			"--management-port",
			"--management-public-url",
			"--terminal-port",
			"--terminal-public-url",
			"--terminal-provider-socket",
			"--terminal-provider-credential-file"
		]],
		["serve", ["--config"]],
		["issue", [
			"--config",
			"--label",
			"--output",
			"--backend-host"
		]],
		["revoke", ["--config", "--run-id"]],
		["pair", ["--config"]],
		["revoke-management", ["--config"]],
		["pair-terminal", [
			"--config",
			"--run-id",
			"--runtime-id",
			"--session-id",
			"--terminal-epoch",
			"--access"
		]],
		["revoke-terminal", ["--config"]]
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
		let management;
		if (options.has("--management-public-url") && !options.has("--management-port")) throw new Error("Management port required");
		if (options.has("--management-port")) {
			const { managementConfig } = await Promise.resolve().then(() => (init_config(), config_exports));
			management = managementConfig({
				port: Number(options.get("--management-port")),
				...options.has("--management-public-url") ? { publicUrl: options.get("--management-public-url") } : {}
			}, port, publicUrl);
		}
		let terminal;
		const providerSocket = options.get("--terminal-provider-socket");
		const providerCredential = options.get("--terminal-provider-credential-file");
		if (Boolean(providerSocket) !== Boolean(providerCredential) || providerSocket && !options.has("--terminal-port")) throw new Error("Both private provider paths and terminal port are required");
		if (options.has("--terminal-public-url") && !options.has("--terminal-port")) throw new Error("Terminal port required");
		if (options.has("--terminal-port")) {
			const { terminalConfig } = await Promise.resolve().then(() => (init_config(), config_exports));
			terminal = terminalConfig({
				port: Number(options.get("--terminal-port")),
				...options.has("--terminal-public-url") ? { publicUrl: options.get("--terminal-public-url") } : {},
				...providerSocket ? { provider: {
					socketPath: providerSocket,
					credentialFile: providerCredential
				} } : {}
			}, port, publicUrl, management);
		}
		initializeHub(configFile, {
			port,
			...publicUrl ? { publicUrl } : {},
			...management ? { management } : {},
			...terminal ? { terminal } : {}
		});
		process.stdout.write(`${JSON.stringify({
			configured: true,
			configFile
		})}\n`);
		return;
	}
	const config = readHubConfig(configFile);
	if (command === "pair-terminal") process.stdout.write(`${JSON.stringify(issueTerminalCode(config, {
		runId: options.get("--run-id"),
		runtimeId: options.get("--runtime-id"),
		sessionId: options.get("--session-id"),
		terminalEpoch: options.get("--terminal-epoch"),
		access: options.get("--access")
	}))}\n`);
	else if (command === "revoke-terminal") {
		revokeTerminal(config);
		process.stdout.write(`${JSON.stringify({ revoked: true })}\n`);
	} else if (command === "pair") process.stdout.write(`${JSON.stringify(issueManagementCode(config))}\n`);
	else if (command === "revoke-management") {
		revokeManagement(config);
		process.stdout.write(`${JSON.stringify({ revoked: true })}\n`);
	} else if (command === "issue") {
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
			socketPath: hub.socketPath,
			...hub.managementUrl ? { managementUrl: hub.managementUrl } : {},
			...hub.terminalUrl ? { terminalUrl: hub.terminalUrl } : {}
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
