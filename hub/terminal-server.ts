import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { HubConfig } from "./config.ts";
import { HubTerminalAuth } from "./terminal-auth.ts";
import { parseTerminalTarget, sameTerminal, type TerminalTarget } from "./terminal-contract.ts";
import { connectTerminalProvider, terminalProviderStatus } from "./terminal-provider.ts";
import {
  exact,
  parseTerminalJson,
  parseTerminalRequest,
  TERMINAL_FRAME_BYTES,
  TERMINAL_QUEUE_BYTES,
  type TerminalSnapshot,
} from "./terminal-wire.ts";

type Authorization = ReturnType<HubTerminalAuth["authorize"]>;
type Reservation = { session: Authorization; target: TerminalTarget; access: "read" | "write"; expires: number };
type Peer = { check: () => void; close: () => void; reservation?: Reservation };

/** Third-origin listener; only this fixed asset bundle and the private provider. */
export async function startTerminalServer(config: HubConfig, otherOrigins: string[]) {
  if (!config.terminal) throw new Error("Terminal listener is disabled");
  const terminal = config.terminal;
  const auth = new HubTerminalAuth(config);
  const connections = new Set<Socket>();
  const nonces = new Map<string, Reservation>();
  const peers = new Set<Peer>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_FRAME_BYTES, perMessageDeflate: false });
  let url = "",
    closed = false,
    pending = 0;
  const assets = new Map<string, [string, Buffer]>();
  // The source entry and installed bundle have different locations, both fixed.
  const assetRoot = new URL(import.meta.url.endsWith(".ts") ? "../dist/terminal/" : "../terminal/", import.meta.url);
  for (const [route, name, mime] of [
    ["/", "index.html", "text/html"],
    ["/terminal.js", "app.js", "text/javascript"],
    ["/terminal.css", "app.css", "text/css"],
  ]) {
    try {
      const bytes = readFileSync(fileURLToPath(new URL(name, assetRoot)));
      if (bytes.length <= 2 * 1024 * 1024) assets.set(route, [mime, bytes]);
    } catch {
      /* A missing build never grants terminal availability. */
    }
  }
  const allowed = (request: IncomingMessage, write: boolean) => {
    if (
      closed ||
      !url ||
      request.headers["service-worker"] !== undefined ||
      request.headers["sec-fetch-site"] === "cross-site"
    )
      return false;
    const origins = [new URL(url).origin, ...(terminal.publicUrl ? [new URL(terminal.publicUrl).origin] : [])];
    const matched = origins.find((candidate) => new URL(candidate).host === request.headers.host);
    return !!matched && (request.headers.origin === undefined ? !write : request.headers.origin === matched);
  };
  const respond = (res: ServerResponse, status: number, value?: unknown) => {
    if (!res.destroyed && !res.writableEnded)
      res
        .writeHead(status, { "Content-Type": "application/json" })
        .end(value === undefined ? undefined : JSON.stringify(value));
  };
  const validate = (
    req: IncomingMessage,
    expected: Authorization,
    target: TerminalTarget,
    access: "read" | "write",
  ) => {
    if (!allowed(req, true)) throw new Error();
    const current = auth.authorizeTarget(req, target, true, access);
    auth.revalidate(req, expected, true, access);
    if (current.authorizationId !== expected.authorizationId) throw new Error();
  };
  const prune = () => {
    for (const [key, nonce] of nonces) if (nonce.expires <= Date.now()) nonces.delete(key);
    for (const peer of peers) peer.check();
  };
  const admit = (target: TerminalTarget, access: "read" | "write") => {
    const all = [
      ...nonces.values(),
      ...[...peers].flatMap((peer) => (peer.reservation ? [peer.reservation] : [])),
    ].filter((r) => r.target.runId === target.runId);
    return all.length < 2 && (access !== "write" || !all.some((r) => r.access === "write"));
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
    );
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
      if (!status.authorized || !terminal.provider)
        return respond(res, 200, { ...status, available: false, reason: "terminal_backend_unavailable" });
      if (pending >= 8) return respond(res, 503);
      pending++;
      try {
        const session = auth.authorize(req);
        const target = await terminalProviderStatus(terminal.provider, session.scope.runId);
        auth.revalidate(req, session);
        if (!allowed(req, false) || !sameTerminal(target, session.scope)) throw new Error();
        return respond(res, 200, { ...auth.status(req), available: true, target });
      } catch {
        return respond(res, 200, { ...auth.status(req), available: false, reason: "terminal_backend_unavailable" });
      } finally {
        pending--;
      }
    }
    if (
      req.method !== "POST" ||
      !["/api/terminal/unlock", "/api/terminal/logout", "/api/terminal/attach"].includes(route ?? "")
    )
      return respond(res, 404);
    if (
      req.headers["content-type"] !== "application/json" ||
      req.headers["transfer-encoding"] !== undefined ||
      !/^[0-9]{1,4}$/.test(req.headers["content-length"] ?? "") ||
      Number(req.headers["content-length"]) > 2048
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
        if (length > 2048) throw new Error();
        chunks.push(chunk);
      }
      if (!allowed(req, true)) throw new Error();
      const data = parseTerminalJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      if (route === "/api/terminal/unlock") {
        exact(data, "code");
        const result = auth.unlock(data.code);
        res.setHeader("Set-Cookie", result.cookie);
        return respond(res, 200, { csrf: result.csrf, expiresAt: result.expiresAt });
      }
      if (route === "/api/terminal/logout") {
        exact(data, "");
        res.setHeader("Set-Cookie", auth.logout(req));
        prune();
        return respond(res, 200, { authorized: false });
      }
      exact(data, "access,target");
      if (data.access !== "read" && data.access !== "write") throw new Error();
      const target = parseTerminalTarget(data.target),
        access = data.access;
      const session = auth.authorizeTarget(req, target, true, access);
      if (!terminal.provider) return respond(res, 503, { available: false, reason: "terminal_backend_unavailable" });
      prune();
      if (nonces.size >= 8 || !admit(target, access)) return respond(res, 409);
      const nonce = randomBytes(32).toString("hex"),
        expiresAt = Date.now() + 10000;
      nonces.set(nonce, { session, target, access, expires: expiresAt });
      return respond(res, 200, { nonce, expiresAt });
    } catch {
      return respond(res, 403);
    } finally {
      clearTimeout(timer);
    }
  };
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000 }, (req, res) => {
    void handle(req, res).catch(() => respond(res, 403));
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
      if (!allowed(request, true) || request.url !== "/api/terminal/ws" || pending >= 8 || peers.size >= 8)
        throw new Error();
      auth.authorize(request);
      wss.handleUpgrade(request, socket, head, (ws) => attachSocket(ws, request));
    } catch {
      socket.destroy();
    }
  });
  function attachSocket(ws: WebSocket, request: IncomingMessage) {
    let reservation: Reservation | undefined;
    let provider: Awaited<ReturnType<typeof connectTerminalProvider>> | undefined;
    let dead = false,
      initialized = false,
      inputAllowed = false,
      acquiring = false,
      lastId = 0,
      generation = 0;
    const abort = new AbortController();
    const peer: Peer = {
      close,
      check: () => {
        if (reservation) {
          try {
            validate(request, reservation.session, reservation.target, reservation.access);
          } catch {
            close();
          }
        }
      },
      get reservation() {
        return reservation;
      },
    };
    peers.add(peer);
    pending++;
    const timer = setTimeout(close, 2000);
    const lifespan = setTimeout(close, 300000);
    function close() {
      if (dead) return;
      // Fence synchronously before provider cleanup or an async continuation.
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
    const send = (frame: object) =>
      new Promise<void>((resolve, reject) => {
        try {
          check();
          const text = JSON.stringify(frame);
          if (
            Buffer.byteLength(text) > TERMINAL_FRAME_BYTES ||
            ws.bufferedAmount + Buffer.byteLength(text) > TERMINAL_QUEUE_BYTES
          )
            throw new Error();
          const timeout = setTimeout(() => {
            close();
            reject(new Error());
          }, 2000);
          ws.send(text, (error) => {
            clearTimeout(timeout);
            if (error) {
              close();
              reject(new Error());
            } else resolve();
          });
        } catch {
          close();
          reject(new Error());
        }
      });
    const snapshot = async (value: TerminalSnapshot) => {
      check();
      if (!reservation) throw new Error();
      const bytes = Buffer.from(value.data),
        target = reservation.target;
      await send({
        type: "screen-start",
        target,
        sequence: value.sequence,
        columns: value.columns,
        rows: value.rows,
        bytes: bytes.length,
        chunks: Math.ceil(bytes.length / 20480),
      });
      for (let index = 0; index * 20480 < bytes.length; index++)
        await send({
          type: "screen-chunk",
          terminalEpoch: target.terminalEpoch,
          sequence: value.sequence,
          index,
          data: bytes.subarray(index * 20480, (index + 1) * 20480).toString("base64"),
        });
      await send({ type: "screen-end", terminalEpoch: target.terminalEpoch, sequence: value.sequence });
    };
    ws.on("error", close);
    ws.on("close", close);
    ws.on("message", (raw, binary) => {
      void (async () => {
        if (dead || binary) throw new Error();
        const frame = parseTerminalJson(new TextDecoder("utf-8", { fatal: true }).decode(raw as Buffer));
        if (!reservation) {
          exact(frame, "access,csrf,nonce,target,type");
          if (frame.type !== "attach" || typeof frame.nonce !== "string") throw new Error();
          const nonce = nonces.get(frame.nonce);
          nonces.delete(frame.nonce);
          if (
            !nonce ||
            nonce.expires <= Date.now() ||
            frame.access !== nonce.access ||
            !sameTerminal(parseTerminalTarget(frame.target), nonce.target)
          )
            throw new Error();
          request.headers["x-pi-hub-terminal-csrf"] = frame.csrf as string;
          validate(request, nonce.session, nonce.target, nonce.access);
          reservation = nonce;
          const identity = generation;
          // Ready must precede the initial screen even when both arrive in one read.
          let sentReady = false;
          const ensureReady = async () => {
            if (!sentReady) {
              sentReady = true;
              await send({ type: "ready", target: nonce.target });
            }
          };
          if (!terminal.provider) throw new Error();
          const live = await connectTerminalProvider(
            terminal.provider,
            nonce.target,
            nonce.access,
            { authorizationId: nonce.session.authorizationId, connectionId: randomBytes(16).toString("hex") },
            {
              signal: abort.signal,
              onSnapshot: async (value) => {
                check();
                await ensureReady();
                await snapshot(value);
              },
              onUnavailable: close,
            },
          );
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
        if (
          csrf !== request.headers["x-pi-hub-terminal-csrf"] ||
          !sameTerminal(parseTerminalTarget(target), reservation.target) ||
          reservation.access !== "write" ||
          !provider
        )
          throw new Error();
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
        await send({ type: "response", id: command.id, result });
      })().catch(close);
    });
  }
  const sweep = setInterval(prune, 100);
  sweep.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(terminal.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    if (
      [url, terminal.publicUrl].some(
        (origin) =>
          origin &&
          otherOrigins.some((other) =>
            terminal.publicUrl && new URL(origin).protocol === "https:"
              ? new URL(other).hostname === new URL(origin).hostname
              : new URL(other).origin === new URL(origin).origin,
          ),
      )
    )
      throw new Error("Terminal origin must differ from chat and management");
  } catch (error) {
    closed = true;
    clearInterval(sweep);
    auth.close();
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    wss.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
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
      closing = Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => wss.close(() => resolve())),
      ]).then(() => {});
      return closing;
    },
  };
}
