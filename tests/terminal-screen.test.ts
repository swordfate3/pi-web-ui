import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { test } from "node:test";
import type serialize from "@xterm/addon-serialize";
import type { IBuffer, Terminal } from "@xterm/headless";
import headless from "@xterm/headless";
import type { ScreenSnapshot } from "../hub/terminal-screen.ts";
import { TerminalScreen } from "../hub/terminal-screen.ts";

const bytes = (text: string) => Buffer.from(text, "utf8");
function screen(t: TestContext, columns = 40, rows = 8): TerminalScreen {
  const value = new TerminalScreen(columns, rows);
  t.after(() => value.dispose());
  return value;
}
function terminal(t: TestContext, cols = 40, rows = 8): Terminal {
  const value = new headless.Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true, logLevel: "off" });
  t.after(() => value.dispose());
  return value;
}
function write(value: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => value.write(data, resolve));
}

// Test-only fault injection/observation. Production exposes neither the parser
// nor an injectable sink; no SDK/private xterm internals are modified here.
function internals(value: TerminalScreen): { terminal: Terminal; serializer: serialize.SerializeAddon } {
  return value as unknown as { terminal: Terminal; serializer: serialize.SerializeAddon };
}
function visible(value: Terminal, buffer: IBuffer = value.buffer.active) {
  return {
    type: buffer.type,
    cursor: [buffer.cursorX, buffer.cursorY],
    cells: Array.from({ length: value.rows }, (_, y) => {
      const line = buffer.getLine(buffer.baseY + y);
      return Array.from({ length: value.cols }, (_, x) => {
        const cell = line?.getCell(x);
        assert.ok(cell);
        return [
          cell.getChars(),
          cell.getWidth(),
          cell.getFgColorMode(),
          cell.getFgColor(),
          cell.getBgColorMode(),
          cell.getBgColor(),
          Boolean(cell.isBold()),
          Boolean(cell.isDim()),
          Boolean(cell.isItalic()),
          Boolean(cell.isUnderline()),
          Boolean(cell.isBlink()),
          Boolean(cell.isInverse()),
          Boolean(cell.isInvisible()),
          Boolean(cell.isStrikethrough()),
          Boolean(cell.isOverline()),
        ];
      });
    }),
  };
}
async function restore(t: TestContext, snapshot: ScreenSnapshot): Promise<Terminal> {
  const restored = terminal(t, snapshot.columns, snapshot.rows);
  await write(restored, snapshot.data);
  return restored;
}
async function roundtrip(t: TestContext, snapshot: ScreenSnapshot, expected: Terminal) {
  assert.ok(Buffer.byteLength(snapshot.data, "utf8") <= 1_048_576);
  const restored = await restore(t, snapshot);
  assert.deepEqual(visible(restored), visible(expected));
  assert.deepEqual(visible(restored, restored.buffer.normal), visible(expected, expected.buffer.normal));
  return restored;
}
async function permanentlyRejected(value: TerminalScreen, pattern: RegExp) {
  await assert.rejects(value.capture(), pattern);
  await assert.rejects(value.write(bytes("later")), pattern);
  await assert.rejects(value.resize(80, 24), pattern);
}

// This is a supported-fixture framebuffer contract, not a claim that the
// experimental serializer can checkpoint every terminal mode/parser state.
test("default empty screen and capture do not advance the parsed sequence", async (t) => {
  const value = new TerminalScreen();
  t.after(() => value.dispose());
  const initial = await value.capture();
  assert.deepEqual(initial, { sequence: 0, columns: 120, rows: 40, data: "" });
  assert.deepEqual(await value.capture(), initial);
  const written = await value.write(bytes("<b>literal, not HTML</b>"));
  assert.equal(written.sequence, 1);
  const restored = await restore(t, written);
  assert.equal(restored.buffer.active.getLine(0)?.translateToString(true), "<b>literal, not HTML</b>");
  assert.deepEqual(await value.capture(), written);
});

