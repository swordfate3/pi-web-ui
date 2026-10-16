# ADR 0010: Real Pi Agent Web UI E2E Tests

## Status

Accepted

## Context

Pi Web UI 的关键风险在端到端集成边界：浏览器 UI、WebSocket transport、mirror-server extension、Pi agent session、工具执行、文件系统、git workspace 和 session tree 必须一起工作。Workspace Status Float、Right Panel、artifact 展示、Branch/Continue、streaming tool card 等功能都跨过这些边界。

只接管 `/ws` 或直接设置 React state 可以构造稳定 UI 状态，但会绕过 Pi agent、extension runner、工具执行、session 写入和真实 git/file 状态。这类测试不能称为 E2E。

E2E 用例必须接近正式使用方式：启动真实 Pi CLI 进程，加载 Pi Web UI mirror-server extension，浏览器打开真实 Web UI，并通过 UI 触发 agent 行为。为避免真实 LLM 的速度、成本和不确定性，E2E 允许使用 faux LLM provider。Faux provider 只替换模型响应；Pi agent loop、工具调用、session 写入、extension 事件、mirror-server 和 frontend 都走真实路径。

## Decision

采用 **real Pi CLI + mirror-server extension + faux LLM provider + Playwright-BDD** 作为 Web UI E2E 测试方案。

测试目录放在项目根目录：

```text
e2e/
├── features/                 # Gherkin specs
├── steps/                    # playwright-bdd step definitions and page helpers
├── fixtures/                 # temp workspace setup and faux response fixtures
├── harness/                  # Pi process/session launcher
└── playwright.config.ts
```

Canonical CI path uses built frontend assets served by Pi mirror-server:

The dated-history regression additionally uses a synthetic saved JSONL with a
20 MiB record, recent pages, and a fourteen-day-old message. The backend integration
`e2e/date-history.integration.ts` connects a real Pi to a packaged Hub and asserts
bounded frames, date isolation, cursor/session rejection, and unchanged original
session bytes. The browser scenario `e2e/features/date-history.feature` separately
exercises date controls on desktop/mobile; screenshot inspection remains visual
validation, not a substitute for functional assertions.

```text
Playwright Browser
  -> Pi mirror-server static UI + /ws
  -> Pi agent session started by pi --mode rpc
  -> faux LLM provider
  -> real tools / real temp workspace / real git
```

Vite dev server is not part of canonical E2E. It may be useful for local debugging, but CI E2E should build `dist` and set `PI_WEB_UI_STATIC_DIR` so mirror-server serves the same asset shape as production.

## E2E Definition

An E2E test must include:

- a real `pi` CLI process, started in `--mode rpc` for headless CI stability;
- the local Pi Web UI mirror-server extension loaded through normal extension loading;
- the Web UI opened in a real browser by Playwright;
- real WebSocket traffic between browser and mirror-server;
- real Pi tools and real temp workspace files;
- real git repository state when testing git behavior;
- faux LLM provider responses as the only model substitution.

The following are not E2E:

- tests that mock or replace `/ws`;
- tests that directly set React state, Zustand state, or component props;
- tests that run only the frontend without Pi;
- tests that assert only DOM selector existence.

## Playwright-BDD Usage

Playwright-BDD expresses product-level acceptance flows. Feature files should describe what the user does and observes, while selectors and process details stay in step definitions and harness helpers.

Example:

```gherkin
Feature: Workspace status

  Scenario: Open git diff and artifact from a real Pi agent run
    Given a temporary git workspace
    And the faux response fixture is "workspace-artifact"
    When I open Pi Web UI
    And I ask the agent to update the workspace status docs
    Then the workspace float shows the current branch
    And the workspace float shows git additions and deletions
    And the workspace float shows the Markdown artifact

    When I open the Markdown artifact
    Then the right panel shows the artifact file content

    When I hide the right panel
    And I open the Changes row
    Then the right panel shows the git diff tab
```

BDD assertions are functional assertions: text exists, controls are enabled, tabs open, file content loads, session state changes, and requests complete. E2E does not perform screenshot or pixel assertions. Visual quality belongs to ADR 0011.

## Harness Design

### Process Lifecycle

Run E2E serially at first:

```ts
// e2e/playwright.config.ts
workers: 1
```

One scenario uses:

```text
1 short-lived bddgen Node process
1 Playwright runner process
1 Playwright worker process
1 browser process tree
1 pi --mode rpc process with mirror-server extension
```

Each BDD scenario starts a fresh Pi process and a fresh temp workspace. The built `dist` directory is reused across scenarios.

### Pi Launch

The harness starts Pi with:

