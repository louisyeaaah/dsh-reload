Hot-reload DSH plugins and skills without restarting the app.

**Tools:** `reload_plugin` (re-import a loaded plugin's own modules and re-apply it, with rollback) and `reload_skill` (force skill re-discovery + diagnose why a skill is invisible).
**Commands:** `/reload-plugin`, `/reload-skill`.
**Skill:** ships embedded — installing the plugin installs the skill.

## Install

```sh
# from GitHub
dsh plugin --profile <profile> add github:louisyeaaah/dsh-reload

# or the prebuilt tarball attached below
dsh plugin --profile <profile> add "https://github.com/louisyeaaah/dsh-reload/releases/download/v0.1.4/dsh-reload-0.1.4.tgz"
```

## Verified against DSH 0.2.0-rc.2

Node 24.18.1 / Electron 44.0.0:

- five self-reloads (`0.1.0` → `0.1.4`) with the version stamp and behaviour changing each time, no DSH restart;
- a second plugin (`dsh-video`) reloaded and its own tools still work;
- a new `cordis.patch.yml` row is assembled live in ~4 s, and a deleted row disappears from the Loader tree live (209 → 206 rows).

Evidence and host internals: [`DESIGN.md`](https://github.com/louisyeaaah/dsh-reload/blob/main/DESIGN.md) §6.

MIT.