test("normal buffer roundtrip preserves cells, colors, attributes, cursor and bounded history", async (t) => {
  const value = screen(t);
  const oracle = terminal(t);
  const input = [
    "history\r\n".repeat(12),
    "\x1b[2J\x1b[H",
    "\x1b[1;3;4;38;2;12;34;56;48;5;123m彩色\x1b[0m plain\r\n",
    "\x1b[2;5;7;8;9;53mstyles\x1b[0m\r\n",
    "wide 中 e\u0301 😀\r\n",
    "\x1b[31mdelete me\x1b[0m\r\x1b[2Kreplacement",
    "\x1b[6;7Hcursor",
  ].join("");
  await write(oracle, bytes(input));
  const restored = await roundtrip(t, await value.write(bytes(input)), oracle);
  assert.equal(restored.buffer.normal.baseY, oracle.buffer.normal.baseY);
});

test("alternate screen and return to normal roundtrip at separate full-frame boundaries", async (t) => {
  const value = screen(t);
  const oracle = terminal(t);
  for (const input of [
    "normal\r\n\x1b[32mretained\x1b[0m",
    "\x1b[?1049h\x1b[2J\x1b[H\x1b[44;93mALT panel\x1b[0m\x1b[4;9Hselected",
    "\x1b[2;4H\x1b[1;35mchanged\x1b[0m",
    "\x1b[?1049l",
  ]) {
    await write(oracle, bytes(input));
    await roundtrip(t, await value.write(bytes(input)), oracle);
  }
});

test("partial UTF-8 and split CSI remain in the source parser, not the framebuffer snapshot", async (t) => {
  const value = screen(t);
  const oracle = terminal(t);
  const input = bytes("中😀\x1b[38;2;20;30;40m彩\x1b[0m!");
  for (let i = 0; i < input.length; i++) {
    const part = input.subarray(i, i + 1);
    await write(oracle, part);
    const snapshot = await value.write(part);
    assert.equal(snapshot.sequence, i + 1);
    await roundtrip(t, snapshot, oracle);
    assert.ok(!snapshot.data.includes("\ufffd"));
  }
  const partial = await value.write(bytes("\x1b[31"));
  const fresh = await restore(t, partial);
  // Snapshot cannot carry the incomplete CSI. This explicitly demonstrates why
  // consumers MUST NOT continue snapshot + raw-delta on a restored parser.
  await write(fresh, "mX");
  const completed = await value.write(bytes("mX"));
  const completeFrame = await restore(t, completed);
  assert.notDeepEqual(visible(fresh), visible(completeFrame));
});

test("queued write/resize/capture share one watermark and resize cannot overtake parsing", async (t) => {
  const value = screen(t);
  const oracle = terminal(t);
  const input = bytes("before 中\r\nresize\x1b[2;5H");
  const first = value.write(input);
  const captured = value.capture();
  const resized = value.resize(20, 5);
  const second = value.write(bytes("\r\nafter"));
  const final = value.capture();
  await write(oracle, input);
  await roundtrip(t, await first, oracle);
  assert.deepEqual(await captured, await first);
  oracle.resize(20, 5);
  await roundtrip(t, await resized, oracle);
  await write(oracle, bytes("\r\nafter"));
  await roundtrip(t, await second, oracle);
  assert.deepEqual(await final, await second);
  assert.deepEqual(
    (await Promise.all([first, captured, resized, second, final])).map((s) => s.sequence),
    [1, 1, 2, 3, 3],
  );
});

test("documents experimental serialize cursor limitation after shrinking wrapped content", async (t) => {
  const value = screen(t);
  await value.write(bytes(`before resize 中 ${"wrap ".repeat(20)}`));
  const snapshot = await value.resize(20, 5);
  const source = visible(internals(value).terminal);
  const replay = visible(await restore(t, snapshot));
  assert.deepEqual(replay.cells, source.cells);
  assert.deepEqual(source.cursor, [19, 2]);
  // Known pinned-addon limitation, not an accepted exact cursor roundtrip or
  // justification for silently switching to raw deltas. Re-evaluate on upgrade.
  assert.deepEqual(replay.cursor, [18, 2]);
});

test("pending input is copied, including Buffer/subarray views", async (t) => {
  const value = screen(t);
  const backing = bytes("-original-");
  const pending = value.write(backing.subarray(1, 9));
  backing.fill(120);
  assert.equal((await pending).data, "original");
});

