# dsh-reload

Reload DSH plugins and re-discover skills without restarting the app: two tools (`reload_plugin`, `reload_skill`) and two slash commands (`/reload-plugin`, `/reload-skill`), in one plugin.

| Tool / command | What it does |
| --- | --- |
| `reload_plugin` | Re-imports an already-loaded plugin's own modules from disk into the running process: clear its module cache → dispose the old fibers → `entry.init()` (re-import and re-apply). Rolls back to the old modules if any step fails. Also activates a row that exists but is not running. |
| `reload_skill` | Forces skill re-discovery (clears the registry cache and broadcasts `skills/change`), reports added / removed / changed skills, and diagnoses why one skill is not visible. |
| `/reload-plugin` | The same operation as `reload_plugin`, typed by a human in the composer. |
| `/reload-skill` | The same operation as `reload_skill`. |

## Why this exists

DSH ships hot reload, but three gaps make "edit the plugin, restart the app" the normal workflow. All three were measured against a live host; the evidence is in [`DESIGN.md`](./DESIGN.md) §6.

1. **Plugin source is not watched.** The profile's HMR config is `{"root": [], "ignored": ["**/node_modules","**/.*","cache","data"], "debounce": 100}`. `root: []` means no source file is watched, so editing `lib/index.js` changes nothing.
2. **HMR's automatic reload skips `node_modules`.** `partialReload()` decides whether an entry needs reloading from its dependency set, and `loadDependencies()` returns early for any module URL under `/node_modules/`:

   ```js
   if (job.url.startsWith('node:') || job.url.includes('/node_modules/')) return;   // dsh-hmr
   ```

   Plugins installed by users live in `<profile>/node_modules/<pkg>/`, so their dependency set stays empty and they are never reloaded. (DSH's own monorepo plugins do reload, because they resolve through symlinks to `packages/*/lib/*.js`, whose real path is not under `node_modules`.)
3. **The skill registry has no TTL.** Only a provider calling its own registration-scoped `invalidate()` clears completed catalogs; the registry never re-scans by itself. And the host's `dsh-skill-filesystem` provider lists its roots as one unit — `list()` walks the roots and a throw from any one of them fails the whole provider. On this machine the cordis preset points `skill-filesystem`'s `customSkillDirs` at `@deepseek-ai/dsh-agent-preset/skills` (inside `app.asar`), `list()` throws `Cannot mix BigInt and other types, use explicit conversions`, and every on-disk skill in that scope disappears with it: 5 of 12 skills were visible.

`dsh-reload` covers all three: gaps 1 and 2 by `reload_plugin`, gap 3 by `reload_skill` (forced refresh plus diagnosis) and a fallback filesystem skill provider.

## Requirements

- **DSH 0.2.0-rc.2.** The host internals it uses are the ones that ship in that build — cordis 4.0.4 and `@deepseek-ai/dsh-tools` / `dsh-commands` 0.2.0-rc.2, read out of `app.asar`. `package.json` declares `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-commands` as peers with an explicit prerelease branch (`>=0.2.0-rc.1 <0.3.0-0`), so the plugin manager's compatibility check accepts this runtime and refuses a future 0.3.x until the plugin is updated.
- **Node.** `engines.node` is `>=22.0.0`; developed and verified on Node 24.18.1 / Electron 44.0.0.
- **Host half only.** Browser-side plugin code is not reloaded (see Limitations).

## Install

`dsh plugin --profile <profile> <args>` forwards `<args>` to pnpm inside `$DSH_HOME/profiles/<profile>`, so every route below ends up as an ordinary dependency of the profile.

**1. From GitHub**

```sh
dsh plugin --profile <profile> add github:louisyeaaah/dsh-reload
```

**2. From the prebuilt tarball** (no build step, pinned so the link cannot rot)

```sh
dsh plugin --profile <profile> add "https://github.com/louisyeaaah/dsh-reload/releases/download/v0.1.4/dsh-reload-0.1.4.tgz"
```

Every release carries the packed tarball; the asset name is versioned and the URL is pinned to the tag, so this link keeps working after the next release.

**3. From npm** (once published)

```sh
dsh plugin --profile <profile> add dsh-reload
```

**4. In the app** — open the Plugin Manager / dsh-market panel in the DSH UI and install `dsh-reload` there. The package ships `dsh.bundle.patch` → [`cordis.patch.yml`](./cordis.patch.yml), whose `insert` row (`id: tool-reload`) registers the two tools and the two commands.

**Local / development install**

```sh
scripts/install.sh [profile]     # default profile: desktop
```

It does three things:

- copies `lib/`, `skills/`, `package.json`, `cordis.patch.yml`, `README.md`, `DESIGN.md` into `$DSH_HOME/profiles/<profile>/node_modules/dsh-reload`;
- merges the plugin's `insert` row into the profile's `cordis.patch.yml`, wrapped in `# >>> dsh-reload (managed by scripts/install.sh) >>>` / `# <<< dsh-reload <<<` markers (idempotent; a timestamped `.bak-*` copy is written first and restored if the result no longer parses);
- copies the skill to `$DSH_HOME/skills/dsh-reload/SKILL.md`.

No restart is needed: the running host hot-assembles the new patch row (measured at ~4 s). Check it with `reload_plugin({})`. To undo a local install, run `scripts/uninstall.sh [profile]`.

Either way you install it — GitHub, npm, the in-app plugin manager, or `scripts/install.sh` — the skill comes with the plugin. `apply()` reads the bundled `skills/dsh-reload/SKILL.md` and registers it through `ctx.skills.register()`, so it shows up in the session catalog without anyone copying a file. The `scripts/install.sh` copy is a fallback for sessions where the plugin is not loaded.

## Usage

```
reload_plugin({})                                     # 1. list the plugin rows: package name, entry id, running or not
reload_plugin({ name: 'dsh-video' })                  # 2. reload by package name (entry id works too: 'tool-video')
reload_plugin({ name: 'dsh-video', dryRun: true })    # 3. preview which modules would be cleared, change nothing
reload_skill({ name: 'my-skill' })                    # 4. force re-discovery and diagnose this skill
```

`reload_plugin({ filter: '@deepseek-ai/' })` lists every row instead of the default (third-party and local rows, plus every row that is not running). `reload_skill()` without a name only refreshes; `reload_skill({ cwd: '/path/to/repo' })` resolves project skill roots from another directory (an absolute path; `~` is not expanded). Humans can type `/reload-plugin dsh-video` and `/reload-skill my-skill` instead.

Real output (the plugin reloading itself, v0.1.1 → v0.1.2; only the path prefix is shortened to `<DSH_HOME>`):

```
✅ Reloaded: include:tool-reload (dsh-reload)
Module: file://<DSH_HOME>/profiles/<profile>/node_modules/dsh-reload/lib/index.js
Package root: <DSH_HOME>/profiles/<profile>/node_modules/dsh-reload
Local modules cleared and re-evaluated (5):
  • file://<DSH_HOME>/profiles/<profile>/node_modules/dsh-reload/lib/index.js
  • file://<DSH_HOME>/profiles/<profile>/node_modules/dsh-reload/lib/plugin-reload.js
  • file://<DSH_HOME>/profiles/<profile>/node_modules/dsh-reload/lib/shared.js
  • file://<DSH_HOME>/profiles/<profile>/node_modules/dsh-reload/lib/skill-provider.js
  • file://<DSH_HOME>/profiles/<profile>/node_modules/dsh-reload/lib/skill-reload.js
No change in the tool list.
Elapsed 11ms

— dsh-reload v0.1.2          ← the version stamp changed, so the new code is live
```

Behaviour:

- Only the target plugin's own modules are cleared — files under its package root, excluding nested `node_modules`. Shared dependencies stay in the cache, so no other plugin is swapped out along the way.
- `apply()` runs again, so tools, services, commands and prompt sections are all updated.
- If any step fails, the module cache is restored and the old modules are initialised again, and the report says so, instead of leaving the plugin half-loaded.
- If the row exists but has no active fiber (it never started, or its startup failed), the call activates it rather than reloading it; a `disabled: true` row is reported, not force-enabled.
- If the plugin has a `dsh.client` half, the report notes that the browser half still needs one page refresh.
- The tool-list diff is read through the root context. Reloading `dsh-reload` disposes its own `ctx`, so reading through it would report every tool as removed.

### The skill report

`reload_skill` states whether the invalidation succeeded, the total number of skills and whether that observation was complete, the added / removed / changed counts against the snapshot taken before the refresh, and the current catalog with each skill's source, provider and file path. When a provider is failing — or when the skill you asked about is not in the catalog — it also finds the skill on disk (same root rules), reports frontmatter problems (missing, not kebab-case, `name` not matching the directory), lists the roots it scanned, and calls each provider's `list()` individually to show which one throws. That last part is the only way to see a provider that fails as a whole: the registry skips such a provider and marks the observation incomplete, without telling the model.

### Fallback skill provider

With `fallbackRoots: true` (the default) the plugin registers its own skill provider. It scans the same roots by the same rules but tolerates failures per root: an unreadable root loses only that root's skills, the rest still appear. It registers at the global layer, and registry lookup prefers the nearest layer, so while the host's own provider works it wins and skills are not duplicated; when the host provider fails, the fallback is the only source.

Roots, in priority order (identical real paths are de-duplicated):

| Source | Path |
| --- | --- |
| `cwd-dsh` | `<session cwd>/.dsh/skills` |
| `cwd-agents` | `<session cwd>/.agents/skills` |
| `project-dsh` / `project-agents` | the same two directories under the nearest `.git` ancestor |
| `custom` | `customSkillDirs` |
| `user-dsh` | `$DSH_HOME/skills` (default `~/.dsh/skills`, `.system` skipped) |
| `user-agents` | `$DSH_AGENTS_HOME/skills` (default `~/.agents/skills`) |

One deliberate difference from the host rules: the host uses only the nearest `.git` ancestor as the project root. Where `$HOME` is itself a git repository, every `~/project/...` session gets `$HOME` as its project root and `<cwd>/.dsh/skills` can never be scanned. The fallback provider additionally treats the session working directory itself as a root, at the highest priority; set `includeProjectRoots: false` to turn that off.

By default the roots are fingerprinted every 2 s and `invalidate()` is called when a fingerprint changes, so a newly added skill appears without a tool call.

## Configuration

```yaml
- insert:
    - id: tool-reload
      name: 'dsh-reload'
      config:
        fallbackRoots: true       # register the fallback skill provider
        customSkillDirs: []       # extra skill roots
        watchIntervalMs: 2000     # fallback provider poll interval; 0 = no polling
        includeProjectRoots: true # scan <cwd>/.dsh/skills and the project root
```

| Key | Default | Meaning |
| --- | --- | --- |
| `fallbackRoots` | `true` | Register the fallback filesystem skill provider. With `false` a provider is still registered — the plugin needs the `invalidate()` handle that comes with the registration — but it lists nothing. |
| `customSkillDirs` | `[]` | Extra skill roots, scanned after the project roots and before the user roots. |
| `watchIntervalMs` | `2000` | Poll interval for the fallback provider's roots; `0` disables polling. Values below 250 ms are clamped to 250 ms. |
| `includeProjectRoots` | `true` | Scan `<cwd>/.dsh/skills`, `<cwd>/.agents/skills` and the equivalents under the `.git` ancestor. |

The shipped `cordis.patch.yml` sets the first three; `includeProjectRoots` defaults to `true` and only needs writing when you want it off.

## Verification

No DSH required:

```sh
scripts/verify.sh
```

Five offline steps: `node --check` on `lib/*.js` and `scripts/selftest.mjs`; a bundle-manifest check (`dsh.bundle.patch` exists, `main` exists, license/repository/`dsh-plugin` keyword are declared, and every official `@deepseek-ai/dsh-*` peer range carries an explicit prerelease branch); a structural parse of `cordis.patch.yml` (`scripts/validate-patch.py`, which checks that the file is still a single YAML document with a list root); a check that the source contains the two tool names and the two command names; and `scripts/selftest.mjs`, which exercises frontmatter parsing, skill-root resolution and de-duplication. Exit code 0 means everything passed. CI runs the same script on every push (`.github/workflows/verify.yml`).

With DSH running, these checks were carried out (recorded in [`DESIGN.md`](./DESIGN.md) §6):

| # | Check | How it was done | Result |
| --- | --- | --- | --- |
| 1 | A new patch row is assembled live | copied a probe plugin into `node_modules/` and appended an `insert` row | the tool appeared in the session after 4 s, no restart |
| 2 | Editing plugin source does not take effect by itself | edited the probe source, waited 3 s, called it | still the old return value (`root: []`) |
| 3 | A manual reload reads the new code | the probe reloaded itself | return value and module load time both changed |
| 4 | `dsh-reload` reloads itself | v0.1.0 → v0.1.1 → v0.1.2 → v0.1.3, no restart | the version stamp in the report and the behaviour changed together each time |
| 5 | Reloading another plugin is safe | reloaded `dsh-video`, then ran `video_doctor` and `video_frame` | both normal |
| 6 | A skill on disk can be invisible | dropped `~/.dsh/skills/probe-skill/` and called `skill` | not found — the host provider had failed as a whole |
| 7 | The fallback provider brings skills back | `reload_skill` + `skill dsh-reload` after installing | 12 skills visible, and the skill loads |
| 8 | Deleting a patch row is reconciled live | removed three probe rows | Loader tree 209 → 206 rows, `filter: probe` matched 0 rows, no restart |

## Limitations

- **No uninstall tool.** `reload_plugin` cannot remove a plugin; removing a patch row is a config change, not a reload. The host reconciles that change live — after deleting three probe rows the running Loader tree went from 209 to 206 rows with no restart — and `scripts/uninstall.sh` performs the removal (patch row, `node_modules/dsh-reload`, skill) for a local install.
- **`disabled: true` rows are never force-enabled.** `reload_plugin` reports the row instead and points at the profile's `cordis.patch.yml` (or the plugin manager). That is a config change.
- **Only the target plugin's own modules are reloaded.** `node_modules` dependencies are deliberately left in the cache; touching them would swap out other plugins too. A plugin that is not in the ESM `loadCache` — one that was not loaded through the Loader — cannot be reloaded, and the report says so.
- **Client (browser) halves still need a page refresh.** After the host half reloads, the browser may keep rendering the old components; with `pnpm run dev:web` running, the bundle watcher replaces them automatically.
- **Internal APIs may change between DSH versions.** The plugin touches `ctx.loader`, `ctx.hmr`, `ctx.skills` and `ctx.registry`. Every internal call is guarded with `undefined` checks and `try`/`catch`, so a breaking DSH change produces an explicit error and a rollback rather than silent misbehaviour — but the structures it reads are not public API.

## How it works

1. Resolve the entry's module URL — `ctx.hmr._resolve()` when available, otherwise `ctx.loader.internal` (`resolve` on the v1 loader, `resolveSync` on v2).
2. Walk up from that URL to the nearest `package.json`: the package root.
3. Collect the plugin's own module URLs from the loader's ESM `loadCache` — under the package root, excluding anything under a nested `node_modules`.
4. Back up and delete those entries from `loadCache` (through `Map.prototype.delete.call`, because the cache's own `delete` only blanks a type slot) and from `require.cache`.
5. `ctx.registry.delete(oldPlugin)` disposes every fiber of the plugin; the call awaits them, so the old instance is really gone.
6. `entry.fiber = undefined; await entry.init()` — re-import, re-evaluate, re-register via `registry.plugin(...)`.
7. If anything throws, restore the backup and `entry.init()` the old modules again, then report the error.
8. `reload_skill` uses the `invalidate()` handle captured when its own skill-provider registration was created, calls it, and diffs `ctx.skills.snapshot()` before and after.

Steps 5–7 run inside `ctx.hmr.runExclusive()` when HMR is present, so a manual reload cannot interleave with an automatic one.

## Files

| File | Purpose |
| --- | --- |
| [`lib/index.js`](./lib/index.js) | Plugin entry: config, both tools, both slash commands |
| [`lib/plugin-reload.js`](./lib/plugin-reload.js) | Plugin hot reload: clear cache → dispose → re-init, with rollback |
| [`lib/skill-reload.js`](./lib/skill-reload.js) | Skill refresh, before/after diff, diagnosis |
| [`lib/skill-provider.js`](./lib/skill-provider.js) | Fallback skill provider, frontmatter parser, root fingerprinting |
| [`lib/shared.js`](./lib/shared.js) | Host-internal access, module-cache operations, provider diagnostics |
| [`skills/dsh-reload/SKILL.md`](./skills/dsh-reload/SKILL.md) | The agent-facing skill (which tool to use when) |
| [`cordis.patch.yml`](./cordis.patch.yml) | The `insert` row that registers the plugin |
| [`scripts/install.sh`](./scripts/install.sh) | Local install into a profile |
| [`scripts/uninstall.sh`](./scripts/uninstall.sh) | Undo a local install |
| [`scripts/verify.sh`](./scripts/verify.sh) | Offline self-check |
| [`scripts/selftest.mjs`](./scripts/selftest.mjs) | Pure-logic tests used by `verify.sh` |
| [`DESIGN.md`](./DESIGN.md) | Host internals, design decisions, measured evidence |

[`README.zh.md`](./README.zh.md) is the Chinese version. License: MIT.
