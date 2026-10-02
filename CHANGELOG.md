# Changelog

本插件在作者的 desktop profile 里按 `0.1.x` 迭代，每条都在真实宿主里验证过。
英文条目见 README.md；版本号同时出现在工具输出的末尾（`— dsh-reload vX.Y.Z`），
所以「重载之后版本号变了」本身就是新代码生效的证据。

## 0.1.4 — 首个公开发布

- 打包成可分发的 DSH bundle：`dsh.bundle.patch` + `dsh plugin add` 安装路径。
- **技能随插件注册**：`ctx.skills.register()` 在 `apply()` 时把自带的
  `skills/dsh-reload/SKILL.md` 注册成运行期技能 —— 装插件即得到技能，
  不再需要往 `~/.dsh/skills/` 手动拷一份。
- `package.json` 按生态约定整理：`peerDependencies` 只声明真正 import 的官方包，
  范围带显式预发布分支（`>=0.2.0-rc.1 <0.3.0-0`），
  `dsh` 运行时版本与本机验证过的 0.2.0-rc.2 对齐。
- 新增 LICENSE（MIT）、CHANGELOG、`.gitignore`、CI 自检 workflow。
- README 拆成英文（默认，市场详情页读它）与中文两份。

## 0.1.3

- `reload_plugin({})` 的清单里加了一行**斜杠命令自检**
  （`/reload-plugin ✓ /reload-skill ✓`），实测确认两个命令真的进了命令表。

## 0.1.2

- 修掉工具对照的假报警：热重载会 dispose 本插件自己的 fiber，
  用已销毁的 ctx 读 `ctx.tools.schemas()` 只会拿到空数组，
  于是报告会荒谬地说「所有工具都消失了」。改为经 `ctx.root` 读。
- 技能根去重后按「用户根」标签展示：`$HOME` 恰好是 git 仓库时，
  `~/.dsh/skills` 不再被标成 `project-dsh`。
- 观察不完整（某个提供方 list 抛错）时也输出提供方诊断，不再只在「一个磁盘技能都没有」时输出。

## 0.1.1

- 技能根新增 `<会话工作目录>/.dsh/skills` 与 `.agents/skills`（优先级最高）。
  宿主只用「最近的 `.git` 祖先」当项目根，本机 `$HOME` 就是 git 仓库，
  于是 `~/project/<x>` 会话的项目技能根会整个漏掉。
- 插件清单默认只列第三方/本地插件行与所有未运行的行（全量 200+ 行纯烧 token），
  用 `filter` 可以看全部。
- 工具报告末尾加版本戳。

## 0.1.0

- `reload_plugin`：清目标插件自己的模块闭包 → 卸载旧 fiber → `entry.init()`
  重新 import 并 apply，失败回滚；entry 没在跑时改为激活。
- `reload_skill`：调 provider 的 `invalidate()` 强制重新发现，报告新增/移除/变更，
  并对具体技能做磁盘 + frontmatter + 提供方诊断。
- 兜底技能提供方（`fallbackRoots`）：逐根容错，宿主 provider 整体失败时磁盘技能仍可见。
- `/reload-plugin`、`/reload-skill` 两个斜杠命令。
- 实测：自体重载 0.1.0 → 0.1.1 → 0.1.2 → 0.1.3，全程未重启 DSH。
