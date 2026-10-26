# Optional managed RPC text input

Pi Web remains a standalone single-session extension. It does not start a
Manager, install Pi versions, approve tasks or control containers.

A separately provisioned Manager may launch Pi in RPC mode with its immutable
input guard and `PI_RUNTIME_RPC_WEB_INPUT=correlated-text-v1`. In that explicit
profile, an **idle, plain-text prompt** uses the guard's fixed correlated RPC
input action instead of Pi's fire-and-forget extension API. Pi therefore sees
that input's source as `rpc`, not `extension`. Templates keep the normal RPC
expansion behavior; extensions that distinguish input sources must account for
this opt-in profile.

The guard records the prompt before asynchronous preflight begins. An exact
`started` acknowledgement and actual generation settlement are necessary for
later update preparation. A prepare lease rejects new input; cancellation does
not replay rejected messages. Busy, malformed, oversized or unavailable guarded
input fails explicitly, without retrying through the old SDK path.

This narrow path does **not** cover images, slash commands, queued steering or
follow-up, message revision or extension-owned deferred work. Existing SDK
dispatch keeps its conservative rule: because its void return is not completion
proof, it permanently removes that RPC process's update eligibility. A handled
correlated prompt also remains ineligible. Later unrelated settlement cannot
clear either condition. Normal reads and legacy/standalone chat remain usable.

Without the exact opt-in, existing dispatch behavior is unchanged. An opted-in
process with a missing or incompatible guard cannot silently bypass it. Guard
cooperation is not security isolation against hostile code in the same process.
This mechanism grants no administrator credentials or update authority, and its
successful tests do not mean complete update activation is implemented.

The optional private controller can prepare a lease and then commit the exact
complete held snapshot. Commit compares the live run, session, leaf, file,
working directory, Pi version, provider/model/thinking and settled flags without
an asynchronous gap before permanently latching input shutdown. Lease age uses
the original monotonic clock deadline. Commit does not extend it. After commit,
neither cancellation nor retry can reopen input, even if the controller loses
the acknowledgement. Read-only Web queries remain available until process exit.
This handshake is private quiescence evidence, not permission to stop a process
or proof that a candidate version can restore the session. Manager must verify
those separately before authorizing a replacement.

A replacement process may additionally be launched with the private
`PI_RUNTIME_PENDING_ACTIVATION` operation ID. Web mutations start closed,
including the interval before its controller socket is ready. Cancelling or
expiring a preparation lease cannot open that bootstrap gate. Only an exact
private `admit` request with the held complete snapshot and unexpired original
lease releases it; wrong operations, state drift and replay are refused. A
normal standalone process cannot use `admit`. Read-only queries remain possible.
The external executor must verify readiness and publish its installation
selection before requesting admission, and treat a lost acknowledgement as
unknown rather than replaying it. This optional gate still grants no update,
approval, executable selection or process-control authority to the extension.

Successful exact admission consumes that operation's bootstrap marker in the
current process environment, which the extension passes to its controller.
Ordinary resource reload or session replacement therefore does not recreate an
already-released gate. Cancellation, expiry and failed admission do not consume
the marker; controller recreation stays closed in those cases. A present but
malformed marker (including an empty string) also keeps the mirror fallback
closed if controller construction fails. This is process/run-local lifecycle
state, not a persisted selection or authorization for another process. The
default RPC dispatch/taint rules above still apply after reload.
