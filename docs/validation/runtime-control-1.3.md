# Runtime-control compatibility: Pi 1.3.0

Validated locally on 2026-10-18, based on main `d9afe7f` in the isolated branch
`codex/global-pi-runtime-refresh`. This change does not update Pi itself or grant
Docker access to a Pi container.

## Change and safety boundary

`extensions/runtime-control.ts` admits the audited Pi versions 1.1.0 and 1.3.0.
Unknown SDK versions still report ineligible/busy and refuse prepare. The stdin
guard remains byte-identical to the reviewed image-owned copy. No terminal taint,
pending/busy, session identity, prepare barrier or async-command safeguard is
removed.

Generating sessions may be deferred by the separate Gate runtime-update task.
That does not imply every busy flag clears when generation ends: unverified
terminal input and arbitrary async extension commands intentionally retain their
uncertainty until a fresh local Pi process is started.

## Evidence

- Test-first compatibility case failed against the old 1.1.0-only adapter, then
  passed with 1.3.0 admitted and 99.0.0 still refused.
- Full extension unit suite: 425 tests, 424 passed, 1 optional skip, 0 failed.
- Real Docker Pi 1.3.0 managed-runtime integration: initial 1 passed in 11.878
  seconds; final explicit snapshot-version run passed in 3.710 seconds.
  Uses two temporary synthetic TUI sessions and an isolated Hub. The same Docker
  container and exact saved session/leaf/model/thinking survive one child refresh;
  runtime identity changes, no saved prompt is replayed, the other Pi is unchanged,
  and ordinary quit still exits.
- Real Docker Pi 1.3.0 stdin-guard TUI acceptance: initial 6 passed in 28.820
  seconds; final explicit snapshot-version run passed in 15.368 seconds.
  Covers running terminal bash; prepare blocking builtins and extension commands
  without replay; arbitrary Web command taint surviving reload; unflagged and
  false-flag async commands remaining unsafe after their ACK; audited Web naming
  preserving eligibility.
- `just check` passed with the existing 30 warnings and 1 info; TypeScript and
  production Web/Hub builds passed. Dist correspondence is verified separately
  before packaging.
- A negative run intentionally used the 1.1.0 candidate image with expected
  1.3.0: it failed before restart with `Expected Pi 1.3.0, got 1.1.0`. This
  verifies that stale/mistagged images cannot silently provide 1.3 audit evidence.
  The default host 1.1.0 guard path also passed all six cases in 7.888 seconds.

The tested 1.3.0 image resolved to
`sha256:76eab65321bccb135d8450b9b03bace2f18515fc79c29e16acf0734d6332d738`.

The guard harness accepts `PI_RUNTIME_TEST_IMAGE` and uses only its temporary
test container's child credential internally. No production home, credentials,
SSH, API keys or session volumes are mounted. Test containers are cleaned up by
exact identity.

## Reproduce

```bash
PI_RUNTIME_SOURCE=/path/to/reviewed/pi-docker \
PI_RUNTIME_TEST_IMAGE=isolated-pi-image-containing-1.3.0 \
PI_RUNTIME_TEST_VERSION=1.3.0 \
python3 e2e/harness/test-managed-runtime.py

PI_RUNTIME_SOURCE=/path/to/reviewed/pi-docker \
PI_RUNTIME_TEST_IMAGE=isolated-pi-image-containing-1.3.0 \
PI_RUNTIME_TEST_VERSION=1.3.0 \
python3 e2e/harness/test-stdin-guard-tui.py
```

These require local Docker, Unix sockets and PTYs. They use a faux provider, not
a paid or external model endpoint. This is backend runtime acceptance, not a new
browser visual validation or proof of compatibility with future Pi releases.
Docker acceptance requires an explicit expected version and checks the runtime's
own snapshot before accepting eligibility or recovery assertions; the image tag
alone is not version evidence.
