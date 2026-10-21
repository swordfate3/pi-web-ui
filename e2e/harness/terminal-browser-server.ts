import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { WebSocket, WebSocketServer } from "ws";
import { initializeHub, issueSession, readHubConfig } from "../../hub/config.ts";
import { HubTerminalAuth, issueTerminalCode, revokeTerminal } from "../../hub/terminal-auth.ts";
import { TERMINAL_BROWSER_HTML } from "../fixtures/terminal-browser-page.ts";
import { startPtyTransport } from "./pty-transport.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// 8 KiB decoded input may expand to 48 KiB of JSON escapes plus its envelope.
// Keep the encoded-message limit separate from the decoded PTY byte budget.
const MAX_WS_MESSAGE = 65_536;
const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(",") === keys;
const safeText = (s: unknown): s is string =>
  typeof s === "string" && s.length > 0 && !/\p{Cs}/u.test(s) && Buffer.byteLength(s, "utf8") <= 8192;

/** Isolated fixture ONLY: owns a newly launched synthetic Pi, never a Hub provider. */
export async function startTerminalBrowserServer() {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-terminal-browser-"));
  let transport: Awaited<ReturnType<typeof startPtyTransport>> | undefined;
  let auth: HubTerminalAuth | undefined;
  let closing: Promise<void> | undefined;
  let stopped = false;
  let url = "";
  const sockets = new Set<Socket>();
  const peers = new Set<{ close: () => void; check: () => void }>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE, perMessageDeflate: false });
  const bootstrapCsrf = randomBytes(32).toString("hex");
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000 });
  const close = () => {
    if (closing) return closing;
    stopped = true;
    closing = (async () => {
      for (const peer of peers) peer.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      auth?.close();
      // Preserve fixture evidence if real child cleanup fails.
      await transport?.close();
      rmSync(directory, { recursive: true, force: true });
    })();
    return closing;
  };
  try {
    const configFile = path.join(directory, "hub.json");
    initializeHub(configFile, { port: 0, management: { port: 0 }, terminal: { port: 0 } });
    const config = readHubConfig(configFile);
    const credential = issueSession(config, path.join(directory, "run.json"), { label: "Synthetic terminal browser" });
    const live = await startPtyTransport({ screen: true, runId: credential.run_id });
    transport = live;
    const authorization = new HubTerminalAuth(config);
    auth = authorization;
    const bundle = await build({
      stdin: { contents: 'import "./e2e/fixtures/terminal-browser-client.ts";', resolveDir: ROOT },
      bundle: true,
      write: false,
      format: "iife",
    });
    const assets = new Map<string, { type: string; body: string | Uint8Array }>([
      ["/", { type: "text/html; charset=utf-8", body: TERMINAL_BROWSER_HTML }],
      ["/app.js", { type: "text/javascript", body: bundle.outputFiles[0].contents }],
      [
        "/xterm.css",
        { type: "text/css", body: readFileSync(path.join(ROOT, "node_modules/@xterm/xterm/css/xterm.css")) },
      ],
      [
        "/mono.woff2",
        {
          type: "font/woff2",
          body: readFileSync(path.join(ROOT, "node_modules/katex/dist/fonts/KaTeX_Typewriter-Regular.woff2")),
        },
      ],
    ]);
    const allowed = (req: IncomingMessage, requireOrigin: boolean) => {
      if (stopped || !url) return false;
      const origin = new URL(url).origin;
      return (
        req.headers.host === new URL(origin).host &&
        req.headers["sec-fetch-site"] !== "cross-site" &&
        req.headers["service-worker"] === undefined &&
        (req.headers.origin === origin || (!requireOrigin && req.headers.origin === undefined))
      );
    };
    const headers = (res: ServerResponse) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${url.replace(/^http/, "ws").replace(/\/$/, "")}; font-src 'self'; img-src data:; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`,
      );
    };
    const respond = (res: ServerResponse, status: number, value?: unknown) => {
      if (!res.destroyed)
        res
          .writeHead(status, { "Content-Type": "application/json" })
          .end(value === undefined ? undefined : JSON.stringify(value));
    };
    const handle = async (req: IncomingMessage, res: ServerResponse) => {
      headers(res);
      if (!allowed(req, req.method !== "GET")) return respond(res, 403);
      if (req.method === "GET") {
        const asset = assets.get(req.url ?? "");
        if (asset) {
          res.writeHead(200, { "Content-Type": asset.type }).end(asset.body);
          return;
        }
        if (req.url === "/api/status") {
          const status = authorization.status(req);
          return respond(res, 200, {
            csrf: bootstrapCsrf,
            ...status,
            label: "隔离终端测试 · 非生产",
            available: !stopped && live.controlState !== "fenced",
            ...(status.authorized ? { target: live.target } : {}),
          });
        }
        return respond(res, 404);
      }
      if (req.method !== "POST" || !["/api/unlock", "/api/logout"].includes(req.url ?? "")) return respond(res, 404);
      if (
        req.headers["content-type"] !== "application/json" ||
        req.headers["transfer-encoding"] !== undefined ||
        !/^[0-9]{1,4}$/.test(req.headers["content-length"] ?? "") ||
        Number(req.headers["content-length"]) > 1024
      ) {
        res.setHeader("Connection", "close");
        return respond(res, 413);
      }
      const timer = setTimeout(() => req.destroy(), 2000);
      try {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 1024) throw new Error();
          chunks.push(Buffer.from(chunk));
        }
        if (!allowed(req, true)) throw new Error();
        const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
        if (req.url === "/api/unlock") {
          const csrf = req.headers["x-pi-hub-terminal-csrf"];
          if (
            typeof csrf !== "string" ||
            !/^[a-f0-9]{64}$/.test(csrf) ||
            !timingSafeEqual(Buffer.from(csrf), Buffer.from(bootstrapCsrf)) ||
            !exact(data, "code")
          )
            throw new Error();
          const result = authorization.unlock(data.code);
          res.setHeader("Set-Cookie", result.cookie);
          respond(res, 200, { csrf: result.csrf, expiresAt: result.expiresAt });
        } else {
          if (!exact(data, "")) throw new Error();
          res.setHeader("Set-Cookie", authorization.logout(req));
          for (const peer of peers) peer.check();
          respond(res, 200, { authorized: false });
        }
      } catch {
        respond(res, 403);
      } finally {
        clearTimeout(timer);
      }
    };
    server.on("request", (req, res) => {
      void handle(req, res).catch(() => respond(res, 403));
    });
    server.maxConnections = 32;
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    server.on("connect", (_req, socket) => socket.destroy());
    server.on("upgrade", (req, socket, head) => {
      if (
        !allowed(req, true) ||
        req.url !== "/ws" ||
        req.headers["sec-websocket-protocol"] !== undefined ||
        peers.size >= 3
      ) {
        socket.destroy();
        return;
      }
      try {
        authorization.authorizeTarget(req, live.target, false, "read");
      } catch {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        let initial: ReturnType<HubTerminalAuth["authorize"]>;
        try {
          initial = authorization.authorizeTarget(req, live.target, false, "read");
        } catch {
          ws.terminate();
          return;
        }
        let dead = false;
        let attaching = false;
        let attached = false;
        let leaseId: string | undefined;
        let nextSequence = 1;
        let unix: Socket | undefined;
        let receive = Buffer.alloc(0);
        let expected: string | undefined;
        let inputSequence = 0;
        let actionTimer: ReturnType<typeof setTimeout> | undefined;
        const checkAuth = (write = false) => {
          if (dead || stopped) throw new Error();
          authorization.revalidate(req, initial, false, write ? "write" : "read");
          authorization.authorizeTarget(req, live.target, false, write ? "write" : "read");
        };
        const stop = () => {
          if (dead) return;
          dead = true;
          clearInterval(checkTimer);
          clearTimeout(attachTimer);
          clearTimeout(actionTimer);
          peers.delete(peer);
          unix?.destroy(); // socket disconnect independently fences the actual PTY sink
          ws.terminate();
        };
        const peer = {
          close: stop,
          check: () => {
            try {
              checkAuth();
            } catch {
              stop();
            }
          },
        };
        const checkTimer = setInterval(peer.check, 100);
        const attachTimer = setTimeout(stop, 2000);
        peers.add(peer);
        const send = (value: unknown) => {
          checkAuth();
          const data = JSON.stringify(value);
          if (Buffer.byteLength(data) + ws.bufferedAmount > 262144 || ws.readyState !== WebSocket.OPEN)
            throw new Error();
          ws.send(data, (error) => {
            if (error) stop();
          });
        };
        const forward = (value: Record<string, unknown>) => {
          checkAuth();
          if (value.type === "attached") {
            if (
              !attaching ||
              attached ||
              value.screenAvailable !== true ||
              value.write !== (initial.scope.access === "write")
            )
              throw new Error();
            attached = true;
            clearTimeout(attachTimer);
            send(value);
            return;
          }
          if (!attached) throw new Error();
          if (value.type === "screen") {
            if (value.terminalEpoch !== live.target.terminalEpoch) throw new Error();
            send(value);
            return;
          }
          if (value.type === "control-released") {
            leaseId = undefined;
            send(value);
            return;
          }
          if (value.type === "denied" && expected === "control") {
            expected = undefined;
            clearTimeout(actionTimer);
            send(value);
            return;
          }
          if (value.type !== expected) throw new Error();
          clearTimeout(actionTimer);
          expected = undefined;
          if (value.type === "control") {
            checkAuth(true);
            if (
              typeof value.leaseId !== "string" ||
              !/^[a-f0-9]{32}$/.test(value.leaseId) ||
              value.expiresInMs !== 30000
            )
              throw new Error();
            leaseId = value.leaseId;
            nextSequence = 1;
            send({ type: "control", expiresInMs: value.expiresInMs });
          } else if (value.type === "written") {
            if (value.sequence !== inputSequence) throw new Error();
            send(value);
          } else if (value.type === "resized") send(value);
          else throw new Error();
        };
        const command = (message: Record<string, unknown>, response: string) => {
          if (!unix || unix.destroyed || expected || unix.writableLength > 65536) throw new Error();
          expected = response;
          actionTimer = setTimeout(stop, 2500);
          unix.write(`${JSON.stringify(message)}\n`);
        };
        ws.on("error", stop);
        ws.once("close", stop);
        ws.on("message", (raw, isBinary) => {
          try {
            checkAuth();
            if (isBinary || !Buffer.isBuffer(raw) || raw.length > MAX_WS_MESSAGE) throw new Error();
            const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
            if (!attached) {
              if (attaching || !exact(value, "csrf,type") || value.type !== "attach") throw new Error();
              const attachReq = {
                headers: { ...req.headers, "x-pi-hub-terminal-csrf": value.csrf },
              } as unknown as IncomingMessage;
              authorization.authorizeTarget(attachReq, live.target, true, "read");
              attaching = true;
              unix = createConnection(live.socketPath);
              unix.on("error", stop);
              unix.once("close", stop);
              unix.once("end", stop);
              unix.on("data", (chunk: Buffer) => {
                try {
                  checkAuth();
                  receive = Buffer.concat([receive, chunk]);
                  if (receive.length > 524288) throw new Error();
                  while (receive.includes(10)) {
                    const end = receive.indexOf(10);
                    const line = receive.subarray(0, end);
                    receive = receive.subarray(end + 1);
                    forward(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
                  }
                } catch {
                  stop();
                }
              });
              unix.write(
                `${JSON.stringify({ type: "auth", token: initial.scope.access === "write" ? live.writeToken : live.readToken })}\n`,
              );
              return;
            }
            if (expected) throw new Error(); // no key queue, no speculative replay
            checkAuth(true);
            if (value.type === "control" && exact(value, "type")) {
              if (leaseId) throw new Error();
              command({ type: "control", terminalEpoch: live.target.terminalEpoch }, "control");
            } else if (value.type === "input" && exact(value, "data,sequence,type")) {
              if (!leaseId || !safeText(value.data) || value.sequence !== nextSequence) throw new Error();
              inputSequence = nextSequence++;
              command(
                {
                  v: 1,
                  type: "input",
                  terminalEpoch: live.target.terminalEpoch,
                  leaseId,
                  sequence: value.sequence,
                  data: value.data,
                },
                "written",
              );
            } else if (value.type === "resize" && exact(value, "columns,rows,type")) {
              if (
                !leaseId ||
                !Number.isInteger(value.columns) ||
                value.columns < 20 ||
                value.columns > 240 ||
                !Number.isInteger(value.rows) ||
                value.rows < 5 ||
                value.rows > 120
              )
                throw new Error();
              command(
                {
                  type: "resize",
                  terminalEpoch: live.target.terminalEpoch,
                  leaseId,
                  columns: value.columns,
                  rows: value.rows,
                },
                "resized",
              );
            } else throw new Error();
          } catch {
            stop();
          }
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Isolated terminal listener unavailable");
    url = `http://127.0.0.1:${address.port}/`;
    return {
      url,
      config,
      transport: live,
      issueCode(access: "read" | "write") {
        if (stopped) throw new Error("Isolated terminal closed");
        const { runId, runtimeId, sessionId, terminalEpoch } = live.target;
        return issueTerminalCode(config, { runId, runtimeId, sessionId, terminalEpoch, access }).code;
      },
      revoke() {
        revokeTerminal(config);
        for (const peer of peers) peer.check();
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
