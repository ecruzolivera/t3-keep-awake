# t3-keep-awake

A Linux companion that holds one OS sleep inhibitor while observable local T3
Code work runs, then releases it when that work finishes. Runs as a systemd
user service; no T3 fork, database access, desktop plugin, root daemon, or runtime
npm dependencies. Requires native Linux, Node.js 24+, systemd/logind, and T3's
orchestration protocol **2**. WSL is not supported.

## What counts as work

Monitor every local thread in **one explicitly configured loopback environment**,
including observable local child threads and work delegated here from elsewhere.

| T3 status | Keeps host awake |
| --- | --- |
| Preparing, starting, running local turn | Yes |
| Observable running local subagent | Yes, including after parent completion |
| Awaited background command, monitor, or task | Yes, including after parent completion |
| Blocking input/approval request, with no other work | No |
| Nonblocking asynchronous question while turn runs | Yes |
| Open PR / `pull-request-watch:` monitor, even if awaited | No |
| Future auto-resume/scheduled work, queued or plain waiting turn | No |
| Unawaited command, such as a persistent dev server | No |
| Parent blocked solely on a thread/delegation wait | No; local children count independently |

Native subagents are counted from T3's `kind: subagent` pending summaries even
when the provider does not set `awaited`. App-owned child summaries follow the
actual child shell's activity so an input-blocked child does not hold the parent.
Other concurrently running threads still hold the inhibitor.

**Detection limits:** shell data is the source of truth, not an OS process scan.
Unreported commands, unawaited background tasks, and T3's silent idle compaction
are outside coverage. The shell does not carry every delegated task's
`remoteChild` metadata. A running remote task summarized as an anonymous native
subagent may be indistinguishable from a local one and can cause a false hold.
Remote-only parent waits and app children absent from this local environment
do not count. Complete remote/native background detection is **not** claimed.
See [protocol evidence and compatibility](docs/protocol.md).

## Sleep behavior

The backend matches Herdr Agent Awake:

```text
systemd-inhibit --no-ask-password --what=sleep --mode=block ...
```

Screen locking and display sleep remain enabled. No DMS integration or power
configuration edits are made. This sleep inhibitor **may also block ordinary
manual or lid-triggered suspend** while work runs. This is the explicitly agreed
relaxation of the original prompt's manual/lid requirement. Stop the companion
before intentionally suspending:

```sh
systemctl --user stop t3-keep-awake.service
```

The app does not acquire shutdown, lid-key, or power-key inhibitors. It does not
override critical-battery policy or force sleep/shutdown behavior. Privileged
operations or operations explicitly ignoring inhibitors can bypass a sleep lock;
this is not a guarantee that the machine can never suspend.

The child helper holds its inherited inhibitor only while its stdin lease pipe
stays open. Supervisor death closes the pipe; helper EOF releases the lock.
The service additionally uses `KillMode=control-group`. SIGTERM/SIGINT release
cleanly, and unrecoverable protocol/auth errors release immediately.

## Install (when ready)

The source runs directly; no build is needed:

```sh
npm test
node bin/t3-keep-awake.mjs help
```

Create the portable npm tarball with `npm pack`. Install either the prepared
tarball or a fresh one into your user prefix:

```sh
npm install --global --prefix "$HOME/.local" ./t3-keep-awake-0.1.0.tgz
export PATH="$HOME/.local/bin:$PATH"
t3-keep-awake help
```

Installation of this package does not start a daemon, install a unit, or acquire
an inhibitor. No npm lifecycle scripts are used. Node must remain installed at
the path captured by `service-unit`. Regenerate the unit after moving the app
or switching/removing that Node installation.

## Pairing and configuration

1. In T3 **Settings → Authorized clients**, create a pairing link with only
   **Orchestration → Read** (`orchestration:read`). Avoid a broad preset when a
   custom grant is available. Find the current local HTTP origin in T3's
   connection settings; do not assume a fixed port.
2. Put its raw credential or direct local `/pair#token=…` URL in an owned regular
   file with mode `0600`, preferably in `$XDG_RUNTIME_DIR`. Do not put it in a
   command argument, shell history, chat message, or the repository. Hosted
   pairing wrappers are intentionally not accepted.
3. Run the following with your actual origin and private input file:

```sh
t3-keep-awake pair --server http://127.0.0.1:PORT --credential-file "$XDG_RUNTIME_DIR/t3-pairing"
rm -- "$XDG_RUNTIME_DIR/t3-pairing"
t3-keep-awake diagnose
```

Pairing consumes the bootstrap through T3's supported token exchange and saves
only the resulting access token, expiry, and environment identity. It does not
start monitoring or inhibit sleep. The exchange explicitly requests only
`orchestration:read`; both returned scope and effective session permissions must
match exactly. The app supports the Bearer session T3 issues when no DPoP proof
is supplied; it rejects unexpected DPoP responses. There is no automatic refresh
or silent upgrade to broader access. Expired/revoked sessions require pairing
again and restarting the service. Revoke the old client/link in T3 when replacing
or uninstalling it.

**Grant boundary:** this is read-only orchestration access, **not status-only
access**. It can read conversations and orchestration metadata, and upstream
also authorizes some server/provider discovery operations with this permission.
On the inspected current source, filesystem access requires a separate
`filesystem:read` grant. Older T3 builds may have broader read-scope semantics;
consult their source before pairing. This companion calls only descriptor,
session, ticket, token exchange, and shell subscription endpoints. It does not
log credentials, URLs, conversation text, thread titles, or raw server errors.

Files follow XDG paths (fallbacks shown):

