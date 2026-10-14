// Backend integration: independent hub and real Pi processes, without browser mocks.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { type HubCapability, startHubCli } from "./harness/hub-cli.ts";
import { type PiWebUiHarness, startPiWebUi } from "./harness/pi-process.ts";

async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout = 10000): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Hub state did not reach the expected condition");
}

test("two real Pi processes register; one exit leaves the second reachable; hub restart fences old links", {
  timeout: 65000,
}, async (t) => {
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const hub = await startHubCli({ repositoryRoot });
  const agents: PiWebUiHarness[] = [];
  const capabilities: HubCapability[] = [];
  t.after(async () => {
    try {
      const results = await Promise.allSettled(agents.map((agent) => agent.stop()));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } finally {
      await hub.close();
    }
  });
  for (const label of ["A", "B"]) {
    const capability = hub.issue(label);
    capabilities.push(capability);
    agents.push(
      await startPiWebUi("chat-lifecycle", {
        repositoryRoot,
        registration: capability,
      }),
    );
  }
  const list = async (): Promise<{ sessions: { label: string; path: string }[] }> =>
    (await fetch(`${hub.url}api/sessions`)).json();
  const both = await eventually(list, (value) => value.sessions.length === 2);
  for (const session of both.sessions) {
    const response = await fetch(`${hub.url.slice(0, -1)}${session.path}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<html/);
  }
  const oldA = both.sessions.find((session) => session.label === "A")?.path;
  const oldB = both.sessions.find((session) => session.label === "B")?.path;
  assert.ok(oldA && oldB);
  await agents.shift()?.stop();
  await eventually(list, (value) => value.sessions.length === 1);
  assert.equal((await fetch(`${hub.url.slice(0, -1)}${oldA}`)).status, 410);
  assert.equal((await fetch(`${hub.url.slice(0, -1)}${oldB}`)).status, 200);
  await hub.restart();
  assert.equal((await list()).sessions.length, 0);
  assert.equal((await fetch(`${hub.url.slice(0, -1)}${oldB}`)).status, 410);
  const renewed = await eventually(list, (value) => value.sessions.length === 1, 40000);
  assert.notEqual(renewed.sessions[0].path, oldB);
  assert.equal((await fetch(`${hub.url.slice(0, -1)}${renewed.sessions[0].path}`)).status, 200);
  hub.revoke(capabilities[1]);
  assert.equal((await fetch(`${hub.url.slice(0, -1)}${renewed.sessions[0].path}`)).status, 410);
  await eventually(list, (value) => value.sessions.length === 0);
});
