# dsh-plugin-observatory

English | [中文](README.zh.md)

Pre-install checks for DSH plugins, plus bounded observation of the Loader lifecycle after a plugin is mounted.

This package is for DSH plugin authors, maintainers, and tooling builders who need a quick answer before activation. Does a local plugin declare the bundle, runtime dependencies, and supported host versions correctly? Which bundle rows does its patch add? What Loader transitions have occurred in the current process?

You get two read-only tools:

- `plugin_audit` inspects one local package's `package.json` and declared `dsh.bundle.patch`. It checks manifest completeness, DSH/Cordis/Node version ranges, runtime dependency declarations, install lifecycle scripts, patch rows, duplicate ids, path containment, and unevaluated `!!js` expressions.
- `plugin_observe` projects current non-group Loader entries and their bounded root-Fiber transitions observed since this plugin activated.

`plugin_audit` returns a deterministic, machine-readable report with a `compatible`, `needs-review`, or `incompatible` verdict. It reads package metadata and the declared patch without importing target JavaScript or evaluating patch expressions, so it can be used as a pre-install compatibility signal. `plugin_observe` is process-local and bounded, making recent Loader state and transitions inspectable without becoming a second source of truth.

## Quick start

Install the stable bundle into a DSH profile:

```sh
dsh plugin --profile demo add dsh-plugin-observatory@0.1.0
```

From a running profile, ask the model to audit a local plugin:

```text
Use plugin_audit on the local package at /path/to/my-plugin. Return the verdict, issues, and inserted bundle entries.
```

To try the audit against this checkout, use `package_path` set to `.` while the profile session runs from the repository root. The result is a JSON report. A representative result for this repository is:

```json
{
  "verdict": "needs-review",
  "issues": [
    {
      "severity": "warning",
      "code": "lifecycle-script",
      "path": "package.json#scripts.prepare"
    }
  ],
  "bundle": {
    "insertedEntries": [
      { "id": "observatory", "moduleName": "dsh-plugin-observatory" },
      { "id": "observatory-invariant", "moduleName": "dsh-plugin-observatory/invariant" }
    ]
  }
}
```

This `needs-review` result is expected for the source checkout because `prepare` builds TypeScript during common install flows. It is a review finding, not an assertion that the bundle is incompatible. A plugin with compatible ranges and no review findings can return `compatible`. To inspect the current runtime instead, ask the model to use `plugin_observe` and list the non-group Loader entries and their retained transitions.

