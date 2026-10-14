import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("deployment plans reject injection, credentials and insecure public entries", async () => {
  const { validateRemotePlan } = await import("../extensions/remote-access/plan.ts");
  const plan = {
    version: 1,
    mode: "remote",
    deployment: "new",
    server: "server.example.com",
    sshUser: "operator",
    sshPort: 22,
    domain: "pi.example.com",
    localPort: 3001,
    remotePort: 13001,
    publicUrl: "https://pi.example.com/",
    environment: "linux",
  };
  assert.equal(validateRemotePlan(plan).publicUrl, "https://pi.example.com/");
  for (const patch of [
    { server: "-oProxyCommand=touch /tmp/pwn" },
    { sshUser: "root;id" },
    { domain: "example.com\nrespond hacked" },
    { domain: "*.example.com" },
    { sshPort: 0 },
    { localPort: 65536 },
    { remotePort: 22.1 },
    { publicUrl: "http://pi.example.com/" },
    { publicUrl: "https://a:b@pi.example.com/" },
    { publicUrl: "https://pi.example.com/s/../bad" },
    { publicUrl: "https://pi.example.com/?token=secret" },
    { publicUrl: "https://pi.example.com:8443/" },
    { password: "never-store-this" },
    { token: "never-store-this" },
  ])
    assert.throws(() => validateRemotePlan({ ...plan, ...patch }));
});

test("downloaded connection material is valid shell and recovery script is independently runnable", async () => {
  const { buildRemoteMaterials } = await import("../src/web/src/core/remote-access-materials.ts");
  const materials = buildRemoteMaterials(
    {
      version: 1,
      mode: "remote",
      deployment: "new",
      server: "server.example.com",
      sshUser: "operator",
      sshPort: 22,
      domain: "pi.example.com",
      localPort: 3001,
      remotePort: 13001,
      publicUrl: "https://pi.example.com/",
      environment: "linux",
    },
    "import json\nPLAN = None\nprint(PLAN['domain'])\n",
  );
  const shell = materials.find((item) => item.name === "connect.sh");
  assert.ok(shell);
  assert.equal(spawnSync("bash", ["-n"], { input: shell.content }).status, 0);
  const manager = materials.find((item) => item.name === "gateway.py");
  assert.ok(manager);
  const result = spawnSync("python3", ["-c", manager.content], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "pi.example.com");
});
