# Independent native terminal archive (2026-10-22)

The complete independent native terminal implementation, tests and deployment
evidence are retained on branch `codex/archive-native-terminal-20261022`.
That branch is historical/experimental, not the recommended daily installation.

Main removes its third-origin listener, pairing commands, private provider,
PTY runtime, independent browser bundle and browser-chat takeover policy.
Ordinary Web chat, `/model`, extension dialogs, Hub session routing, lifecycle
and runtime updates, bounded history/state, transfer compression and math
rendering remain. Informational notices for Pi terminal-only prompts also remain;
they do not open a separate terminal or grant browser approval authority.

This is a source rollback, not a production rollback. It does not stop running
Pi sessions, change passwords, alter Caddy/DNS/tunnels or deploy a new Hub image.
The installed Web extension and running Hub keep their loaded code until
explicitly updated/restarted.

An installation previously enabling the terminal profile must coordinate its
rollback: disable terminal-only launcher/configuration and Gate requirements,
then validate/deploy an ordinary Hub build. Do not automatically deploy this
main revision while Gate still requires terminal runtime assets. Do not remove
state volumes or forcibly restart busy Pi processes.
