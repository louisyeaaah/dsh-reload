# dsh-reload

**让 DSH 不重启就能用上新装的插件和新写的代码。**

两个工具、两个斜杠命令：

| 工具 | 一句话 |
| --- | --- |
| `reload_plugin` | 把一个已加载插件的**代码**从磁盘重新装进正在运行的进程（清模块缓存 → 卸载 → 重新 import/apply），失败自动回滚 |
| `reload_skill` | 强制技能目录**重新发现**，并诊断「技能为什么看不见」 |
| `/reload-plugin` | 同 `reload_plugin`，人直接在输入框里用 |
| `/reload-skill` | 同 `reload_skill` |

---

## 为什么需要它

DSH 自带热更新，但有三处缺口，都是实测出来的（证据见 [`DESIGN.md`](./DESIGN.md)）：

1. **插件源码不在 watch 范围**：profile 里 HMR 的配置是 `root: []`，
   源码级监听默认关闭 —— 改了 `lib/index.js` 不会自动生效。
2. **HMR 的自动重载跳过 `node_modules`**：`partialReload()` 判断依赖时对
   `/node_modules/` 直接 return，而用户装的插件恰好都在 `<profile>/node_modules/` 下。
   两者叠加的结果就是「改完插件只能 ⌘Q 重开」。
3. **技能注册表没有 TTL**：只有 provider 自己调用 `invalidate()` 才会重新发现。
   宿主自带 filesystem provider 又是「按根整体 list，一根失败全 provider 失败」——
   本机就踩到了：cordis preset 把 `customSkillDirs` 指向 `app.asar` 内部目录，
   list 抛 `Cannot mix BigInt and other types`，于是 `~/.dsh/skills` 下的技能
   连一个都看不见（12 个技能里原本只能看到 5 个 bundled 的）。

`dsh-reload` 把这三件事补上：缺口 1+2 由 `reload_plugin` 解决，
缺口 3 由 `reload_skill`（强制刷新 + 诊断）和一个**兜底技能提供方**解决。

---

## 安装

别人（或你自己在另一台机器上）三种装法，任选其一：

```sh
# 1) 直接从 GitHub 装（推荐）
dsh plugin --profile <profile> add github:louisyeaaah/dsh-reload

# 2) 用 Release 里预打包的 tarball（无需构建，链接钉在 tag 上不会失效）
dsh plugin --profile <profile> add "https://github.com/louisyeaaah/dsh-reload/releases/download/v0.1.4/dsh-reload-0.1.4.tgz"

# 3) 应用内：插件管理面板 / dsh-market 里搜 dsh-reload
```

三种方式都**不需要重启**：宿主会把新增的插件行热组装进来。
技能随插件一起注册（`apply()` 里调 `ctx.skills.register()`），不用手动往 `~/.dsh/skills/` 拷。

本仓库自己开发时用的手动装法：

```sh
scripts/install.sh [profile]     # 默认 desktop
```

做三件事：把插件包实体拷到 `<profile>/node_modules/dsh-reload`；
把 `cordis.patch.yml` 的插件行并入 profile 的 patch 层（带标记，可回滚）；
把技能装到 `$DSH_HOME/skills/dsh-reload/`。

**正常情况下不需要重启**：新增的 patch 行会被运行中的 DSH 热组装
（这一点已实测，不是推测）。装完可以直接让 agent 调 `reload_plugin({})` 验证。

卸载：

```sh
scripts/uninstall.sh [profile]
```

它会从 patch 层删掉插件行、删掉 `node_modules/dsh-reload` 与技能。
**实测：宿主会把 patch 的「删除」也热协调掉** —— 删掉三个探针插件的行之后，
运行中的 Loader 树里那三行立即消失（209 → 206 行），不用重启。
只有在这一步没生效时才需要 ⌘Q 重开。

---

## 用法

### reload_plugin

