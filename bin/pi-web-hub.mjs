#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import { initializeHub, issueSession, readHubConfig, revokeSession } from "../hub/config.ts";
import { startHub } from "../hub/server.ts";

const help = `Pi Web Hub — independent multi-session portal

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
  const permitted = {
    init: ["--config", "--port", "--public-url"],
    serve: ["--config"],
    issue: ["--config", "--label", "--output", "--backend-host"],
    revoke: ["--config", "--run-id"],
  }[command];
  if (!permitted) throw new Error("Unknown hub command; use --help");
  const options = new Map();
  while (args.length) {
    const key = args.shift();
    const value = args.shift();
    if (!permitted.includes(key) || options.has(key) || !value || value.startsWith("--"))
      throw new Error("Invalid hub arguments; use --help");
    options.set(key, value);
  }
  const configFile = path.resolve(
    options.get("--config") ?? process.env.PI_WEB_UI_HUB_CONFIG ?? path.join(homedir(), ".pi/web-hub/config.json"),
  );
  if (command === "init") {
    const port = options.has("--port") ? Number(options.get("--port")) : 16180;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid hub port");
    const publicUrl = options.get("--public-url");
    if (publicUrl !== undefined) {
      const { validatedPublicUrl } = await import("../extensions/connection-config.ts");
      if (new URL(validatedPublicUrl(publicUrl)).pathname !== "/")
        throw new Error("Hub public URL must use the domain root");
    }
    initializeHub(configFile, { port, ...(publicUrl ? { publicUrl } : {}) });
    process.stdout.write(`${JSON.stringify({ configured: true, configFile })}\n`);
    return;
  }
  const config = readHubConfig(configFile);
  if (command === "issue") {
    if (!options.has("--output") || !options.has("--label")) throw new Error("issue requires --output and --label");
    const credentialFile = path.resolve(options.get("--output"));
    const credential = issueSession(config, credentialFile, {
      label: options.get("--label"),
      backendHost: options.get("--backend-host"),
    });
    // Deliberately omit token. These paths are intended for the trusted launcher.
    process.stdout.write(
      `${JSON.stringify({ runId: credential.run_id, credentialFile, socketPath: config.socketPath })}\n`,
    );
  } else if (command === "revoke") {
    if (!options.has("--run-id")) throw new Error("revoke requires --run-id");
    revokeSession(config, options.get("--run-id"));
    process.stdout.write(`${JSON.stringify({ revoked: true })}\n`);
  } else {
    const hub = await startHub(config);
    process.stdout.write(
      `${JSON.stringify({ localUrl: hub.url, portalUrl: `${config.publicUrl ?? hub.url}sessions/`, socketPath: hub.socketPath })}\n`,
    );
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      void hub
        .close()
        .then(() => {
          process.exitCode = 0;
        })
        .catch(() => {
          process.exitCode = 1;
        });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
}

main(process.argv.slice(2)).catch(() => {
  // User paths/values may contain secrets. Never echo raw exceptions or arguments.
  process.stderr.write(
    "Pi Web Hub failed. Check arguments, private file permissions, configuration and port/socket availability. Use --help.\n",
  );
  process.exitCode = 1;
});
