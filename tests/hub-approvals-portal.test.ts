import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { approvalsPortalJs } from "../hub/approvals-portal.ts";

class Element {
  id = "";
  textContent = "";
  value = "";
  hidden = false;
  disabled = false;
  href = "";
  className = "";
  children: Element[] = [];
  handlers = new Map<string, () => unknown>();
  append(...items: Element[]) {
    this.children.push(...items);
  }
  replaceChildren(...items: Element[]) {
    this.children = items;
  }
  addEventListener(event: string, callback: () => unknown) {
    this.handlers.set(event, callback);
  }
  async click() {
    if (!this.disabled) await this.handlers.get("click")?.();
  }
}
const id = "a".repeat(32);
const revision = "b".repeat(64);
const task = {
  kind: "runtime",
  id,
  revision,
  title: "Pi 1.4.0",
  target: "shared-runtime",
  version: "1.4.0",
  status: "pending",
  stage: "awaiting_approval",
  actions: ["approve", "reject"],
};
const policy = { kind: "runtime", id: "runtime", revision, mode: "manual", images: [`sha256:${"c".repeat(64)}`] };
function fixture(
  options: {
    confirm?: boolean;
    lose?: boolean;
    conflict?: boolean;
    storageFails?: boolean;
    storage?: Map<string, string>;
  } = {},
) {
  const elements = new Map<string, Element>();
  const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
  const get = (id: string) => {
    const dynamic = [...elements.values()].flatMap(all).find((node) => node.id === id);
    if (dynamic) return dynamic;
    if (!elements.has(id)) elements.set(id, new Element());
    const element = elements.get(id);
    assert.ok(element);
    return element;
  };
  const storage = options.storage ?? new Map<string, string>();
  const requests: { route: string; body?: Record<string, unknown> }[] = [];
  const prompts: string[] = [];
  let receipt: Record<string, unknown> | undefined;
  const context = {
    get,
    document: { createElement: () => new Element() },
    auth: { available: true, authorized: true, gateManagementAvailable: true, interactionsAvailable: true },
    authGeneration: 0,
    authTransition: false,
    notice: (text: string) => {
      get("management-notice").textContent = text;
    },
    window: {
      confirm: (text: string) => {
        prompts.push(text);
        return options.confirm !== false;
      },
    },
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) },
    Uint8Array,
    sessionStorage: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => {
        if (options.storageFails) throw new Error();
        storage.set(key, value);
      },
    },
    api: async (route: string, body?: Record<string, unknown>) => {
      requests.push({ route, body });
      if (route === "gate") return { tasks: [task], policies: [policy] };
      if (route === "interactions")
        return {
          items: [
            {
              generation: "d".repeat(32),
              requestId: id,
              adapterId: "mcp",
              action: "connect",
              deadline: Date.now() + 10000,
              path: `/interactions/${"d".repeat(32)}/${id}/`,
            },
          ],
          unavailable: 1,
          truncated: false,
        };
      if (route.startsWith("gate/decisions/") && !body) {
        if (!receipt) throw Object.assign(new Error(), { status: 404 });
        return receipt;
      }
      if (body) {
        // The UI must durably save the original identity before crossing this boundary.
        assert.ok([...storage.values()].some((value) => value.includes(String(body.decision_id))));
        if (options.conflict) throw Object.assign(new Error(), { status: 409 });
        receipt = { decision_id: body.decision_id, status: "recorded" };
        if (options.lose) throw new Error("connection lost after dispatch");
        return receipt;
      }
      throw new Error(route);
    },
  };
  const result = runInNewContext(
    `${approvalsPortalJs}\n({ approvals, lock() { authGeneration++; auth.authorized = false; approvals.clearProtected(); approvals.updateAuth(); } })`,
    context,
  ) as { approvals: { poll(): Promise<void> }; lock(): void };
  const button = (text: string) => {
    const found = [...elements.values()]
      .flatMap(all)
      .find((node) => node.textContent === text && node.handlers.has("click"));
    assert.ok(found, `missing button ${text}`);
    return found;
  };
  return { ...result, get, button, prompts, requests, storage, context };
}

test("reviewed approve forwards exact revision once and cancellation never writes", async () => {
  const f = fixture();
  await f.approvals.poll();
  await f.button("批准").click();
  const writes = f.requests.filter((r) => r.body);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].route, "gate/decisions");
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].body)), {
    kind: "runtime",
    id,
    revision,
    action: "approve",
    decision_id: "07".repeat(16),
  });
  assert.match(f.prompts[0], /1.4.0/);
  assert.match(f.prompts[0], new RegExp(revision));
  assert.match(f.get("approvals-result").textContent, /已记录/);
  const cancelled = fixture({ confirm: false });
  await cancelled.approvals.poll();
  await cancelled.button("批准").click();
  assert.equal(cancelled.requests.filter((r) => r.body).length, 0);
});

test("reject and mode-only policy change are explicit and preserve trusted image authority", async () => {
  const f = fixture();
  await f.approvals.poll();
  await f.button("拒绝").click();
  assert.equal(f.requests.find((r) => r.body)?.body?.action, "reject");
  const p = fixture();
  await p.approvals.poll();
  p.get("approvals-policy-runtime-runtime").value = "auto";
  await p.button("保存策略").click();
  const body = p.requests.find((r) => r.body)?.body;
  assert.ok(body);
  assert.equal(body.mode, "auto");
  assert.equal(body.revision, revision);
  assert.equal("images" in body, false);
  assert.match(p.prompts[0], /auto/);
});

test("lost response is reconciled by original decision ID and never replays a write", async () => {
  const f = fixture({ lose: true });
  await f.approvals.poll();
  await f.button("批准").click();
  assert.equal(f.requests.filter((r) => r.body).length, 1);
  await f.approvals.poll();
  assert.ok(f.requests.some((r) => r.route === `gate/decisions/${"07".repeat(16)}`));
  assert.equal(f.requests.filter((r) => r.body).length, 1);
  assert.match(f.get("approvals-result").textContent, /已记录/);
});

test("unknown restored receipts stay blocked, storage failure stops dispatch, and stale revisions require review", async () => {
  const storage = new Map([
    ["pi-hub-gate-decisions", JSON.stringify([{ decision_id: "e".repeat(32), key: `task:runtime:${id}` }])],
  ]);
  const f = fixture({ storage });
  await f.approvals.poll();
  assert.equal(f.button("批准").disabled, true);
  assert.match(f.get("approvals-result").textContent, /未确认/);
  const unavailable = fixture({ storageFails: true });
  await unavailable.approvals.poll();
  await unavailable.button("批准").click();
  assert.equal(unavailable.requests.filter((r) => r.body).length, 0);
  const stale = fixture({ conflict: true });
  await stale.approvals.poll();
  await stale.button("批准").click();
  assert.match(stale.get("approvals-result").textContent, /已变化/);
});

test("inbox only links to bounded review metadata; locking clears protected task views", async () => {
  const f = fixture();
  await f.approvals.poll();
  assert.match(f.get("approvals-inbox-status").textContent, /1/);
  assert.ok(f.get("approvals-inbox").children[0].href.startsWith("/interactions/"));
  assert.ok(f.get("approvals-tasks").children.length);
  f.lock();
  assert.equal(f.get("approvals-tasks").children.length, 0);
  assert.equal(f.get("approvals-inbox").children.length, 0);
});