| File | Purpose |
| --- | --- |
| `~/.config/t3-keep-awake/config.json` | Server and reconnect policy |
| `~/.config/t3-keep-awake/credentials.json` | Private access token and expiry |
| `~/.local/state/t3-keep-awake/status.json` | Redacted process/activity diagnostics |
| `$XDG_RUNTIME_DIR/t3-keep-awake/supervisor.sock` | Single-supervisor lock |

App directories must be owned by you with mode `0700`; configuration/credential
files must be owned regular files with mode `0600`. Symlink final components
are rejected. Absolute `XDG_CONFIG_HOME` and `XDG_STATE_HOME` overrides work;
relative values fall back to the defaults. `XDG_RUNTIME_DIR` is required to run.
First pairing writes default reconnect settings; re-pairing the same server
preserves them. Edit the private config after pairing:

```json
{
  "server": "http://127.0.0.1:PORT",
  "disconnectGraceMs": 30000,
  "reconnectMinMs": 1000,
  "reconnectMaxMs": 30000
}
```

Replace `PORT` with a number. Grace accepts 0–300000 ms. Retry bounds accept
100–60000 ms minimum and 100–300000 ms maximum, with maximum ≥ minimum. Network
retries use capped exponential backoff with jitter; these continue indefinitely
at the cap, while stale inhibition ends within grace plus the 500 ms supervisor
tick. Repeated failed/partial reconnects do not extend grace. A fresh synchronized
snapshot atomically replaces state after reconnect; it does not briefly release
an existing hold while active work is being reconciled. Auth and incompatible
protocol errors stop with exit 78 and are excluded from automatic restart.

Loopback HTTP(S) origins only: `127.0.0.0/8`, `localhost`, or `::1`. No arbitrary
remote hostname, embedded credentials, URL paths, queries, or redirects. Do not
point the app at an SSH port-forward of a different machine; a loopback address
alone cannot prove the actual execution host is local.

## Activate (explicit user action)

After installation and pairing:

```sh
install -d -m 700 "$HOME/.config/systemd/user"
t3-keep-awake service-unit > "$HOME/.config/systemd/user/t3-keep-awake.service"
systemd-analyze --user verify "$HOME/.config/systemd/user/t3-keep-awake.service"
systemctl --user daemon-reload
systemctl --user enable --now t3-keep-awake.service
```

`service-unit` only prints the unit, with correctly quoted absolute paths to the
current Node executable and installed app. It installs/enables nothing itself.
For a custom `XDG_CONFIG_HOME`/`XDG_STATE_HOME`, ensure the user systemd manager
has those same environment values before activation (or add explicit Environment
entries in a service drop-in). Keep a nondefault systemd unit directory in sync
with your systemd configuration.

At activation, verify real permission and desktop behavior without starting a
paid agent turn: inspect an existing working thread if available, check the
inhibitor list, and confirm locking/display sleep still work. The read-only
`diagnose` checks policy metadata; it deliberately does not acquire a lock and
cannot prove that an actual runtime request will be granted. Do not add root
permissions merely because acquisition fails; inspect the journal/policy first.

## Diagnostics

```sh
t3-keep-awake status
t3-keep-awake diagnose
systemctl --user status t3-keep-awake.service
journalctl --user -u t3-keep-awake.service -f
systemd-inhibit --list --no-pager
```

Status validates the PID's Linux process start time; a stale file or reused PID
does not claim a live inhibitor. Logs identify connection, inhibition transitions,
and actionable failures without printing raw HTTP/WebSocket responses. Only one
supervisor can run in this user session, including observe mode.

For a read-only authenticated live stream check, with the service stopped:

```sh
t3-keep-awake run --observe
```

Observe mode simulates inhibition; its status always reports `held: false`.
Stop it with Ctrl+C before starting the service. If T3 changes environment identity
or listening port, stop the service, pair again with the new local endpoint, and
restart it. For exit 78, correct the pairing or protocol mismatch before restart;
for repeated restart failures, use `systemctl --user reset-failed` after fixing
the cause. No T3 database or Chromium cache inspection is needed.

## Uninstall

```sh
systemctl --user disable --now t3-keep-awake.service
rm -- "$HOME/.config/systemd/user/t3-keep-awake.service"
systemctl --user daemon-reload
npm uninstall --global --prefix "$HOME/.local" t3-keep-awake
```

Revoke its authorized client/pairing link in T3. If no longer needed, remove the
app's config, state, and runtime directories at the XDG locations above; the
config directory contains the token. Confirm no `t3-keep-awake` row remains in
`systemd-inhibit --list --no-pager`.

## Verification and upgrades

`npm test` uses synthetic V2 fixtures, mocked HTTP/WebSocket and OS boundaries,
plus real subprocess pipes for helper readiness, clean stop, and supervisor
SIGKILL cleanup. Tests never acquire a real inhibitor or run paid agent turns.
The generated unit is checked with `systemd-analyze --user verify`; `npm pack`
produces the installable artifact. No service is installed or enabled by tests.

Inspected source: T3 server package 0.1.7, commit
`310a0d51942ad742678e9f50783e34967de11b12`, schema 2 and Effect 4.1.2 JSON framing.
The local installed server 0.1.6 was checked through its public descriptor and
reports protocol 2. Live authenticated pairing/stream and real inhibition were
not exercised before activation. There is no stable public SDK: protocol 2 alone
does not guarantee every future schema/activity change remains compatible.
Review [docs/protocol.md](docs/protocol.md) and rerun tests/observe diagnostics
after T3 upgrades. Unknown activity/schema/RPC framing fails closed by releasing
inhibition and requiring a compatible companion update.
