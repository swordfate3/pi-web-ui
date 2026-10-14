# Releasing

This is the upstream npm release guide for `@kkkiio/pi-web-ui` and the Pi package catalog. This fork is published to GitHub at `swordfate3/pi-web-ui`; its current package name is retained for compatibility, not a claim of permission to publish to the upstream npm scope. Do not run the npm publish steps for this fork without separately confirming package ownership and release metadata. See [license provenance](license-provenance.md).

## Release Policy

- Publish from a reviewed commit on the intended release branch.
- Commit prebuilt `dist/` and its manifest together with source changes on Git installation refs. See [ADR 0007](adr/0007-npm-publish-distribution-strategy.md).
- `prepare` only checks the prebuilt package, with no compiler/download. `npm publish` runs `prepack`, which builds and includes `dist/` in the tarball.
- Do not run `npm publish` until the package contents have been checked with `npm pack --dry-run --json`.
- Treat package media as part of the release. If `README.md` references local images, those files must be included in `package.json.files`. If pi.dev should show a card preview, `package.json` must provide `pi.image`.

## Prerequisites

Use Node.js 22.19 or newer (CI uses Node 24). npm publishing additionally requires an account authorized for the chosen npm package name.

```bash
node --version
npm --version
npm whoami
```

Install dependencies before running checks:

```bash
npm ci --legacy-peer-deps
```

## Git installation release checks

Run from the repository root with development dependencies installed:

```bash
npm run verify:dist
npm run build:web
npm run verify:dist
npm run test:unit
npx tsc --noEmit -p tsconfig.connection.json
PI_E2E_BIN="$PWD/node_modules/.bin/pi" node --import ./tests/register-ts.mjs --test e2e/portable-connection.integration.ts
python3 -m unittest discover -s tests -p 'test_gateway.py'
node scripts/test-git-install.mjs
```

Commit the rebuilt dist with the source changes; a source-only commit with stale assets is invalid. CI verifies correspondence before and after rebuilding. `scripts/test-git-install.mjs` makes an isolated temporary Git repository/config, runs the real Pi CLI's ordinary install and changed-commit update with production dependencies, checks package content/dependency boundaries and lock-write behavior, and tests tarball installation. It does not change personal settings or prompt any model. Test assets are local; npm registry access is still required. Installation negative cases include stale remote-access plan and embedded Python gateway source, and the tarball must include the connection modules and remote operations guide. For real Caddy integration additionally run the explicit `CADDY_TEST_BIN` command in [unit/integration testing](unit-tests.md).

For optional Chromium runtime checks against the production-only installed snapshot, keep test tool dependencies in the development repository:

```bash
PI_E2E_RUNTIME_DIR=<installed-package-path> PI_E2E_BIN="$PWD/node_modules/.bin/pi" npm run e2e
```

After publishing the reviewed commit, user commands are:

```bash
pi install git:github.com/swordfate3/pi-web-ui
pi update git:github.com/swordfate3/pi-web-ui
```

No `npm_config_include=dev` workaround is needed for new commits using this strategy. Older installed commits still use the old prepare behavior until updated. Users manually reload Pi resources and run `/webui`; maintainers do not stop/reload their sessions automatically. Installing an unpinned source follows its tracked remote branch; a pinned ref follows that ref's Pi update semantics.

## Pre-Release Checks

Start from the repository root:

```bash
pwd
git status --short
git branch --show-current
```

Confirm package metadata:

```bash
npm view @kkkiio/pi-web-ui version
npm pkg get name version description repository pi files publishConfig
```

Run the project checks:

```bash
just check
npm run build:web
```

## Package Media Checks

pi.dev uses two different image paths:

- Search result cards use `package.json` `pi.image`.
- README images are rendered through npm CDN paths, so local README image files must be present in the published tarball.

Before publishing, verify that `package.json` includes a stable `pi.image` URL if a catalog card image is expected. For this package, prefer the GitHub raw URL for the README screenshot:

```json
"pi": {
  "extensions": [
    "./extensions/mirror-server.ts"
  ],
  "image": "https://raw.githubusercontent.com/kkkiio/pi-web-ui/main/docs/images/pi-web-ui-example.png"
}
```

If `README.md` contains:

```markdown
![Pi Web UI example](docs/images/pi-web-ui-example.png)
```

then `package.json.files` must include `docs/images/`:

```json
"files": [
  "extensions/",
  "dist/",
  "public/",
  "scripts/web-dist.mjs",
  "LICENSE",
  "docs/images/",
  "README.md"
]
```

## Dry Run

Run npm's pack dry run and inspect the generated file list:

```bash
npm pack --dry-run --json
```

The output must include at least:

- `README.md`
- `package.json`
- `extensions/mirror-server.ts`
- `dist/index.html`
- `dist/assets/`
- `public/`
- `scripts/web-dist.mjs`
- `dist/build-manifest.json`
- `LICENSE`
- `docs/images/pi-web-ui-example.png` when README references that image

Check the CDN path that pi.dev will use for README images after publish. Replace `<version>` with the version being released:

```bash
curl -I -L https://cdn.jsdelivr.net/npm/@kkkiio/pi-web-ui@<version>/docs/images/pi-web-ui-example.png
```

For an unpublished version this may return 404 before publishing. After publishing it must return 200.

## Versioning

Bump the version intentionally. Use `patch`, `minor`, or `major` according to the change:

```bash
npm version patch --no-git-tag-version
```

Review the diff after the version bump:

```bash
git diff -- package.json package-lock.json
```

Commit release changes with a Conventional Commits message:

```bash
git add package.json package-lock.json docs/releasing.md AGENTS.md
git commit -m "chore: prepare release"
```

If the release contains code or documentation changes beyond version metadata, include those files in the same reviewed release commit or in earlier commits.

## Publish

Run the final checks immediately before publishing:

```bash
just check
npm pack --dry-run --json
```

Publish to npm:

```bash
npm publish --access public
```

Create and push the release tag after npm publish succeeds. Replace `<version>` with the published version:

```bash
git tag v<version>
git push origin HEAD
git push origin v<version>
```

## Post-Publish Verification

Confirm npm registry metadata:

```bash
npm view @kkkiio/pi-web-ui version dist.tarball pi files --json
```

Confirm the README image is available through jsDelivr. Replace `<version>` with the published version:

```bash
curl -I -L https://cdn.jsdelivr.net/npm/@kkkiio/pi-web-ui@<version>/docs/images/pi-web-ui-example.png
```

Confirm pi.dev preview media. This should return a non-null `media` object when `pi.image` is set:

```bash
curl -L 'https://pi.dev/api/packages/preview-media?name=%40kkkiio%2Fpi-web-ui'
```

Open the package pages and verify both the search card image and README image render:

- https://pi.dev/packages?name=web-ui
- https://pi.dev/packages/@kkkiio/pi-web-ui?name=web-ui

If pi.dev still shows stale data, wait for registry and CDN caches to refresh, then retry the verification commands.

## Failed Publish or Bad Release

If `npm publish` fails before publishing a version, fix the issue, rerun the dry run, and publish again.

If a bad version is already published:

1. Do not overwrite the published version.
2. Fix the issue in a new commit.
3. Bump to a new patch version.
4. Publish the new version.
5. If the bad version is dangerous, deprecate it with a clear message:

```bash
npm deprecate @kkkiio/pi-web-ui@<bad-version> "Use @kkkiio/pi-web-ui@<fixed-version>; this release has broken package metadata."
```