test("dimension boundaries accepted; invalid construction and resize fail closed", async (t) => {
  for (const [columns, rows] of [
    [20, 5],
    [240, 120],
  ]) {
    const value = screen(t, columns, rows);
    const snapshot = await value.capture();
    assert.equal(snapshot.columns, columns);
    assert.equal(snapshot.rows, rows);
    assert.equal((await value.resize(columns, rows)).sequence, 1);
  }
  for (const [columns, rows] of [
    [19, 5],
    [241, 5],
    [20, 4],
    [20, 121],
    [20.5, 5],
    [20, NaN],
    [Infinity, 5],
  ]) {
    assert.throws(() => new TerminalScreen(columns, rows), /dimensions/);
    const value = screen(t);
    const pending = value.write(bytes("pending"));
    const invalid = value.resize(columns, rows);
    await assert.rejects(pending, /dimensions/);
    await assert.rejects(invalid, /dimensions/);
    await permanentlyRejected(value, /dimensions/);
  }
});

test("single-write boundary and byte backlog boundary (including active parse) are enforced", async (t) => {
  const accepted = screen(t);
  assert.equal((await accepted.write(new Uint8Array(32_768))).sequence, 1);
  const oversized = screen(t);
  await assert.rejects(oversized.write(new Uint8Array(32_769)), /write limit/);
  await permanentlyRejected(oversized, /write limit/);

  const full = screen(t);
  const pending = Array.from({ length: 32 }, () => full.write(new Uint8Array(32_768)));
  // Exactly 1 MiB is permitted, not truncated.
  const results = await Promise.all(pending);
  assert.equal(results.at(-1)?.sequence, 32);
  assert.equal((await full.write(bytes("ok"))).sequence, 33);

  const overflow = screen(t);
  const backlog = Array.from({ length: 32 }, () => overflow.write(new Uint8Array(32_768)));
  await Promise.resolve(); // first write is now active in xterm, still budgeted
  backlog.push(overflow.write(new Uint8Array(1)));
  const rejected = await Promise.allSettled(backlog);
  assert.ok(rejected.every((r) => r.status === "rejected" && /pending budget/.test(r.reason.message)));
  await permanentlyRejected(overflow, /pending budget/);
});

test("operation budget includes captures/empty writes and is released on completion", async (t) => {
  const value = screen(t);
  const accepted = await Promise.all(Array.from({ length: 128 }, () => value.capture()));
  assert.ok(accepted.every((s) => s.sequence === 0));
  assert.equal((await value.write(new Uint8Array())).sequence, 1);
  const pending = Array.from({ length: 128 }, () => value.capture());
  pending.push(value.capture());
  assert.ok((await Promise.allSettled(pending)).every((r) => r.status === "rejected"));
  await permanentlyRejected(value, /pending budget/);
});

test("real parser scrollback stays bounded to 1000 lines", async (t) => {
  const value = screen(t, 20, 5);
  const input = bytes(Array.from({ length: 1200 }, (_, i) => `line-${i}\r\n`).join(""));
  const snapshot = await value.write(input);
  const restored = await restore(t, snapshot);
  assert.equal(internals(value).terminal.buffer.normal.length, 1005);
  assert.equal(restored.buffer.normal.length, 1005);
  assert.deepEqual(visible(restored), visible(internals(value).terminal));
  assert.ok(!snapshot.data.includes("line-0\r\n"));
  assert.ok(snapshot.data.includes("line-1199"));
});

test("real serialized ANSI expansion exceeding 1 MiB fails, never truncates", async (t) => {
  const value = screen(t, 240, 120);
  // Alternating RGB cells expands into >1 MiB of ANSI before reaching the
  // 1000-line history cap; each raw write is independently <=32 KiB.
  const line = `${"\x1b[38;2;1;2;3ma\x1b[38;2;4;5;6mb".repeat(119)}\x1b[0m\r\n`;
  let failed = false;
  for (let i = 0; i < 100; i++) {
    try {
      await value.write(bytes(line.repeat(8)));
    } catch (error) {
      assert.match(String(error), /snapshot budget/);
      failed = true;
      break;
    }
  }
  assert.equal(failed, true);
  await permanentlyRejected(value, /snapshot budget/);
});

test("snapshot budget counts UTF-8 bytes rather than JS string length", async (t) => {
  const value = screen(t);
  t.mock.method(internals(value).serializer, "serialize", () => "中".repeat(400_000));
  await assert.rejects(value.capture(), /snapshot budget/);
  await permanentlyRejected(value, /snapshot budget/);
});

