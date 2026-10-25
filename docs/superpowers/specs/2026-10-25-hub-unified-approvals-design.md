# Hub unified approvals

Approved requirement: retain Gate as the independent executor, but make all existing Gate approval operations available from the trusted Hub management portal. Routine approval must never require running a host `approve` command. Existing MCP/extension reviews are discoverable from the same portal.

## Authority and deployment

Hub keeps its separate trusted management origin, existing gateway login, management cookie and CSRF checks. Ordinary Pi chat/file origins cannot read management data or make decisions. Gate remains independently deployed so Hub replacement does not kill its own deploy worker. Hub receives a new, dedicated, bounded management credential; neither the ordinary request token nor lifecycle token can approve anything. Hub never receives Docker access, the full Gate administrator socket, SSH administrator keys or arbitrary command execution.

Gate exposes only a fixed management protocol on its existing loopback HTTP listener. Bootstrap exports this one credential into Hub's private state once. The browser never receives the credential. Existing CLI administration is retained for recovery, but is not necessary for routine approvals.

## Gate protocol

- `GET /v1/hub-management`: `{tasks: Task[], policies: Policy[]}`; open tasks are never hidden behind terminal history; bounded history and response size.
- `GET /v1/hub-management/tasks/<kind>/<id>`: exact current task projection.
- `POST /v1/hub-management/decisions`: `{kind,id,revision,action,decision_id}`. Kinds `deployment`, `runtime`, `restart`, `intent`; actions advertised by the task, drawn from `approve`, `reject`, `rollback`. Intent is a non-executable enrollment proposal and can only be rejected until an administrator has configured the service definition.
- `GET /v1/hub-management/decisions/<decision_id>`: durable decision receipt, for lost responses.
- `POST /v1/hub-management/policies`: `{kind,id,revision,mode,decision_id}`. Kinds `service`, `runtime`, `restart`; modes `manual`, `auto`, `disabled`. Preserve the trusted image allowlist; the web cannot introduce new trusted images/templates.
- `POST /v1/hub-management/resume`: `{id,revision,decision_id}` resumes a paused registered service.

`Task` fields: `kind`, `id` (32 hex), `revision` (64 hex), `status`, `stage`, `title`, `target`, `actions` plus optional `version`, `commit`, `image`, `plan_hash`, `created_at`, `details` (bounded sanitized explanatory object). `Policy` fields: `kind`, `id`, `revision` (64 hex), `mode`, optional `paused`, `images` (trusted immutable image IDs). Revisions bind the full authoritative task/definition and current policy, not just the public summary. No raw runtime snapshot, environment, credentials, private mounts or chat content enters public projections.

`Receipt`: `{decision_id,status}` plus optional `task`/`policy`; status `recorded`, `delivery_unknown`. Same decision ID and identical payload return the original durable receipt without re-executing. A reused ID with changed payload is rejected. Persist intent before dispatch; recovered unfinished intent is never automatically replayed. Bound receipts; full storage rejects new writes instead of silently forgetting uncertain decisions. Under the Store lock, recheck revision and current policy before invoking existing validated approval methods. Concurrent/stale decisions produce conflict. Reuse existing deployment plan/commit checks, runtime/lifecycle validation, failure accounting and policy fences.

## Hub protocol and portal

Optional `gateManagement: {endpoint, credentialFile}` uses the existing validated loopback provider configuration. Routes mirror the fixed protocol under `/api/management/gate`. Before forwarding, validate exact bodies, management identity, Origin and CSRF; revalidate identity after asynchronous work. Request timeout or transport failure is reported as unknown, never automatic retry. Server response fields are validated/projected; upstream error bodies are not relayed.

The management portal gains a visible approval section: pending tasks, expandable immutable task details, explicit approve/reject/rollback, policy selectors and paused-service resume. Show success as approval recorded or queued, distinct from execution completed. Preserve a decision ID until receipt reconciliation. Authorization expiry clears protected content. Refreshing lists never performs writes, approvals, login or policy changes.

Existing runtime/restart UI points to this approval section instead of instructing users to use `runtime-approve`. The public chat portal links to the trusted management portal; no management UI or protected request data is rendered on a Pi-controlled origin.

## Extension inbox

The trusted portal lists pending metadata from currently registered interaction-capable sessions, and links to existing per-request trusted review pages. No private preview or OAuth URL is loaded into the aggregate list. Source generation, runtime/session identity and expiry are checked. Review/authorization remains bound to the original source request; OAuth consent still belongs to the provider. Enumeration uses bounded concurrency and exposes partial/unavailable state rather than an incorrect empty success.

## Acceptance

Offline temporary Gate tests prove approval for each executable task kind, immutable revision checks, replay/conflict behavior, policy changes, independent token rejection, no credential leakage and request bounds. Hub HTTP tests prove chat isolation, authentication/CSRF, exact forwarding and identity revocation. Portal behavior tests cover approve/reject, confirmation cancellation, unknown outcomes, stale/expired views and policy changes. Real browser screenshots cover narrow phone and desktop layouts using synthetic tasks only. Production services and volumes are not test fixtures. Build tracked dist and validate source/output consistency. Delivery is a development branch; production rollout is a separate explicit action.
