# dsh-reload 设计说明与实测证据

> 对应 DSH 0.2.0-rc.2（app.asar mtime 2026-09-29），Node 24.18.1 / Electron 44.0.0。
> 宿主迭代很快：升级后请重新核对下面引用的内部结构。

本文记录**为什么这么实现**，以及每条结论是怎么在真实宿主里验证的。
所有「宿主源码」引用都出自
`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`（用
`dsh-recon/tools/asar-extract.mjs` 提取）。

---

## 1. 宿主里有什么

`cordis_inspect_query`（host Service/Event provider）给出的是权威清单，关键几项：

| Service / Event | 关键能力 |
| --- | --- |
| `ctx.skills` | `registerProvider(create)` / `register` / `list` / `snapshot` / `get`；`SkillProviderControl = { signal, invalidate }` |
| `ctx.loader`（cordis-plugin-loader） | `entries()` / `resolve(id)` / `create()` / `remove()` / `import(name, outer)` / `await()`，`internal` = Node 内部 ModuleLoader |
| `ctx.hmr` | `runExclusive(op)` / `watchConfig(file, refresh)` / `getLinked(url)` / `_resolve(spec, parent, attrs)`；事件 `hmr/change`、`hmr/reload` |
| `ctx.tools` | `register(definition)` / `schemas(scope)` / `get(name, scope)` |
| `skills/change` | provider、运行期技能注册或目录变化时广播 |
| `plugin-manager/changed`、`app-boot/config-reload` | 插件管理操作、profile patch 重新协调 |

profile 里 HMR 的实际配置（运行时读出来的）：

```json
{ "root": [], "ignored": ["**/node_modules","**/.*","cache","data"], "debounce": 100 }
```

`root: []` = **不 watch 任何源码文件**。profile patch 与 manifest 仍然被 watch
（`dsh-hmr` 自己注册的 config watch），所以「新增一条 patch 行」能热组装 —— 实测确认：

> 把 `dsh-reload-probe` 拷进 `node_modules/` 并往 `cordis.patch.yml` 追加一行 insert，
> 4 秒后新工具 `reload_probe_ping` 直接出现在会话里，全程没有重启。
> 后续 `dsh-reload` 自己也是这么装上的。

## 2. 为什么不能复用 `hmr.partialReload()`

`dsh-hmr/lib/index.js` 的 `partialReload()` 判断「某个 entry 要不要重载」时：

```js
async function loadDependencies(job, ignored = new Set()) {
  const dependencies = new Set();
  async function traverse(job) {
    if (ignored.has(job.url) || dependencies.has(job.url)) return;
    if (job.url.startsWith('node:') || job.url.includes('/node_modules/')) return;  // ← 这里
    dependencies.add(job.url);
    ...
```

插件包若位于 `<profile>/node_modules/<pkg>/`，`traverse` 第一步就 return，
`dependencies` 恒为空；随后 `if (!dependencies.some(dep => accepted.has(dep))) continue;`
直接跳过 —— 手动塞进 `hmr.stashed` 也不会重载。
（DSH 自己的开发流程能重载，是因为 monorepo 里插件通过软链解析到 `packages/*/lib/*.js`，
realpath 不在 `node_modules` 下。）

结论：对「用户装的插件」，只能自己实现重载。做法与 HMR 同源，见下。

## 3. reload_plugin 的算法

```
解析 entry 的模块 URL          loader.internal(v1/v2) 或 hmr._resolve()
定位包根                       从模块 URL 往上找最近的 package.json
取「本地模块闭包」             loadCache 里位于包根之下、且不含嵌套 node_modules 的 URL
备份 → 清缓存                  Map.prototype.delete(loadCache, url) + 删 require.cache[file]
卸载                           ctx.registry.delete(oldPlugin)（会 dispose 全部旧 fiber）→ await
重新加载                       entry.fiber = undefined; await entry.init()
                                （init() 内部：loader.import(name) → 重新求值 → registry.plugin(...)）
失败回滚                       还原 loadCache/require.cache 备份 → entry.init() 拉回旧模块
```

细节与坑：

- **必须用 `Map.prototype.get/delete.call(loadCache, url)`**：Node 24 的 LoadCache 是
  `Map<url, {[type]: ModuleJob}>`，自带的 `delete()` 只把类型槽置空。dsh-hmr 的注释里
  写明了这一点，这里保持一致。
- **`registry.delete(plugin)` 会 dispose 该插件的全部 fiber**，所以要在删除前先取
  `registry.get(plugin).fibers`，之后 `await` 它们，确认旧实例真正退场。
- **工具对照必须走 `ctx.root`**：热重载会把本插件自己的 fiber 连同 `ctx` 一起 dispose，
  用已销毁的 ctx 调 `ctx.tools.schemas()` 只会拿到空数组 —— 报告会荒谬地说
  「所有工具都消失了」。第一版就踩了这个坑，改成 `ctx.root.get('tools')` 后修复。
- **自体重载是可行的**：正在执行的工具调用属于 agent 的工具运行时，不属于被卸载的
  fiber，所以「重载自己」这一调用仍能正常返回结果。实测 v0.1.0 → v0.1.1 → v0.1.2 → v0.1.3 → v0.1.4
  五次自体重载，每次报告与行为都随之变化。

## 4. reload_skill 的算法

注册表缓存没有 TTL（`dsh-skill` README 原文：*"The registry has no TTL: only a provider
calling its registration-scoped invalidate() … clears completed catalogs"*）。
所以插件在 `apply()` 时注册一个技能提供方，顺手拿到 `SkillProviderControl`，
`reload_skill` 只需调 `control.invalidate()`：缓存清空 + revision 递增 +
广播 `skills/change`，会话里的技能目录随即被消费方重渲染。

