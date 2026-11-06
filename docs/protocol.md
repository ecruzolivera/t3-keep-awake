# Verified T3 integration contract

Research date: 2026-11-06. Primary local source is the official T3 checkout at
commit `310a0d51942ad742678e9f50783e34967de11b12`, server package 0.1.7.
The installed server descriptor independently reports version 0.1.6/protocol 2.
These are different verification levels: the authenticated live stream has not
been exercised, and no credential was collected during implementation.

The maintainer discussion in [issue 10929](https://github.com/pingdotgg/t3code/issues/10929)
contains an initial V1 reply and a later V2 clarification. Names in the first
reply are not the implementation contract. The official source pointers below
refer to the inspected commit; no generated SDK or private database is used.

## Sources

- [environment.ts](https://github.com/pingdotgg/t3code/blob/310a0d51942ad742678e9f50783e34967de11b12/packages/contracts/src/environment.ts): orchestration version 2, query/header names, public descriptor.
- [auth.ts](https://github.com/pingdotgg/t3code/blob/310a0d51942ad742678e9f50783e34967de11b12/packages/contracts/src/auth.ts) and [environmentHttp.ts](https://github.com/pingdotgg/t3code/blob/310a0d51942ad742678e9f50783e34967de11b12/packages/contracts/src/environmentHttp.ts): token types, routes, scopes, session and ticket results.
- [EnvironmentAuth.ts](https://github.com/pingdotgg/t3code/blob/310a0d51942ad742678e9f50783e34967de11b12/apps/server/src/auth/EnvironmentAuth.ts): bootstrap consumption, narrowed grants, Bearer vs DPoP issuance, ticket audience authorization.
- [RpcAuthorization.ts](https://github.com/pingdotgg/t3code/blob/310a0d51942ad742678e9f50783e34967de11b12/apps/server/src/auth/RpcAuthorization.ts): shell subscription requires `orchestration:read`; file RPCs require `filesystem:read` in this source revision.
- [orchestrationV2.ts](https://github.com/pingdotgg/t3code/blob/310a0d51942ad742678e9f50783e34967de11b12/packages/contracts/src/orchestrationV2.ts): V2 shell schemas, activity fields, background tasks, subscribe input.
- [ws.ts](https://github.com/pingdotgg/t3code/blob/310a0d51942ad742678e9f50783e34967de11b12/apps/server/src/ws.ts) and [ShellStream.ts](https://github.com/pingdotgg/t3code/blob/310a0d51942ad742678e9f50783e34967de11b12/apps/server/src/orchestration-v2/ShellStream.ts): RPC JSON serialization, snapshot/resume/enrichment handling.
- [orchestrationV2PendingBackgroundWork.ts](https://github.com/pingdotgg/t3code/blob/310a0d51942ad742678e9f50783e34967de11b12/packages/shared/src/orchestrationV2PendingBackgroundWork.ts): thread wait detection, persistent commands, awaited tasks and PR-watch identifiers.
- [ProjectionStore.ts](https://github.com/pingdotgg/t3code/blob/310a0d51942ad742678e9f50783e34967de11b12/apps/server/src/orchestration-v2/ProjectionStore.ts): schema version 2, shell projections, silent compaction and remote child metadata boundaries.
- Effect 4.1.2 `src/rpc/RpcSerialization.ts` and `RpcMessage.ts`, as installed
  by the inspected checkout: `layerJson` encodes a single JSON value per WebSocket
  message; decoded arrays contain multiple RPC envelopes. This is Effect RPC,
  not JSON-RPC 2.0 and not NDJSON.

## Auth and transport

1. Read `GET /.well-known/t3/environment`, require protocol 2/native Linux, and
   bind credentials to the returned environment identity.
2. POST form data to `/oauth/token`:
   `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, bootstrap
   `subject_token`, `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`,
   `requested_token_type=urn:ietf:params:oauth:token-type:access_token`,
   `scope=orchestration:read`. No DPoP proof is supplied, which current source
   handles as Bearer issuance. Unsupported token types are rejected.
3. Require exactly `orchestration:read` in token scope and effective permissions
   from `GET /api/auth/session`, using `Authorization: Bearer …`. Prefer the
   `permissions` field over legacy compatibility `scopes` when present. Persist
   the resulting token with expiry, never the bootstrap or pairing URL.
4. POST `/api/auth/websocket-ticket/rpc` with Bearer authorization. On **404 only**,
   fall back to `/api/auth/websocket-ticket` (official client compatibility path).
5. Connect `/ws?orchestrationProtocol=2&wsTicket=…`, keeping its URL out of logs.
   HTTP requests also carry `x-t3-orchestration-protocol: 2`. Redirects are denied.
6. Send:

```json
{"_tag":"Request","id":"shell","tag":"orchestration.subscribeShell","payload":{"requestCompletionMarker":true},"headers":[]}
```

Streaming envelopes are `{"_tag":"Chunk","requestId":"shell","values":[...]}`.
Each processed chunk is acknowledged with `{"_tag":"Ack","requestId":"shell"}`.
`Ping`/`Pong` operate at the RPC layer. Heartbeats are every 10 seconds; no Pong
or no synchronized initial snapshot for 30 seconds ends the connection.
`Exit`, `Defect`, unknown envelopes, malformed JSON, or incompatible schema end
the stream. Raw terminal error payloads and close reasons are never logged.
No frame-part capability is advertised, so no optional T3 frame-part assembly is
required. Maximum accepted JSON message size is 64 MiB; larger streams require
a compatible update rather than silently incomplete activity detection.

## Snapshot handling

Every connection requests a **fresh snapshot**, a supported recovery strategy;
sequence-resume optimization is intentionally unnecessary. Read authoritative
`snapshot` events (`schemaVersion: 2`, `snapshotSequence`, `threads`,
`archivedThreads`). Apply `thread.updated`/`thread.removed`, keep sequence metadata
for project updates/removals, and commit only after `synchronized`.

The server also emits project-only `snapshot` items marked with
`resolvedRepositoryIdentityRoots`. These update repository enrichment and do
**not** replace thread state. Ignore them for activity calculation. This matters
both during connection and live enrichment refreshes.

Application sequence numbers need not be contiguous: filtering and coalescing
skip unrelated events. Retain updates at equal sequence (different entities can
share a snapshot boundary); ignore older sequence updates. Reconnection uses a
new staging projection and retains the previous hold through the original grace
deadline. Only a synchronized replacement snapshot clears that deadline.

## Activity limits and deliberate policy changes

`activityRunStatus` takes precedence over latest-run `status`. Preparing,
starting, and running count. Blocking `pendingRuntimeRequest` suppresses that
thread's own turn; `blocking: false` allows it to continue. Plain `waiting`
indicates completion/checkpoint/wait semantics, not proof of ongoing execution.
`blockedOnThreadWait` identifies a coordinator executing only thread wait or a
blocking delegate wait; local child shells are counted independently.

`pendingBackgroundTasks` is metadata, not a process table. Awaited commands,
monitors, and background tasks count after parent completion. Unawaited commands
do not: this is the user's explicit revision of PROMPT.txt. Native `subagent`
summaries are themselves running-work evidence, even without an awaited flag;
app child summaries with `childThreadId` follow that local child's state. PR
watch tasks start with `pull-request-watch:` and are filtered even though T3
marks them awaited. Schedules/goals/settled markers alone never count.

Remote app tasks have richer `remoteChild` metadata in full subagent projections,
but the shell pending summary lacks an explicit environment identity in some
cases. The companion does not subscribe to conversation bodies to infer that
metadata. A remote-only wait does not hold, and a missing local app child is not
invented. An anonymous remote subagent summary can still be indistinguishable
from a native local subagent: this is a documented potential false hold. Likewise,
if a provider never reports its continuing work, this companion cannot detect it.

The sleep backend deliberately follows Herdr's broad `sleep:block` behavior,
another user-approved revision of PROMPT.txt. DMS invokes `systemctl suspend`
for automatic and manual suspend; the sleep lock can block both. A login1
`idle` lock alone does not cover DMS-managed suspend, and a general screensaver
lock can inhibit screen locking/display sleep. No DMS code or settings are changed.

## Upgrade checklist

Check the descriptor, schema and framing against official source; inspect scope
semantics and any new run/wait/task states; update synthetic fixtures and tests;
run `diagnose` and `run --observe` before activation. Review ambiguous subagent
locality before claiming broader coverage. An unknown schema/activity state is
an actionable incompatibility, not permission to hold a stale inhibitor forever.
