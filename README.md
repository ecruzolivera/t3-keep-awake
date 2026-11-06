# t3-keep-awake

A Linux companion that holds one OS sleep inhibitor while observable local T3
Code work runs, then releases it when that work finishes. Runs as a systemd
user service; no T3 fork, database access, desktop plugin, root daemon, or runtime
npm dependencies. Requires native Linux, Node.js 24+, systemd/logind, and T3's
orchestration protocol **2**. WSL is not supported.

## One-command user installation

The installer is implemented and locally packaged, but this package has **not
been published to npm**. From this checkout, build and run it with:

```sh
npm pack
npx --yes --package=./t3-keep-awake-0.2.2.tgz t3-keep-awake install
```

After an authorized npm publication, the public command will be:

```sh
npx t3-keep-awake@latest install
```

The installer checks existing Node 24+, native Linux, systemd user-session tools,
logind and a private runtime directory. It uses no sudo and installs no OS
packages or private Node runtime. It automatically detects your running local T3
server, guides creation of a read-only pairing code, accepts that code through
hidden terminal input, and
reuses a valid existing companion session on later runs. A local authorized
client does not register an extra T3 Connect host machine. The orchestration read
grant permits conversation access too; this companion only consumes shell status.

Discovery inspects current-user TCP listening sockets belonging to T3/Node/Bun/
Electron processes through Linux `/proc`, then validates the public T3 descriptor
with bounded, unauthenticated HTTP probes. It reads no process arguments,
environment, credentials, databases or browser caches. A single environment is
selected automatically; multiple environments produce a numbered choice. On
reruns a reachable saved endpoint is reused, and discovery can find the paired
environment at a changed port. If no compatible server is found, start T3 and
retry. `--server` remains an override for unusual setups such as HTTPS-only
listeners or restricted `/proc` access; it is not required for normal setup.

It copies the app into immutable, content-addressed releases below
`$XDG_DATA_HOME/t3-keep-awake/releases` (default `~/.local/share`), installs a
launcher at `~/.local/bin/t3-keep-awake`, and validates/writes the systemd user unit
under `$XDG_CONFIG_HOME/systemd/user` (default `~/.config`). Node and app paths
are absolute and point outside the disposable npx package cache. The unit carries
the selected XDG paths and a stable path to the system's inhibitor command.
Configuration, credentials and custom reconnect settings are retained. A private
`install.json` in the app data directory records the installed paths.

**Starting requires a final confirmation, defaulting to No.** Declining a fresh
installation leaves the service installed and stopped. On an update, declining
leaves an already running service on its previous unit/release; the new CLI and
release are staged. Confirming an update enables/restarts onto the new release.
Old releases remain available so an active service is never deleted underneath
its running process. Failures retain files/credentials and report the recovery
action; they do not silently fall back to root or a broader grant.

After enabling or restarting, the installer automatically checks service startup
for up to five seconds, reports whether T3 is connected and the inhibitor is held,
and displays the latest 12 journal messages for that service invocation. If a
failed service has no invocation ID left, it queries messages since activation.
It reports failures and an unconfirmed T3 connection explicitly, rather than
equating an active systemd process with successful monitoring. Tokens and URLs
are redacted from journal output; malformed journal records are not echoed.

For unattended setup, supply all inputs and explicitly leave it stopped:

```sh
npx --yes --package=./t3-keep-awake-0.2.2.tgz t3-keep-awake install \
  --server http://127.0.0.1:PORT --credential-file "$XDG_RUNTIME_DIR/t3-pairing" --no-start
```

The credential file must be owned and mode `0600`; the installer leaves it for
you to remove. A noninteractive install never enables/starts a service. Existing
unmanaged launchers/units are not overwritten; move a conflicting file aside
explicitly after inspecting it. A manually running supervisor must be stopped
before installation. The installer does not edit shell startup files; if
`~/.local/bin` is absent from PATH, it prints the full installed CLI path.
Changing/removing Node requires rerunning installation to capture its new path.

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
An active foreground run waiting on a dev server can also look identical to a
finite build/test process wait. `awaited` is reporting intent, not proof that a
process is finite: a dev server incorrectly marked awaited can still hold.
The [primary-source research](docs/suspend-inhibition-research.md) explains these
information limits; no perfect dev-server exclusion is claimed.

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
change critical-battery settings or force sleep/shutdown behavior. A sleep lock
can interfere with a power manager's emergency suspend if it honors that lock;
preserving every critical-battery action is not guaranteed. Privileged
operations or operations explicitly ignoring inhibitors can bypass a sleep lock;
this is not a guarantee that the machine can never suspend.

The systemd-inhibit wrapper holds the inhibitor while its child helper runs.
Supervisor death closes the helper's stdin lease pipe; helper EOF makes it exit,
then the wrapper exits and closes its inhibitor FD.
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
npm install --global --prefix "$HOME/.local" ./t3-keep-awake-0.2.2.tgz
export PATH="$HOME/.local/bin:$PATH"
t3-keep-awake help
```

Installing the npm package alone does not start a daemon, install a unit, or
acquire an inhibitor. The explicit `install` subcommand performs guided user
setup. No npm lifecycle scripts are used. Node must remain installed at
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

## Manual activation (alternative to guided installation)

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
The guided installer handles these paths explicitly, so it is preferred over
manual unit generation when using XDG overrides.

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

For a guided installation, disable/stop first and remove the unit and launcher:

```sh
systemctl --user disable --now t3-keep-awake.service
rm -- "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/t3-keep-awake.service"
systemctl --user daemon-reload
rm -- "$HOME/.local/bin/t3-keep-awake"
rm -r -- "${XDG_DATA_HOME:-$HOME/.local/share}/t3-keep-awake"
```

The data directory contains only managed releases and the installation manifest;
review it before deletion. This retains configuration/credentials until you
revoke and remove them as described below. For the older npm-global/manual-unit
installation instead:

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
Installer tests use isolated user directories and mocked system commands; they
verify hidden input, credential/config reuse, durable copies, activation consent,
updates, conflicts and failures without changing the real user service.
The 0.2.0 local tarball was also run through offline npx with a synthetic T3
HTTP server and simulated system commands; the installed CLI remained usable
after deleting that npx cache. Its generated unit passed real systemd syntax
validation. This verifies packaging/setup, not live authentication or inhibition.
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
