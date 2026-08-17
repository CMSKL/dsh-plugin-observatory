# Design: Plugin compatibility audit and lifecycle observatory

Status: implemented

English | [中文](design.zh.md)

## Problem

DSH plugins are installable Cordis compositions, but plugin authors lack one in-product check that answers whether a local package declares a loadable DSH bundle, matches the current DSH, Cordis, and Node versions, and names runtime dependencies correctly. Runtime inspection can show current Loader state, but it does not retain the transitions that explain whether one entry remained pending, became active, failed, or unloaded. Building this as a separate service would make plugin development depend on another deployment and would duplicate the Harness Loader's current-state authority.

## Decision

**The product unit is one independent, installable DSH bundle.** `dsh-plugin-observatory` ships outside the official Harness repository and uses a `dsh.bundle` patch to mount `PluginObservatoryService` and its package-owned invariant companion. The service is available at `ctx.pluginObservatory`; `plugin_audit` and `plugin_observe` are read-only consumers registered through `ctx.tools`. A future CLI, CI reporter, or Web surface consumes the same service instead of owning another compatibility implementation.

**Static audit never activates the target package.** `audit(packagePath, cwd, signal?)` reads only `package.json` and its declared bundle patch. Both files have configurable byte limits, require valid UTF-8, resolve through canonical paths, and must remain below an allowlisted root after symlink resolution. The parsed graph has configurable depth and node-visit budgets; a path-local ancestor set rejects cyclic YAML aliases while allowing ordinary alias reuse. The patch uses the Loader include package's exported DSH YAML schema so `!!js` values become inert expression records. The audit records those expressions and flags environment access or dynamic loading syntax, but it never evaluates them or imports package JavaScript.

**The report separates compatibility errors from review findings.** Report version `1` has deterministic issue order and no timestamp. Invalid manifests, missing bundle declarations, unsafe package-relative resolution, cyclic or over-budget patch graphs, undeclared runtime packages, and unsatisfied supported-version ranges produce `incompatible`. Install lifecycle scripts, missing descriptive metadata, expressions that read the environment or perform dynamic loading, and ranges that cannot be interpreted produce `needs-review` when no error exists. The service captures host versions once at activation: the CLI version is authoritative, otherwise one consistent DSH release-family version is used; unavailable or conflicting sources are explicit review findings. Extracted inserted entries, target ids, and expressions let later consumers explain the result without parsing the patch again.

**Loader remains authoritative for current state.** The service reads `ctx.loader.entries()` for each snapshot and stores only a bounded in-memory history of root-Fiber `internal/status` transitions observed after service activation. Group entries and child Fibers are excluded. Per-entry and total-entry limits are deployment configuration, and least-recently-transitioned history is evicted when the total limit is reached. The invariant companion checks that each delivered root-Fiber status event matches the latest retained transition.

## Alternatives considered

**Build a standalone plugin marketplace or evaluation server first.** Rejected because the first useful capabilities are local analysis and Loader observation, both of which already belong inside the running Harness. A separate deployment adds authentication, storage, and synchronization work before it improves plugin correctness.

**Reuse only the existing Host plugin inventory.** Rejected because that Remote intentionally provides point-in-time UI inventory without history, package-source access, compatibility findings, or model-facing tools. Expanding it would mix a narrow client projection with plugin-author diagnostics.

**Install and execute the target during compatibility audit.** Rejected because package installation and arbitrary plugin activation add side effects and authority that a pre-install static check does not need. Execution smoke tests remain a later, explicitly sandboxed evaluation stage.

**Persist observations and evaluation runs in this first package.** Rejected because lifecycle transitions are currently diagnostic process state, while reproducible task suites and scorecards need a separate run-artifact design. Adding persistence now would choose identifiers and formats before the execution stage exists.

## Consequences

Plugin authors can install one native DSH bundle and ask the running agent to audit a local plugin or inspect recent Loader transitions. Compatibility output is reproducible for the same files and host versions, while runtime observations are intentionally timestamped and process-local. The service API provides a stable reuse point for the next phase: isolated install and smoke execution, repeatable task suites, baseline comparison, CI policy, and a Web scorecard can be added as consumers without moving the audit engine outside DSH. Registry and GitHub discovery, transitive code trust, sandboxed execution, durable run artifacts, and per-plugin tool latency or token attribution remain explicitly deferred.
