---
name: dsh-reload
description: >-
  Reload DSH plugins and skills without restarting the app. Use reload_plugin after editing a
  plugin's source or installing one, and reload_skill when a newly installed skill does not show
  up — it also diagnoses why (disk file, frontmatter, or a failing skill provider).
  改完插件源码、或新装插件/技能后行为没变时用它：reload_plugin 热重载插件，reload_skill 刷新技能目录并诊断原因。
whenToUse: >-
  The user says a plugin change "didn't take effect", asks whether DSH needs a restart, says a
  newly installed skill is missing, or you just wrote or edited a DSH plugin and want the new code
  live now. / 用户说「改了没生效」「要不要重启」「新装的技能看不见」，或你自己刚改完某个 DSH 插件时。
---

# dsh-reload: swap in new code without restarting DSH

## When to use which

| Situation | Call |
| --- | --- |
| You just edited a plugin's source (`lib/`, `src/`) | `reload_plugin({ name: '<package>' })` |
| You just installed a plugin and want to confirm it is running | `reload_plugin({ name: '<package>' })`; call `reload_plugin({})` first if unsure of the name |
| An entry exists but is not running (startup error, disabled) | `reload_plugin({ name: … })` — it activates a non-disabled entry; a disabled row must be enabled in config first |
| A newly installed skill is missing from the session | `reload_skill()`, or `reload_skill({ name: 'xxx' })` for a diagnosis |
| Unsure whether a skill is current | `reload_skill()` and read the added/removed/changed list |

## Usage

```
reload_plugin({})                                   # list plugin rows: package, entry id, state
reload_plugin({ name: 'dsh-video' })                # reload by package name
reload_plugin({ name: 'tool-video' })               # reload by Loader entry id
reload_plugin({ name: 'dsh-video', dryRun: true })  # preview which modules would be re-evaluated
reload_skill()                                      # force re-discovery, report the diff
reload_skill({ name: 'my-skill' })                  # refresh + diagnose that skill
```

A human can also type `/reload-plugin dsh-video` or `/reload-skill my-skill`.

## What it actually does

**reload_plugin** removes the plugin's **own** modules (under its package root, excluding nested
`node_modules`) from the ESM `loadCache` and the CJS `require.cache`, disposes the old fiber, then
calls `entry.init()` to re-import and re-apply it. Tools, services, commands and prompt sections all
follow. Shared dependencies stay cached. **A failure rolls back to the previous modules** instead of
leaving the plugin half-dead.

**reload_skill** forces re-discovery. The skill registry has no TTL — only a provider calling its own
`invalidate()` clears the catalog — so this plugin registers a skill provider and keeps that handle.
The registry then broadcasts `skills/change` and the session catalog updates.

## Three rules

1. **Look before you reload.** If you are unsure of the package name or entry id, call
   `reload_plugin({})` and read the list; do not guess.
2. **Verify after reloading.** The report includes the tool-list diff. If it is empty and you expected
   a change, the code probably never reached its registration step — read the host log instead of
   reloading repeatedly.
3. **Client halves need a page refresh.** For a plugin that ships `dsh.client`, the host half reloads;
   the browser half still needs one page refresh. The report says so.

## Known limits

- Only the target plugin's own modules are reloaded. Shared `node_modules` code is deliberately left
  alone — touching it would swap other plugins out from under you.
- A row with `disabled: true` is never force-enabled; that is a config change, not a hot reload.
- Uninstalling is not a tool: removing the patch row is reconciled live by the host.
- The fallback skill provider (`fallbackRoots: true`) only matters when the host's own provider fails:
  it registers in the global layer, so a working host provider wins by layer precedence and no
  duplicate skills appear.

---

# dsh-reload：不重启就换上新代码

## 什么时候用哪个

| 情形 | 用什么 |
| --- | --- |
| 刚改完插件源码（`lib/`、`src/`） | `reload_plugin({ name: '<包名>' })` |
| 刚装了插件，想确认它在跑 | `reload_plugin({ name: '<包名>' })`；不确定名字就先 `reload_plugin({})` |
| entry 存在但没运行（启动报错、被关掉） | `reload_plugin({ name: … })`；`disabled` 的行得先改配置 |
| 新装的技能看不见 | `reload_skill()`；带名字 `reload_skill({ name: 'xxx' })` 会给诊断 |
| 不确定技能是不是最新的 | `reload_skill()` 看新增/移除/变更 |

## 用法

```
reload_plugin({})                                   # 列插件行：包名、entry id、运行状态
reload_plugin({ name: 'dsh-video' })                # 按包名重载
reload_plugin({ name: 'tool-video' })               # 按 entry id 重载
reload_plugin({ name: 'dsh-video', dryRun: true })  # 只预览会重新求值哪些模块
reload_skill()                                      # 强制刷新，报告差异
reload_skill({ name: 'my-skill' })                  # 刷新 + 诊断这个技能
```

人也可以直接敲 `/reload-plugin dsh-video`、`/reload-skill my-skill`。

## 它到底做了什么

**reload_plugin** 把该插件**自己的**模块（包根目录下、不含嵌套 `node_modules`）从 ESM
`loadCache` 与 CJS `require.cache` 里摘掉，卸载旧 fiber，再调 `entry.init()` 重新 import
并重新 apply —— 工具、服务、命令、prompt 段都会跟着更新；共享依赖留在缓存里不动。
**失败会自动回滚**到旧模块，不会把插件留在半死状态。

**reload_skill** 强制重新发现。技能注册表没有 TTL，只有 provider 自己调 `invalidate()`
才会清目录，所以本插件注册了一个技能提供方、手上握着那个句柄；刷新后注册表广播
`skills/change`，会话里的技能目录随之更新。

## 三条纪律

1. **先看再改**：不确定包名/entry id 就先 `reload_plugin({})` 列清单，别猜。
2. **重载后核验**：报告里带「新增/消失的工具」；没有变化而你预期有，多半是代码没走到注册那一步。
3. **客户端半边要刷新页面**：带 `dsh.client` 的插件，宿主半边热重载了，浏览器那半边仍需刷新一次。

## 已知边界

- 只重载目标插件自己的模块；共享依赖（node_modules）故意不动。
- `disabled: true` 的行不会被强行启用，那属于改配置。
- 卸载不是工具的事：删 patch 行由宿主热协调。
- 兜底技能提供方（`fallbackRoots: true`）只在宿主 provider 失败时才有存在感：它注册在全局层，
  宿主 provider 正常时按「就近层优先」压过它，不会出现重复技能。
