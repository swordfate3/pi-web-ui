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
