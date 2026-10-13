# Frontend unit tests

Run all commands from the repository root with the supported Node 22.19+ (verified with Node 24). Full suite (tree, i18n, rendering/cache and sidebar logic):

```sh
node --import ./tests/register-ts.mjs --test \
  tests/*.test.ts \
  src/web/src/core/i18n.test.ts \
  src/web/src/components/pi-web-ui/sidebar-tree.test.ts
```

Only session-tree tests:

```sh
node --import ./tests/register-ts.mjs --test tests/session-tree-wire.test.ts
```

These are pure unit tests, including a minimal in-memory session slice. They do not
read real sessions, start Pi, or mock WebSockets. The loader only resolves existing
extensionless frontend TypeScript imports for Node's built-in type stripping.

The repository Biome include list does not include `tests/`. To check these files
without changing repository configuration:

```sh
config_dir=$(mktemp -d)
cat > "$config_dir/biome.json" <<'JSON'
{"formatter":{"indentStyle":"space","indentWidth":2,"lineWidth":120},"assist":{"actions":{"source":{"organizeImports":"on"}}}}
JSON
npx biome check --config-path="$config_dir" tests
rm -rf "$config_dir"
```
