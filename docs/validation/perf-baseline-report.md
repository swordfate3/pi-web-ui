# Sidebar interaction baseline (immutable local release, historical attempt)

> Superseded attempt: these timings include initial-history work and are not the final comparable benchmark. The large-tool attempt below was not passing at this checkpoint. See [final performance validation](perf-validation.md) for settled old/new samples and the subsequently passing suite. Artifact filenames refer to the external directory in [the report index](README.md).

- Runtime assets + mirror-server: `~/.pi/agent/local/pi-web-ui/releases/0.1.1-3455d073085dedfbc606806b` (release 0.1.1-3455d073085dedfbc606806b)
- Pi CLI: project-installed real `node_modules/.bin/pi`, running `--mode rpc`; browser: Playwright Chromium; faux provider used only for model responses.
- Fixture: generated 6,000 history messages; desktop viewport 1440×1000; two open-toggle samples. Measurements are performance observations, not a CPU-profile diagnosis.
- Data: `perf-immutable-0.1.1-3455d073085dedfbc606806b-baseline.jsonl`; screenshot: `perf-immutable-sidebar-open.png`.
- Click → search visible: first 7704.1 ms, repeated 3454.2 ms. Click → double requestAnimationFrame: first 10701.4 ms, repeated 3904.9 ms. DOM rows: 6003 both samples. Long-task observations (ms): first sample included 3386, 1629, 2571 ms entries; cumulative observer values are captured as arrays in JSONL. These numbers are machine/run-specific.
- Baseline command passed the real Pi/browser scenario; no narrow latency threshold was applied. This unoptimized baseline intentionally has no bounded-row assertion.
- Large output scenario uses real Pi `write`/`read` tools, but the immutable release run currently encounters a WebSocket error while reading the approximately 300 KB multiline output. Its raw-output preservation assertion is pending the frontend optimization; do not interpret it as tested successfully. No CPU profile or causal attribution is claimed.