```
reload_plugin({})                                    # 列清单：包名、entry id、运行状态
reload_plugin({ name: 'dsh-video' })                 # 按包名重载
reload_plugin({ name: 'tool-video' })                # 按 entry id 重载
reload_plugin({ name: 'dsh-video', dryRun: true })   # 只预览会清理哪些模块
reload_plugin({ filter: '@deepseek-ai/' })           # 列全部插件行（默认只列第三方/本地与未运行的行）
```

真实输出（重载自己，v0.1.1 → v0.1.2；路径中段为省略）：

```
✅ 重载成功：include:tool-reload（dsh-reload）
模块：file:///Users/yezhipeng/.dsh/profiles/desktop/node_modules/dsh-reload/lib/index.js
包根：/Users/yezhipeng/.dsh/profiles/desktop/node_modules/dsh-reload
清理并重新求值的本地模块（5）：
  • …/dsh-reload/lib/index.js
  • …/dsh-reload/lib/plugin-reload.js
  • …/dsh-reload/lib/shared.js
  • …/dsh-reload/lib/skill-provider.js
  • …/dsh-reload/lib/skill-reload.js
工具清单无变化。
耗时 11ms

— dsh-reload v0.1.2          ← 版本号变化 = 新代码真的生效了
```

行为要点：

- 只清**目标插件自己**的模块（包根目录下、排除嵌套 `node_modules`）。共享依赖不动，
  不会顺手把别的插件也换掉。
- 重新跑一遍 `apply()`：工具、服务、命令、prompt 段一起更新。
- 任何一步失败都会**回滚**到旧模块，不会把插件留在半死状态。
- entry 存在但没在跑（启动失败、被关掉）时，它做的是「激活」而不是「重载」。
- 带 `dsh.client` 的插件，宿主半边热重载，浏览器半边要刷新一次页面（报告里会提示）。

### reload_skill

```
reload_skill()                        # 强制刷新：报告新增/移除/变更
reload_skill({ name: 'my-skill' })    # 刷新 + 诊断这个技能
reload_skill({ cwd: '/path/to/repo' })  # 指定按哪个目录解析项目技能根
```

真实输出（诊断一个不存在的技能）：

```
技能目录已强制重新发现（缓存已清，`skills/change` 已广播）。
技能总数：12（本次观察不完整，某个来源失败了 —— 见下方诊断）
与刷新前相比：新增 0 / 移除 0 / 变更 0
当前目录：
  • dsh-video  [user-dsh/dsh-reload] /Users/yezhipeng/.dsh/skills/dsh-video/SKILL.md
  • probe-project  [cwd-dsh/dsh-reload] /…/dsh-plugin/.dsh/skills/probe-project/SKILL.md
  …
❌ 技能 "not-a-real-skill" 不在（刷新后的）目录里。
扫描过的根里没有这个技能文件：
  • …/dsh-plugin/.dsh/skills（cwd-dsh）
  • /Users/yezhipeng/.dsh/skills（user-dsh）
  …
提供方诊断（逐个调用 list() 的结果）：
  • global/dsh-office: 3 条
  • global/dsh-reload: 7 条
  • scope#3/filesystem: ❌ cannot list "…/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills":
      Cannot mix BigInt and other types, use explicit conversions
```

那行 `❌` 就是上面缺口 3 的现场：注册表遇到 provider 抛错只会「跳过 + 标记不完整」，
模型侧完全看不到诊断 —— `reload_skill` 把它摊开给你看。

### 兜底技能提供方

`fallbackRoots: true`（默认）时插件会注册一个自己的技能提供方，按同样的规则扫同样的根，
但**逐根容错**：某个根读不了只丢那个根，其余技能照常出现。它注册在全局层，
宿主自己的 provider 正常工作时按「就近层优先」压过它，**不会出现重复技能**。

扫描顺序（优先级从高到低，同路径自动去重）：