「刷新前 vs 刷新后」的快照差就是「这次刷新到底发现了什么」，不需要自己维护历史状态。

诊断部分做两件事：

1. 按同样的根规则在磁盘上找这个技能文件，报出 frontmatter 的问题
   （缺失、非 kebab-case、与目录名不一致…）—— 注册表遇到坏技能只是「warning + 跳过」，
   模型侧分不清「没有这个技能」和「有但坏了」。
2. 逐个调用各 provider 的 `list()` 并捕获异常 —— 这是唯一能暴露
   「provider 整体失败」的途径（见下）。

## 5. 兜底技能提供方（以及本机踩到的宿主缺陷）

实测（探针从宿主内部遍历 `ctx.skills.layers`）：

```
global:  openviking(2)  dsh-office(3)
scoped#1 filesystem: 12 条
scoped#2 filesystem: 12 条
scoped#3 filesystem: ❌ cannot list "/Applications/…/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills":
                       Cannot mix BigInt and other types, use explicit conversions
scoped#4 filesystem: 14 条
```

- `cordis` preset 的 `skill-filesystem` 配置里，`customSkillDirs` 指向
  `@deepseek-ai/dsh-agent-preset/skills`（在 `app.asar` 内）。
- `dsh-skill-filesystem` 的实现是「按根整体列出，任一根失败则整个 provider 失败」，
  注册表于是跳过它并标记观察不完整。
- 后果：**该作用域下所有磁盘技能一起消失**，包括 `~/.dsh/skills` 与项目根。
  这就是「技能装了却看不见」的真正原因（本机 cordis preset 会话里 12 个技能只看得见 5 个）。
- 这属于宿主侧缺陷（`[✓]` 已可复现、定位到具体路径与报错），本插件不修改宿主，
  只在 `reload_skill` 诊断里如实报出，并用兜底提供方把技能补回来。

兜底提供方按同样的根规则扫描，但**逐根容错**。它注册在全局层：
注册表读取时「就近层优先」，宿主自己的 provider 正常工作时压过它，因此不会产生重复技能；
宿主 provider 失败时它就是唯一来源。

一处**有意偏离宿主规则**：项目根。宿主定义是「最近的含 `.git` 的祖先，否则 cwd」，
本机 `$HOME` 本身是 git 仓库，于是 `~/project/<x>` 会话的项目根一律变成 `$HOME`，
`<cwd>/.dsh/skills` 永远扫不到。兜底提供方额外把会话工作目录本身当一个根（优先级最高）。
可用 `includeProjectRoots: false` 关掉。

## 6. 实测记录

| # | 假设 | 做法 | 结果 |
| --- | --- | --- | --- |
| 1 | 新增 patch 行会热组装 | 拷贝探针插件 + 追加 insert 行 | ✅ 4s 后工具出现在会话里 |
| 2 | 改插件源码**不会**自动生效 | 改探针源码后等 3s 再调用 | ✅ 仍是旧返回值（`root: []` 所致） |
| 3 | 手动重载能读到新代码 | 探针自体重载（清缓存→dispose→init） | ✅ 返回值与模块加载时刻都变了 |
| 4 | dsh-reload 自体重载 | v0.1.0 → 0.1.1 → 0.1.2 → 0.1.3 → 0.1.4，五次 | ✅ 报告版本戳与行为同步变化 |
| 5 | 重载别人的插件安全 | 重载 dsh-video 后跑 `video_doctor` + `video_frame` | ✅ 全部正常 |
| 6 | 盘上技能看不见 | 放 `~/.dsh/skills/probe-skill/` 后调 `skill` | ❌ 找不到（宿主 provider 整体失败） |
| 7 | 兜底提供方补得回来 | 装 dsh-reload 后 `reload_skill` + `skill dsh-reload` | ✅ 12 个技能可见，技能能真的加载 |
| 8 | patch 行**删除**也会热协调 | 删掉三个探针的 patch 行 | ✅ Loader 树 209 → 206 行，`filter: probe` 匹配 0 行，无需重启 |

附带发现（与本插件无关，未修改）：`dsh-video` 的 `video_frame` 在不传 `sheet` 时
返回 `{ sheet: undefined }`，触发 DSH 的「value is not lossless JSON」校验失败；
传 `sheet: true` 或 `times` 则正常。一行修法：`...result.sheet !== undefined ? { sheet: result.sheet } : {}`。

## 7. 未做与风险

- **不实现插件卸载**：`ctx.loader.remove(id)` 存在，但删 patch 行时宿主的
  `reconcileProfilePatches` 已经会热移除对应 entry（实测：删掉三个探针的 patch 行后，
  运行中的 Loader 树从 209 行变成 206 行、`filter: probe` 匹配 0 行），
  属于「改配置」而非热重载，不需要工具代劳。
- **不重载共享依赖**：动 `node_modules` 里的公共模块等于把别人的插件一起换掉。
- **不碰客户端 bundle**：宿主半边刷新后，浏览器半边仍需页面刷新才能换组件；
  自动 swap 是 `dsh-client-hmr` + 构建 watcher 的职责，本插件只做提示。
- **版本脆弱性**：`ctx.loader.internal`、`loadCache` 形状、`registry.delete` 语义
  都可能在 DSH 升级后变化。所有内部调用都有 `undefined` 检查与 try/catch，
  坏了会报明确错误并回滚，不会静默改坏运行中的实例。