- cwd set to the temp workspace;
- `--mode rpc` for headless command/control;
- `--extension <repo>/extensions/mirror-server.ts`;
- `--extension <repo>/e2e/fixtures/faux-provider-extension.ts`;
- `--provider` / `--model` set to the faux provider/model;
- `PI_WEB_UI_STATIC_DIR=<repo>/dist`;
- `PI_WEB_UI_PORT=<free port>` for scenario isolation;
- isolated `PI_CODING_AGENT_DIR` and session directory under the scenario temp directory.

The harness waits until mirror-server responds on the selected `127.0.0.1:<port>` before Playwright opens the page.

### Advanced Features

Scenarios that need `latestExecuteCtx`, such as Branch, Continue, or tree navigation, must enable Web UI advanced features through the real `/webui` command path before exercising those controls. `/fork` and `/clone` also require `/webui`, but execute through a fresh internal command handler rather than reusing the captured context. After session replacement, advanced features are disabled until `/webui` is run again; no automatic context recapture is performed. Workspace Status Float, git diff, artifacts, and Right Panel do not require `latestExecuteCtx`.

### Faux Response Fixtures

Faux response fixtures are static source modules under:

```text
e2e/fixtures/responses/
```

Each fixture defines the deterministic assistant response queue for the faux provider. If a scenario needs a Markdown artifact, the response must call the real Pi `write` or `edit` tool. The test then observes the artifact through Web UI state generated from real session/tool events.

Example:

```ts
export default [
  fauxAssistantMessage(
    [
      fauxToolCall("write", {
        path: "docs/prd/workspace-status-float.md",
        content: "# PRD: Workspace Status Float\n...",
      }),
    ],
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage("Updated the workspace status docs."),
];
```

The Playwright fixture selects the response fixture for the scenario, for example through an environment variable passed to the faux provider extension.

### Workspace Fixtures

Each scenario gets an isolated temp workspace:

1. create temp directory;
2. initialize git repository when needed;
3. write baseline files;
4. commit baseline when dirty/clean diff behavior matters;
5. start Pi with cwd set to that workspace;
6. clean up the Pi process and temp directory after the scenario.

Scenarios that need `No git repository` skip git initialization.

## Current Implementation

The implemented scenarios live in `e2e/features/chat-lifecycle.feature` and `e2e/features/workspace-status.feature`.

The harness starts the project-local `node_modules/.bin/pi` (unless `PI_E2E_BIN` overrides it) in `--mode rpc` and loads `e2e/fixtures/faux-provider-extension.ts` plus `extensions/mirror-server.ts`. The package peer range and lockfile are pinned to the current stable Pi CLI line (`>=1.1.0`, lockfile `1.1.0`); use Node.js `>=22.19.0`, as required by Pi. For slash-command coverage, the harness additionally loads an explicit fixture skill, prompt template, and `e2e/fixtures/slash-command-extension.ts`; the scenario verifies that Web UI suggestions discover all three resources and that the real Pi prompt path expands/runs them. The faux provider responds deterministically to the expanded skill and template text, while the extension command changes the session name and verifies its event reaches the browser.

The session replacement scenarios exercise `/new`, `/clone` and `/fork` through the browser and real WebSocket transport. Clone/fork checks also read JSONL files only from the active harness's isolated session directory: new session identities and parent-session links, clone history retention, fork-before-message semantics, and unchanged source/clone files. Browser checks cover draft restoration, cancelled picker/overwrite confirmation, `session_before_fork` hook cancellation, missing `/webui`, and empty fork choices. These are functional E2E assertions; desktop/mobile screenshot inspection remains a separate visual check.

The workspace scenarios use real Pi `write` tools. One modifies a committed Markdown file in a temporary git workspace, then verifies branch/diff/artifact state, `artifact-file`, and `git-diff` tabs. Another writes a Markdown artifact outside the git workspace and verifies that the Right Panel can still open it as a session artifact.

Run it locally with:

```bash
npm run e2e
```

## Priority Scenarios

### P0

1. **Chat lifecycle**: open Web UI, send prompt, faux provider returns text, assistant appears, input returns to ready state.
2. **Workspace Status + Right Panel**: faux response performs real `write` or `edit`, git diff changes, float shows branch/diff/artifact, clicks open `git-diff` and `artifact-file`.
3. **Conversation Tree**: create a branchable conversation, verify current leaf highlight, navigate tree, and Continue from a prior node.
4. **Connection recovery**: restart or reconnect mirror-server, then sync without duplicate chat rows.

### P1

- Model picker shows and selects faux model.
- Settings panel persistence.
- Context popover and compact action surface.
- Tool card success/error/long output expand behavior.
- Arch mode availability and enter/exit flow.

### Hub generation handoff regression

