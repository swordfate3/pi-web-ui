# Managed restart: one bounded execution clock

Date: 2026-10-17. This is a coordination ruling for T2-R3 and F6, not a
production configuration change.

The earlier155-second whole-operation window did not cover the separately
promised30-second graceful stop and120-second successor readiness allowances.
Gate and Hub must instead use a fixed **210-second** total measured from the
immutable Gate `started_at` (Unix epoch milliseconds). Manual approval and queue
waiting are excluded; polls, reconnects and process recovery never reset it.

The supported execution envelope is:

| Phase | Maximum allowance |
| --- | ---: |
| Gate execution preflight | 4s |
| Fixed control acknowledgement | 3s |
| Supervisor snapshot/version/prepare and local validation | 15s |
| Graceful old-child stop | 30s |
| Model synchronization and successor spawn | 10s |
| Successor readiness after spawn | 120s |
| Final Gate observation and Hub registration/proof | 15s |
| Scheduling/transport reserve | 13s |
| Total | 210s |

The existing Gate preflight4s and fixed-control3s caps remain. Supervisor checks
must refuse to signal the old child if their15s allowance is exceeded, including
rechecking the clock after prepare. Model synchronization uses a bounded helper;
sync/spawn must not silently borrow from the120s readiness allowance. If local
process creation, filesystem or scheduler stalls exceed an overhead allowance,
the operation is outside the supported envelope and must fail closed or become
`recovery_required`, without forced Pi kill, a second stop or a new submission.
An uninterruptible OS call is not a promise of successful recovery.

Gate retains an outer, non-extending210s wall/monotonic deadline. Each transport
step must respect its remaining budget. Hub uses `started_at + 210000` for exact
registration readiness and rejects unreasonable future timestamps. Its handoff
lease starts at actual retirement/disconnection and is at most210s; waiting for
manual approval while the original connection remains live does not consume it.
The browser's independent120s recovery budget starts at its old WebSocket close,
not at submission or a repeated control message. Ordinary15s handoff is unchanged.

Tests must exercise a success beyond155s using an injected/fake clock while all
individual allowances remain in budget, expiry at210s, and non-extension during
repeated polling/recovery. Source constants, contract documentation and timing
tests must move together; no runtime or Gate installation is implied here.