| 来源 | 路径 |
| --- | --- |
| `cwd-dsh` | `<会话工作目录>/.dsh/skills` |
| `cwd-agents` | `<会话工作目录>/.agents/skills` |
| `project-dsh` / `project-agents` | 最近的 `.git` 祖先下的同名目录 |
| `custom` | 配置项 `customSkillDirs` |
| `user-dsh` | `$DSH_HOME/skills`（默认 `~/.dsh/skills`，跳过 `.system`） |
| `user-agents` | `$DSH_AGENTS_HOME/skills`（默认 `~/.agents/skills`） |

> 与宿主规则的一处**有意差异**：宿主只用「最近的 `.git` 祖先」当项目根。
> 本机 `$HOME` 就是 git 仓库，于是任何 `~/project/…` 会话的项目根都变成 `$HOME`，
> `<cwd>/.dsh/skills` 永远扫不到。兜底提供方额外把**会话工作目录自己**也当一个根，
> 优先级最高。不想要这个行为就配 `includeProjectRoots: false`。

默认每 2 秒轮询一次这些根，内容指纹变化就 `invalidate()` —— 新装的技能会自动出现，
不依赖手动调用。

---

## 配置

```yaml
- insert:
    - id: tool-reload
      name: 'dsh-reload'
      config:
        fallbackRoots: true      # 兜底技能提供方
        customSkillDirs: []      # 额外技能根
        watchIntervalMs: 2000    # 兜底提供方的轮询间隔，0 = 不轮询
```

---

## 验证

不需要 DSH 在跑：

```sh
scripts/verify.sh        # 语法 + patch YAML + 工具清单 + 纯逻辑单测
```

需要 DSH 的（真实验证，全部已跑通）：

1. 装完不重启 → 工具直接出现在会话里；
2. 改插件源码 → `reload_plugin` → 版本号与行为同时变化；
3. 往 `~/.dsh/skills/` 放一个新技能 → `reload_skill` → 出现在目录里，
   并且 `skill <名字>` 能真的加载；
4. `reload_plugin` 一个**别人**的插件（dsh-video）→ 重载后 `video_doctor` /
   `video_frame` 正常。

---

## 已知边界

- **本插件不做「卸载」**：把 patch 行删掉时，宿主的 patch 协调会热移除对应的 entry
  （已实测），所以不需要工具代劳；删行属于改配置，不是热重载。
- **`disabled: true` 的行不会被强行启用**：那属于改配置，不是热重载。
- **只重载目标插件自己的模块**：共享依赖（node_modules）故意不动。
- **客户端（浏览器）半边**：宿主半边热重载后，页面仍可能显示旧组件；
  带 `dsh.client` 的插件需要刷新页面，或用 `pnpm run dev:web` 的 bundle watcher 自动换。
- `reload_plugin` 触碰的是宿主内部的 `ctx.loader` / `ctx.hmr` / `ctx.skills` 结构。
  DSH 升级后若这些结构变化，插件会明确报错（并回滚），而不是静默做错事。

## 文件

| 文件 | 作用 |
| --- | --- |
| [`lib/index.js`](./lib/index.js) | 插件入口：配置、工具、斜杠命令 |
| [`lib/plugin-reload.js`](./lib/plugin-reload.js) | 插件热重载（清缓存 → 卸载 → 重新 init，带回滚） |
| [`lib/skill-reload.js`](./lib/skill-reload.js) | 技能强制刷新 + 差异 + 诊断 |
| [`lib/skill-provider.js`](./lib/skill-provider.js) | 兜底技能提供方、frontmatter 解析、轮询 |
| [`lib/shared.js`](./lib/shared.js) | 宿主结构读取、模块缓存操作、提供方诊断 |
| [`skills/dsh-reload/SKILL.md`](./skills/dsh-reload/SKILL.md) | 给 agent 用的技能（什么时候用哪个工具） |
| [`DESIGN.md`](./DESIGN.md) | 宿主内部机制、实现取舍、实测证据 |