The desktop/mobile scenarios in `e2e/features/session-hub.feature` use two real
Pi processes and the packaged Hub CLI. They create two named histories through
the UI, run `/new`, then `/resume` into both saved sessions in succession without
returning to the portal. Assertions check actual WebSocket snapshot session IDs,
updated browser paths, correct/non-mixed message content, old-path `410` and the
other Pi's unaffected route. They do not mock the socket or repeat lifecycle
requests. Rendered screenshots are checked separately under ADR 0011.

### Long-session snapshot regression

Long persisted histories must be tested through the real Pi CLI and browser,
not only extension loading or a short empty-session smoke check. Snapshots use
flat `treeNodes` so a linear history cannot overflow JSON serialization.
Frontend unit tests additionally cover 10,000-node flat/legacy trees and reject
invalid topology atomically. Visual checks use an isolated 6,000-entry session
and desktop/mobile screenshots; they are separate from functional E2E.

### P2

- Large session rendering.
- Long artifact paths and large Markdown file content.
- Dark mode functional coverage.
- Non-git workspace.
- Artifact read failure.

## CI Policy

GitHub Actions should run E2E on every PR. Local default checks do not run E2E unless the developer explicitly invokes the E2E command or is changing E2E harness/tests.

The canonical CI order is:

1. install dependencies;
2. build Web UI assets with `npm run build:web`;
3. run Playwright-BDD E2E against `pi --mode rpc` and built `dist`.

## Consequences

### Positive

- E2E tests cover the real Pi Web UI product path.
- Faux provider removes LLM cost and nondeterminism while preserving agent/tool/session behavior.
- Git diff and artifact behavior are validated against real workspace state.
- Playwright-BDD keeps acceptance flows readable and close to PRD language.

### Negative

- Slower than frontend-only integration tests.
- More moving parts: Pi CLI, mirror-server, faux provider, temp workspace, browser.
- Initial implementation runs serially to avoid port and workspace isolation complexity.
- Harness failures can come from process lifecycle, not only UI bugs.

### Neutral

- Visual validation remains separate and may use Browser screenshots without being E2E.
- Low-level frontend logic should still have unit/integration tests outside Playwright-BDD.

## Alternatives Considered

| Alternative | Assessment |
|-------------|------------|
| Mock `/ws` without Pi | Useful for visual validation or frontend integration debugging, but not E2E |
| Real Pi + real provider | Highest fidelity, but slow, costly, and nondeterministic for regular E2E |
| Interactive TUI mode | Closest terminal experience, but CI requires pseudo-terminal handling; `--mode rpc` keeps real Pi CLI/session with a stable headless host |
| Playwright without BDD | Viable, but less readable for PRD-level acceptance flows |
| Component tests with mocked props | Useful for narrow UI logic, insufficient for cross-boundary Web UI behavior |

## Migration Strategy

1. Done: add `e2e/` root directory with Playwright-BDD config.
2. Done: add faux provider extension and static faux response fixtures.
3. Done: add Pi E2E harness that starts `pi --mode rpc` with local mirror-server extension.
4. Done: add temp workspace helpers for git and file setup.
5. Done: add Workspace Status + Right Panel feature using a real `write` tool call.
6. Next: add Chat lifecycle as a smaller smoke scenario if it proves useful beside Workspace Status.
7. Next: add conversation tree and connection recovery scenarios.

## Minimal-chat regression coverage

- Desktop and mobile start with navigation fully hidden. Explicit header toggles and mobile `/tree` reveal the navigation Sheet; close controls are exercised rather than offscreen elements.
- Workspace opens on demand. Selecting Git/artifact closes its dialog before opening the detail surface; repeated targets retain tab deduplication.
- `collapse-regression` uses native faux thinking and a real Pi `write` call. Reasoning and tool payloads start collapsed, expand with their public controls, and remain collapsed after history refresh.
- The 6000-message long-session scenario keeps its full fixture and checks loading, label/end search, refresh, and complete snapshots. Its trace-enabled browser budget is 180 seconds; ordinary scenarios retain the normal timeout.
- Browser screenshots remain a separate visual check, not a substitute for these tests.

## Bilingual interface regression

Language is a browser presentation preference, not a session command. Bilingual scenarios must run through a real Pi process and built Web UI, switch via Settings, verify document language and refresh persistence, and preserve drafts, session identity and original message content. Existing English scenarios remain a separate regression baseline. Browser-locale scenarios should use an actual browser context locale rather than replacing the Zustand store or mocking WebSocket data.

See `docs/prd/interface-language.md` for the translation boundary. Raw provider errors, dynamic extension text and message content need not become Chinese when the interface does.

## Interaction performance regression

Use isolated real Pi fixtures for long-tree navigation and large multiline/single-line tool output. Record local timings and mounted row counts separately from functional pass/fail. Do not use a narrow machine-specific latency threshold as proof of correctness or a broad performance guarantee.