If this helps you catch a plugin issue before activation, consider [starring the repository](https://github.com/CMSKL/dsh-plugin-observatory) so you can find future compatibility updates.

The package lives outside the DeepSeek Harness repository and integrates through public bundle, Cordis service, Loader event, and tool-registration interfaces. Its `dsh.bundle` patch mounts `PluginObservatoryService` at `ctx.pluginObservatory` and the package-owned invariant companion.

The report carries no timestamp, sorts findings deterministically, and does not import target JavaScript or evaluate bundle expressions. Package and patch reads are byte-bounded, require valid UTF-8, resolve symlinks, and remain under an allowlisted root. Parsed patch graphs are also bounded by nesting depth and object/array visits; cyclic YAML aliases produce an incompatible report instead of recursive exhaustion.

`PluginObservatoryService.audit(packagePath, cwd, signal?)` exposes the same static audit to trusted plugins. The service captures host package versions once when it activates: the DSH CLI package is authoritative when resolvable, otherwise one consistent version from the active DSH release family is used. An unavailable or conflicting host version produces an explicit review warning. `snapshot(entryId?)` returns a detached point-in-time lifecycle report, and `assertObservedTransition(...)` supports the invariant companion. Loader remains the current-state authority; the Observatory owns only its bounded process-local transition history.

Version `0.1.0` is the first stable release and is published under npm's `latest` dist-tag. Future release candidates remain isolated under `next`; unqualified installs resolve only to a stable release.

## Configuration

| Key | Default | Meaning |
|---|---:|---|
| `allowedRoots` | `[process.cwd()]` in a direct mount; the shipped bundle uses the working directory and DSH profile root | Package directories must resolve beneath one of these canonical roots. |
| `maxManifestBytes` | `262144` | Maximum UTF-8 bytes read from `package.json`; maximum accepted value is 32 MiB. |
| `maxPatchBytes` | `1048576` | Maximum UTF-8 bytes read from the declared bundle patch; maximum accepted value is 32 MiB. |
| `maxPatchDepth` | `64` | Maximum parsed patch object/array nesting depth; maximum accepted value is 256. |
| `maxPatchNodes` | `10000` | Maximum object/array visits, including repeated alias expansion; maximum accepted value is 100,000. |
| `maxObservedEntries` | `256` | Maximum Loader entry histories retained in memory. |
| `maxTransitionsPerEntry` | `64` | Maximum recent transitions retained for one Loader entry. |

## Installation details

Install the current stable release into a DSH profile:

```sh
dsh plugin --profile demo add dsh-plugin-observatory
```

For a reproducible install, pin the exact version:

```sh
dsh plugin --profile demo add dsh-plugin-observatory@0.1.0
```

Alternatively, download the tarball and checksum from the [v0.1.0 GitHub Release](https://github.com/CMSKL/dsh-plugin-observatory/releases/tag/v0.1.0), then verify and install it:

```sh
shasum -a 256 -c dsh-plugin-observatory-0.1.0.tgz.sha256
dsh plugin --profile demo add ./dsh-plugin-observatory-0.1.0.tgz
```

The config dump should contain the `observatory` and `observatory-invariant` rows from `cordis.patch.yml`:

```sh
dsh --profile demo --dump-config
```

The invariant companion activates even when the profile does not provide `ctx.invariants`; in that case it waits internally and registers automatically if the service appears later. A missing optional invariant registry therefore does not block the profile activation gate or the two Observatory tools.

Start the selected profile normally after checking the composed configuration. Remove the bundle with `dsh plugin --profile demo remove dsh-plugin-observatory`.

## Install from a local checkout

Build this repository and add it to a DSH profile:

```sh
pnpm install
pnpm run check
dsh plugin --profile demo add .
dsh --profile demo --dump-config
```

Installing directly from a Git checkout requires pnpm build authorization because the source package uses `prepare` to compile TypeScript. The npm package and attached GitHub Release tarball contain prebuilt `lib/` files and do not require source-build authorization.

This package is the product unit. A future CLI, CI reporter, or Web view should be a thin consumer of `ctx.pluginObservatory`, not a second compatibility engine.

## Development

```sh
pnpm install
pnpm run check
pnpm run test:coverage
pnpm run publint
pnpm run test:e2e
pnpm pack --dry-run
```

Runtime DSH and Cordis packages are peer dependencies; development uses their published versions rather than workspace links into the official Harness repository.

The required compatibility matrix runs DSH `0.1.0-rc.6` on Node `22.19.0` and Node `24`. The E2E test installs either the exact release tarball or a pinned registry version into an isolated temporary DSH profile, verifies the installed name and version, both bundle rows, both exports, and a real profile boot through the activation gate, then removes it without touching user profiles. CI also probes the latest published DSH version on a weekly and manually triggered workflow.

## Model Experience

### Plugin audit and lifecycle observation

#### What the model sees

When this bundle is mounted, the model sees the generated `plugin_audit` and `plugin_observe` schemas. A successful audit result is deterministic JSON describing compatibility findings and extracted bundle facts. An observation result contains current Loader state, capture time, and bounded transition timestamps; neither tool contributes a standalone system-prompt section.

#### Token effect

Both fixed schemas repeat on every request while visible. Results are data-dependent and append once per tool call; audit size is bounded by the manifest and patch limits, while observation size is bounded by the entry and transition limits.

#### KV Cache effect

The schema prefix stays reusable while this plugin's visibility and schema text remain unchanged. Mounting or removing the plugin changes the tool-schema prefix; each result otherwise appends after the reusable conversation prefix.

## Known Limitations and Deferred Work

- **Local source only** — the audit accepts an existing local package directory; npm registry, GitHub, archive download, signature verification, and dependency installation are not part of this package.
- **Static compatibility, not execution safety** — it does not install or import the target, run a smoke task, inspect transitive package contents, or prove that arbitrary plugin code is safe.
- **Host-version inference is explicit** — DSH version checks use the CLI package or consistent active release-family packages. If neither is available, or resolved packages conflict, the report is `needs-review` rather than silently claiming compatibility.
- **Lifecycle scripts require context** — every declared install lifecycle script is a review finding. This package therefore reports its own `prepare` build as `lifecycle-script`; the finding describes package metadata and does not claim the script has executed.
- **Process-local observation** — lifecycle history starts when the Observatory activates, is intentionally bounded, disappears at process exit, and does not yet attribute tool latency, token usage, or failures to owning plugins.
- **Evaluation is the next layer** — repeatable task suites, baseline comparison, scorecards, persisted run artifacts, CI policy, and a Web dashboard remain deferred consumers of this plugin service.