test("parser/resize/serialize failures reject all pending work and redact original errors", async (t) => {
  for (const fault of ["write", "resize", "serialize"] as const) {
    const value = screen(t);
    const internal = internals(value);
    const fail = () => {
      throw new Error("SECRET_TERMINAL_CONTENT");
    };
    if (fault === "serialize") t.mock.method(internal.serializer, fault, fail);
    else t.mock.method(internal.terminal, fault, fail);
    const first = fault === "resize" ? value.resize(30, 6) : value.write(bytes("fixture"));
    const captured = value.capture();
    const results = await Promise.allSettled([first, captured]);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") {
        assert.match(result.reason.message, /Terminal screen .* failed/);
        assert.ok(!result.reason.message.includes("SECRET"));
      }
    }
    await permanentlyRejected(value, /failed/);
  }
});

test("dispose rejects queued and active promises without waiting for the xterm callback", {
  timeout: 2000,
}, async (t) => {
  for (const active of [false, true]) {
    const value = screen(t);
    let callback: (() => void) | undefined;
    t.mock.method(internals(value).terminal, "write", (_data: string | Uint8Array, done?: () => void) => {
      callback = done;
    });
    const pending = [value.write(bytes("pending")), value.resize(30, 6), value.capture()];
    if (active) {
      await Promise.resolve();
      assert.ok(callback);
    }
    value.dispose();
    value.dispose();
    assert.ok((await Promise.allSettled(pending)).every((r) => r.status === "rejected"));
    callback?.(); // a late callback must not resurrect the instance
    await permanentlyRejected(value, /disposed/);
  }
  const real = screen(t);
  const pending = real.write(new Uint8Array(32_768));
  await Promise.resolve();
  real.dispose(); // xterm may cancel the real write timer
  await assert.rejects(pending, /disposed/);
});

test("OSC effects and terminal queries are not retained or replayed in snapshots", async (t) => {
  const value = screen(t);
  const internal = internals(value).terminal;
  const titles: string[] = [];
  internal.onTitleChange((title) => titles.push(title));
  // These observers are test-only. There is deliberately no output-to-PTY sink
  // in TerminalScreen; disableStdin also suppresses parser-generated replies.
  const generated: string[] = [];
  internal.onData((data) => generated.push(data));
  const input = [
    "safe",
    "\x1b]0;secret-title\x07\x1b]1;secret-icon\x07\x1b]2;secret-window\x1b\\",
    "\x1b]52;c;c2VjcmV0LWNsaXBib2FyZA==\x07",
    "\x1b]8;id=secret-id;https://invalid.example/secret-link\x1b\\label\x1b]8;;\x1b\\",
    "\x1b]9;secret-notification\x07\x1b]1337;File=secret-image\x07",
    "\x1b]10;?\x07\x1b]11;?\x07",
    "\x1b[5n\x1b[6n\x1b[c\x1b[>c\x1bP$qm\x1b\\",
  ].join("");
  // Split the OSC payload itself to verify registered hooks survive chunking.
  const encoded = bytes(input);
  await value.write(encoded.subarray(0, 19));
  const snapshot = await value.write(encoded.subarray(19));
  assert.deepEqual(titles, []);
  assert.deepEqual(generated, []);
  const queryOracle = terminal(t);
  const oracleReplies: string[] = [];
  queryOracle.onData((data) => oracleReplies.push(data));
  await write(queryOracle, "\x1b[5n\x1b[6n\x1b[c\x1b[>c\x1bP$qm\x1b\\");
  assert.ok(oracleReplies.length > 0, "query fixture elicits replies without disableStdin");
  assert.equal(snapshot.data, "safelabel");
  assert.ok(!snapshot.data.includes("secret"));
  assert.ok(!snapshot.data.includes("\x1b]"));
  const restored = terminal(t);
  const replayed: string[] = [];
  restored.onData((data) => replayed.push(data));
  restored.onBinary((data) => replayed.push(data));
  await write(restored, snapshot.data);
  assert.deepEqual(replayed, []);
  assert.deepEqual(visible(restored), visible(internal));
  // RIS must not remove the security hooks.
  const reset = await value.write(bytes("\x1bc\x1b]2;secret-after-reset\x07ok"));
  assert.equal(reset.data, "ok");
  assert.deepEqual(titles, []);
});