Virtualized-tree tests navigate via public search/current-node controls and scrolling. An offscreen node need not exist in the DOM, but complete snapshots and later mounted rows must preserve its identity/content. Full output access must remain available even when a bounded preview or plain-text view avoids expensive highlighting.

See `docs/prd/interaction-performance.md` for scope and preserved invariants.

## Project-file download regression

`file-download.feature` uses a real Pi `write` tool to create a Chinese-named
PDF byte fixture, then clicks the assistant's bold path, Markdown link and
inline-code path. Desktop and mobile run both directly and via a temporary
packaged Hub. Cancel sends no preparation request; confirmation downloads the
original bytes and basename. External-link confirmation and missing-file errors
are checked without leaving the chat. Screenshots record the visible dialog.
The fixture is a byte-integrity file, not a PDF-rendering test.

`e2e/file-download.integration.ts` separately checks a 5 MiB binary stream, HTTP
headers/methods/Origin, path restrictions and stale identities with real Pi/Hub.
Run with `node --import ./tests/register-ts.mjs --test e2e/file-download.integration.ts`.

## Collapsible conversation date filters

`date-history.feature` verifies desktop/mobile default collapse, keyboard expansion,
unchanged history request count and selected history when collapsing, retained
historical-view warning, reduced panel height, and preserved unapplied date edits.
The saved-session picker remains expanded. These checks run through the real Pi
history fixture; separate Browser screenshots verify visible space and controls.

## Workspace-file upload regression

`file-upload.feature` exercises direct desktop and Hub desktop/mobile with real
Pi and the packaged Hub CLI. Files include UTF-8 text, an original PNG and a
17 MiB binary that cannot fit a base64 WebSocket prompt. The browser uses the
real picker and HTTP PUT, observes progress/cancel, verifies exact local bytes
under the session folder, and asks Pi's real `read` tool to open the text file.
The browser hard ceiling is checked using a sparse file, without loading its
contents. Server-configured limits are enforced separately during preparation.
Cancellation preserves the draft without sending a prompt. Version-2 cases also
exercise 8 MiB chunking and page-refresh/reselection recovery using real HTTP,
not mocked requests; a failure retransmits only unconfirmed chunks. Synthetic files and private test processes
only; CDP upload throttling controls timing without mocking routes or sockets.
`e2e/file-upload.integration.ts` separately covers real backend boundaries,
including legacy exact 50 MiB direct/Hub uploads, version-2 files larger than
50 MiB, checksum/order/size boundaries and real compaction/authentication
rejection. A declared-size boundary is not evidence that an entire 1 GiB file
was physically transferred; the validation report distinguishes those checks. Browser regression also blocks `.pi-uploads` with a symlink, verifies
failure preserves the draft/files, then repairs and retries; a second real
browser creates a new session during upload to prove old attachments are not
resent and already saved files survive. Empty sessions defer JSONL creation,
so replacement assertions compare actual `state_sync` identities, not file counts.
Desktop/mobile screenshots are inspected separately, not counted as E2E proof.

## Hub return and rename regression

The real Hub scenarios cover desktop/mobile return-home links, unsent text and attachment cancellation, immediate rename acknowledgement followed by Hub return without waiting for the 15s lease renewal, stable cards/focus across polls, native browser back and immediate text submission after lifecycle handoff. `pageshow(persisted)` is also dispatched deterministically for the refresh handler; this does not certify that every browser used BFCache. New proof-gap/deadline tests use real HTTP and Unix IPC; a limited browser trace diagnosis does not claim visibility of the registry IPC timeline. See [navigation validation](../validation/hub-navigation.md).

## References

- `AGENTS.md`
- `docs/adr/0002-web-ui-extension-event-protocol.md`
- `docs/adr/0008-unified-websocket-protocol.md`
- `docs/adr/0011-web-ui-visual-validation.md`
- `docs/prd/workspace-status-float.md`
- `docs/prd/workspace-artifacts.md`
- `docs/prd/right-panel.md`

## Companion usage fixture

The companion browser scenarios and `e2e/whale-usage.integration.ts` run real Pi with an isolated synthetic saved session containing old/current dates, a sibling branch, different actual response models, and mixed known/unknown prices. These deliberately verify full-session rather than date-page totals. Browser asset tests import synthetic PNG and two-frame looping GIF files through Settings and verify Blob rendering/persistence without a Pi upload. The GIF fixture checks native rendered frame changes, original IndexedDB byte integrity, reload recovery, invalid/MIME-mismatched replacement rejection, and static PNG display under either system or user reduced-motion settings. Settings thumbnails remain still; motion toggles do not rewrite the original GIF. This is browser-native decoding, not a mocked component or a JS frame player. Raw downloaded fan art is used only for separate local visual inspection, never committed as a fixture. These checks do not certify provider billing, physical phones, Safari or the public deployment.
