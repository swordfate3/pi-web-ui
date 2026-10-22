# Archive the independent native terminal

## Scope

Archive the complete native terminal implementation and deployment evidence on
`codex/archive-native-terminal-20261022`. On main, remove the independent terminal
listener, provider, runtime, browser bundle and chat takeover. Preserve ordinary
Web UI dialogs, Hub lifecycle/runtime management, bounded history/state and
compression improvements. Preserve independent math rendering, informational
terminal-prompt notices and Git installation safety changes where separable.

Use a new, traceable rollback commit; do not rewrite published history. Preserve
the unrelated untracked host review. Do not modify or restart live containers,
Gate policy, private Hub configuration, tunnels, credentials or remote Caddy.

## Steps

1. Compare main with the pre-terminal checkpoint `fa25b7a` and identify mixed
   changes. Archive owned deployment evidence and push the archive branch.
2. Add a behavioral regression for ordinary browser commands before an input
   policy arrives; observe it fail with the native takeover restriction present.
3. Reverse terminal-only changes and remove terminal-only sources/tests/docs.
   Retain independently useful changes and rebuild tracked browser/Hub assets.
4. Run unit tests, static checks, build/manifest checks, ordinary real-Pi E2E
   and desktop/mobile visual validation. Review the rollback independently.
5. Publish the main rollback without force. Report source publication separately
   from installation and production deployment, which remain unchanged.

## Deployment warning

The currently deployed host may still enable terminal listeners and require
terminal assets in Gate validation. A later production rollback must coordinate
the private configuration and Gate policy; do not submit this main revision for
automatic production deployment with that old terminal-only contract.
