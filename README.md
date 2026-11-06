# t3-keep-awake

Keep your Linux PC awake while local T3 Code agents work. Normal sleep resumes
when the work finishes. Runs as a systemd user service and starts with your user
session.

Requires **native Linux, Node.js 24+, systemd/logind, and a running local T3 Code
server using protocol 2**. WSL is unsupported. DMS is only needed for the optional
status indicator.

## Install

Run as your normal user, without sudo:

```sh
npx --yes \
  --package=https://github.com/ecruzolivera/t3-keep-awake/releases/download/v0.4.0/t3-keep-awake-0.4.0.tgz \
  t3-keep-awake install
```

The installer detects local T3, saves the app outside the npx cache, and guides
you through pairing. In **T3 Settings → Authorized clients**, create a pairing
code granting only **Orchestration → Read** (`orchestration:read`). Paste the code
when prompted; input is hidden. This adds a local authorized client, not a T3
Connect machine slot. The grant also permits conversation access, but this app
only reads activity metadata.

Confirm the final prompt to enable and start the service. The installer checks
T3 connectivity and shows the startup journal. If connection is not confirmed
within five seconds, it reports failure and leaves the service enabled to retry.
Declining leaves a fresh installation stopped or an existing service unchanged.

The CLI is installed at `~/.local/bin/t3-keep-awake`. If that directory is not in
your PATH, use the full path or add it to your PATH.

To update, use the install command from a newer [GitHub release](https://github.com/ecruzolivera/t3-keep-awake/releases).
Pairing and configuration are preserved; confirm the prompt to restart onto the
new version. Rerun installation if you move or replace your Node.js installation.

## What keeps the PC awake

The companion monitors all threads in one selected local T3 environment.

| Activity | Keeps awake |
| --- | --- |
| Running turns and observable local subagents | Yes |
| Awaited background processes, including after the parent turn finishes | Yes |
| Waiting only for input, approval, another thread, or a future schedule | No |
| PR watchers and unawaited dev servers | No |

Other local work continues to hold the inhibitor while one thread waits.
Remote work is excluded where T3 identifies it. T3 does not expose every kind of
activity: anonymous remote subagents can look local, and an awaited dev server
can look like a finite process. See [protocol and detection limits](docs/protocol.md).

Screen locking and display sleep continue normally. The sleep inhibitor **can
also block manual or lid-triggered suspend**, and may interfere with emergency
suspend if the power manager honors it. No power settings are changed. Stop the
companion before intentionally suspending:

```sh
systemctl --user stop t3-keep-awake.service
```

Resume monitoring with:

```sh
systemctl --user start t3-keep-awake.service
```

## Status and troubleshooting

```sh
t3-keep-awake status
t3-keep-awake diagnose
journalctl --user -u t3-keep-awake.service -f
systemd-inhibit --list --no-pager
```

While work runs, status should show `running: true`, `connected: true`, and
`held: true`. An idle companion normally reports `held: false`. The inhibitor
list should contain a `t3-keep-awake` entry only while the lock is held.

Temporary connection failures retry with a default 1–30 second backoff. A held
lock is released after the disconnect grace period, which defaults to 30 seconds.
If T3 changes port or pairing expires, rerun the installer. Authentication or
protocol failures require repair before restarting; they do not retry forever.
After a T3 upgrade, check connectivity and consult the [compatibility notes](docs/protocol.md).

Private configuration and credentials are stored in
`~/.config/t3-keep-awake/`, diagnostics in `~/.local/state/t3-keep-awake/`, and
installed releases in `~/.local/share/t3-keep-awake/`. These respect the
corresponding XDG directory overrides. The configuration file supports
`disconnectGraceMs`, `reconnectMinMs`, and `reconnectMaxMs`.

## DMS status indicator

With **DankMaterialShell 1.6+** running, add the badge to DankBar:

```sh
t3-keep-awake install-indicator
```

Click the badge for activity counts and sleep-protection status.

| Badge | Meaning |
| --- | --- |
| Yellow fill | Working |
| Red fill | Input needed, a failed thread, or work without sleep protection |
| Green fill | Completed work |
| Green outline | Idle |
| Gray outline | Disconnected, stopped, stale status, or observe mode |

The indicator reads the companion's local status; no additional pairing is
needed. Reinstalling preserves its bar position. The original bar settings are
backed up at `~/.config/DankMaterialShell/settings.json.before-t3-indicator`.

## Uninstall

If using the indicator, disable **T3 Code Status** in DMS Settings → Plugins and
remove its widget in DankBar settings. Its files are under
`~/.config/DankMaterialShell/plugins/t3-keep-awake/`.

Remove the companion:

```sh
systemctl --user disable --now t3-keep-awake.service
rm -- "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/t3-keep-awake.service"
systemctl --user daemon-reload
rm -- "$HOME/.local/bin/t3-keep-awake"
rm -r -- "${XDG_DATA_HOME:-$HOME/.local/share}/t3-keep-awake"
```

Revoke its authorized client in T3. Saved configuration, credentials, and
status files remain in the directories listed above; remove them if no longer
needed. Check that no `t3-keep-awake` lock remains in the inhibitor list.

## Development and releases

```sh
npm run check
npm pack
```

Tests use simulated T3 and system boundaries; they do not acquire real sleep
inhibitors or alter your service. Quickshell monitor tests run headlessly when
Quickshell is installed.

To release, update the version in `package.json` and this README, push to
`master`, then run:

```sh
gh workflow run release.yml --ref master --repo ecruzolivera/t3-keep-awake
```

A matching `vVERSION` tag also triggers the workflow. It runs checks, packages the
app, smoke-tests the packaged CLI through npx, and publishes the tarball and
`SHA256SUMS` to GitHub Releases. Existing releases are not overwritten.

See the [protocol notes](docs/protocol.md) and
[suspend-inhibition research](docs/suspend-inhibition-research.md) for technical details.
