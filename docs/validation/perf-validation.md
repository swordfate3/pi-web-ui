# Interaction optimization validation

Artifact filenames below refer to the external directory described in [the report index](README.md), not this docs directory. This is a project validation report, not a Pi core changelog.

## Comparable local measurements

Real project Pi CLI, immutable old runtime `0.1.1-3455d073085dedfbc606806b` versus optimized repository build, Chromium 1440×1000, generated 6000-message history. Measurements start after the end marker is present and a 1-second settling interval. Two samples per toggle, same measurement code and fixtures. Timings include Playwright interaction/visibility checks; they are not precise INP or CPU-profile measurements.

| Measurement | Old runtime | Optimized build |
| --- | --- | --- |
| Sidebar click→search visible | 2879.8 / 2959.9 ms | 930.8 / 911.0 ms |
| Sidebar click→double RAF | 3429.3 / 3359.1 ms | 1127.8 / 1087.6 ms |
| Mounted sidebar rows | 6003 / 6003 | 32 / 32 |
| Large write tool open→double RAF | 207.9 / 90.6 ms | 103.2 / 74.9 ms |
| Large write tool close→hidden | 599.9 / 1146.8 ms | 230.7 / 223.5 ms |

Data: `perf-baseline-settled.jsonl`, `perf-optimized-layout-final.jsonl`. The original early baseline included initial loading and is not used in this comparison. Earlier experimental optimized samples likewise are not the final measurements. The sidebar interaction still takes around 0.9 seconds in this extreme-history setup: this is an improvement, not a claim of instant/60fps behavior. Chat layout still has 6000 mounted messages and store updates are not normalized or frame-batched.

Large fixture uses real Pi write/read/bash. Faux large arguments use equal deterministic 8192-character chunks in both runtimes and an enlarged faux model context to avoid compaction consuming its response queue. This is not a streaming-token stress test. Exact clipboard checks cover complete 300018-character single-line and 347999-character multiline write parameters; returned bash output preserves Pi's own truncation notice and tail, not an invented untruncated file result. Initial failed test attempts mixed lazy collapsed controls and unsettled snapshot reconciliation; they are not final pass evidence.

## Functional checks

- 36 real Pi/WebSocket/Chromium/faux-provider E2E passed (`perf-e2e-final.log`).
- 55 unit tests passed (`perf-unit-final.log`).
- TypeScript/build/Biome/diff checks passed. Existing bundle-size warning remains.
- New real tests cover bounded rows, focus retained after wheel scrolling beyond overscan, keyboard movement, full clipboard data and large-content paging.
- Full long-session regression retains labels, branches, complete snapshots and refresh; public match navigation mounts offscreen search results.
- Existing English/Chinese, lifecycle, export, workspace and collapse tests remain passing.

## Separate Browser visual evidence

Isolated URLs inspected: `http://127.0.0.1:45579/` (ordinary tool), `http://127.0.0.1:46663/` (large output), `http://127.0.0.1:45931/` (6000 history), `http://127.0.0.1:46309/` (actual local release with 6000 history). All stopped after inspection.

1440×900 desktop and 390×844 mobile: tool detail/clipboard entry, sidebar tree/current/search, large-output plain pages with character-range notice and previous/next controls. The large desktop screenshot `perf-desktop-large-pages.png` was captured at 2560×1229 after the shared visible browser was resized; it is reported at its actual size, not counted as 1440×900. Long-tree desktop and actual-release mobile screenshots were captured at their stated viewport sizes. No clipped action controls or lost tree rows observed in checked states; code remains intentionally horizontally scrollable. An initial transition-frame screenshot was recaptured after settling.

Shared visible Chrome needed bringToFront and some direct DOM clicks for screenshot preparation; functional proof is the separately passing E2E suite, not those visual clicks.

## Runtime / limitations

Installed full snapshot: `$HOME/.pi/agent/local/pi-web-ui/releases/0.1.1-18cb709e34a9d398464c1a54`.

Full inventory/hash/source parity checked for 693 files, no runtime symlinks, one enabled WebUI registration. Captures an uncommitted working tree, not a Git commit containing the changes. No commit/push, no prompt/reload/stop of existing user Pi instances.

No Redis, new UI runtime, extra service or new dependency. Full chat virtualization, streaming coalescing, syntax-highlighting workers and exhaustive multi-browser/session-race measurement remain future work. Cache tests check bounds/keys and item-reference contracts; they are not a React-profiler count of every production commit. Session owner reset has a source-boundary unit check and existing lifecycle E2E, not a dedicated DOM-state-reset test for every fork/clone.
