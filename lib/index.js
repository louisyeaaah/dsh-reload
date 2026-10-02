// dsh-reload 插件入口。
//
// 两个工具、两个斜杠命令：
//   reload_plugin  热重载一个已加载插件的代码（清模块缓存 → 卸载 → 重新 import/apply）
//   reload_skill   强制技能目录重新发现，并诊断「技能为什么看不见」
//   /reload-plugin 同 reload_plugin，人直接在输入框里用
//   /reload-skill  同 reload_skill
//
// 为什么要它：DSH 的 HMR 默认 `root: []`（不 watch 插件源码），而 `partialReload()`
// 又会跳过所有位于 node_modules 下的模块 —— 用户装的插件恰好都在那儿。
// 结果是「改了插件代码必须 ⌘Q 重开」。这个插件把那条路补上，并且顺带把手动刷新
// 技能目录、以及技能提供方报错这两件事变成一次工具调用能看清楚的报告。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CommandDefinitionId } from '@deepseek-ai/dsh-commands';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { formatInventory, formatReloadReport, reloadEntry } from './plugin-reload.js';
import { diagnoseSkill, formatMissingSkill, formatSkillReport, refreshSkills } from './skill-reload.js';
import { PROVIDER_NAME, createSkillProvider, parseFrontmatter, resolveSkillRoots, rootsSignature } from './skill-provider.js';
import { listPluginEntries, loaderOf, matchEntries, output, providerDiagnostics, skillsOf, VERSION } from './shared.js';

/** 插件包根目录（lib/ 的上一级）。 */
const BUNDLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const name = 'dsh-reload';

/** 只硬依赖工具注册表；loader / skills / hmr / commands 都是可选服务。 */
export const inject = ['tools'];

export const Config = z.object({
  /** 注册一个兜底的本地技能提供方（宿主提供方整体失败时，磁盘技能仍可见）。 */
  fallbackRoots: z.boolean().default(true),
  /** 额外扫描的技能根目录（排在项目根之后、用户根之前）。 */
  customSkillDirs: z.array(String).default([]),
  /** 兜底提供方轮询技能根的间隔（毫秒）；0 = 不轮询。 */
  watchIntervalMs: z.number().default(2000),
  /** 是否扫描项目根（<cwd>/.dsh/skills、<cwd>/.agents/skills）。 */
  includeProjectRoots: z.boolean().default(true),
});

function resolveCwd(value, exec) {
  const raw = typeof value === 'string' && value.trim() !== '' ? value : undefined;
  if (raw !== undefined) return raw;
  return exec?.agent?.session?.header?.cwd ?? process.cwd();
}

/** 给报告盖个版本戳：重载之后版本号变化，本身就是「新代码真的生效了」的证据。 */
function stamp(report) {
  return `${report}\n\n— dsh-reload v${VERSION}`;
}

/** 斜杠命令自检：确认 /reload-plugin、/reload-skill 真的在命令表里。 */
function commandStatus(ctx, scope) {
  const root = ctx.root ?? ctx;
  const commands = root.get?.('commands') ?? ctx.get?.('commands');
  if (commands === undefined) return '斜杠命令：这个组合里没有 commands 服务，只有工具可用。';
  try {
    const names = (commands.list(scope) ?? []).map((item) => item.name);
    const mark = (name) => (names.includes(name) ? '✓' : '✗');
    return `斜杠命令：/reload-plugin ${mark('reload-plugin')}   /reload-skill ${mark('reload-skill')}`;
  } catch (error) {
    return `斜杠命令：查不了（${String(error?.message ?? error)}）`;
  }
}

/** 把 loader 里现有插件行做成一份清单文本。 */
function inventoryReport(loader, filter, ctx, scope) {
  const rows = listPluginEntries(loader);
  const needle = typeof filter === 'string' ? filter.trim().toLowerCase() : '';
  const isThirdParty = (row) => !row.name.startsWith('@deepseek-ai/');
  const selected = needle === ''
    // 全量清单 200 多行，模型看它纯烧 token：默认只给「第三方/本地插件 + 所有没在跑的行」
    ? rows.filter((row) => isThirdParty(row) || row.active === false || row.disabled)
    : rows.filter((row) => `${row.id} ${row.name}`.toLowerCase().includes(needle));
  return [
    `插件行：${rows.filter((row) => row.active).length} 个运行中 / 共 ${rows.length} 行。`,
    needle === ''
      ? '（默认只列第三方与本地插件行、以及所有未运行的行；要看全部就传 filter: "@deepseek-ai/"）'
      : `匹配 "${filter}"：${selected.length} 行`,
    '',
    formatInventory(selected),
    '',
    commandStatus(ctx, scope),
    '',
    '用法：reload_plugin({ name: "<包名或 entry id>" }) 重载；加 dryRun: true 只预览会清理哪些模块。',
  ].join('\n');
}

/** reload_plugin 的实现（工具与斜杠命令共用）。 */
async function doReloadPlugin(ctx, query, exec, options = {}) {
  const loader = loaderOf(ctx);
  if (loader === undefined) return { ok: false, report: '这个组合里没有 loader 服务，无法重载插件。' };
  const rows = listPluginEntries(loader);
  if (typeof query !== 'string' || query.trim() === '') {
    return { ok: true, report: stamp(inventoryReport(loader, options.filter, ctx, exec?.agent)) };
  }
  const matches = matchEntries(rows, query);
  if (matches.length === 0) {
    return { ok: false, report: stamp(`没找到匹配 "${query}" 的插件行。\n\n${inventoryReport(loader, options.filter, ctx, exec?.agent)}`) };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      report: `"${query}" 匹配到 ${matches.length} 行，请用更精确的 id：\n`
        + matches.map((row) => `  • ${row.id}  ${row.name}`).join('\n'),
    };
  }
  const report = await reloadEntry(ctx, matches[0].entry, { scope: exec?.agent, dryRun: options.dryRun === true });
  return { ok: report.ok, report: stamp(formatReloadReport(report)) };
}

/**
 * 把插件自带的技能注册成运行期技能。
 *
 * 这样「装插件」就同时得到了插件和技能 —— 别人 `dsh plugin add dsh-reload` 之后
 * 不需要再往 `~/.dsh/skills/` 手动拷一份。技能内容读包内的 SKILL.md，
 * 改文件后 `reload_plugin({ name: 'dsh-reload' })` 即可刷新。
 */
function registerEmbeddedSkill(ctx, skills) {
  const file = join(BUNDLE_DIR, 'skills', name, 'SKILL.md');
  if (!existsSync(file)) return;
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const data = parseFrontmatter(raw) ?? {};
  const skillName = typeof data.name === 'string' && data.name.trim() !== '' ? data.name.trim() : name;
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (description === '') return;
  const front = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/u.exec(raw.replace(/^\uFEFF/u, ''));
  const content = (front === null ? raw : raw.slice(front[0].length)).trim();
  ctx.effect(() => {
    try {
      return skills.register({
        name: skillName,
        description,
        content,
        source: 'runtime',
        ...(typeof data.whenToUse === 'string' && data.whenToUse.trim() !== '' ? { whenToUse: data.whenToUse.trim() } : {}),
        invocation: {
          modelInvocable: data['disable-model-invocation'] !== 'true',
          userInvocable: data['user-invocable'] !== 'false',
        },
        resourceBase: { kind: 'directory', path: dirname(file) },
      });
    } catch (error) {
      // 技能注册失败不能连累插件本体：report 里照样有工具可用
      ctx.logger?.warn?.('dsh-reload: 自带技能注册失败：%s', String(error?.message ?? error));
      return () => {};
    }
  }, 'dsh-reload embedded skill');
}

export function apply(ctx, config) {
  const settings = {
    fallbackRoots: config.fallbackRoots !== false,
    customSkillDirs: Array.isArray(config.customSkillDirs) ? config.customSkillDirs : [],
    watchIntervalMs: Number.isFinite(config.watchIntervalMs) ? config.watchIntervalMs : 2000,
    includeProjectRoots: config.includeProjectRoots !== false,
  };

  // 见过的会话工作目录（最多记 8 个），轮询时只看这些目录下的项目根 + 用户根。
  const seenCwds = new Set();
  const state = { control: undefined, problems: [] };

  const rootsFor = (cwd) => {
    const key = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
    if (seenCwds.size < 8) seenCwds.add(key);
    return resolveSkillRoots(key, settings);
  };

  const provider = createSkillProvider({
    rootsFor,
    onProblem: (problems) => {
      state.problems = problems;
    },
  });

  const skills = skillsOf(ctx);
  if (skills !== undefined) {
    // 自带的技能随插件一起注册（装插件即得到技能）
    registerEmbeddedSkill(ctx, skills);

    // 注册提供方有两个目的：兜底提供技能来源；拿一个合法的 invalidate() 句柄用于手动刷新。
    ctx.effect(() => skills.registerProvider((control) => {
      state.control = control;
      if (!settings.fallbackRoots) {
        return {
          name: PROVIDER_NAME,
          async list() {
            return { candidates: [], complete: true };
          },
          async get() {
            return undefined;
          },
        };
      }
      return provider;
    }), 'dsh-reload skill provider');

    if (settings.fallbackRoots && settings.watchIntervalMs > 0) {
      ctx.effect(() => {
        let signature;
        let running = false;
        const tick = async () => {
          if (running) return;
          running = true;
          try {
            const roots = [...seenCwds].flatMap((cwd) => rootsFor(cwd));
            const next = await rootsSignature(roots);
            if (signature !== undefined && next !== signature) state.control?.invalidate();
            signature = next;
          } catch {
            // 轮询失败不致命：手动 reload_skill 仍然是可靠的兜底
          } finally {
            running = false;
          }
        };
        void tick();
        const timer = setInterval(() => {
          void tick();
        }, Math.max(250, settings.watchIntervalMs));
        timer.unref?.();
        return () => clearInterval(timer);
      }, 'dsh-reload skill watcher');
    }
  }

  // ── reload_plugin ──────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'reload_plugin',
    description: '不重启 DSH 就把插件的新代码装进正在运行的进程：清掉这个插件自己的模块缓存 → '
      + '卸载旧实例 → 重新 import 并重新注册，工具/服务/命令随之更新；失败会自动回滚到旧模块。'
      + '也用来把「装了但没运行」的插件行激活。刚改完插件源码、或新装插件后行为没变时用它。'
      + '不传 name 时列出所有插件行（包名、entry id、运行状态、是否 disabled）。',
    parameters: {
      name: {
        type: 'string',
        description: '插件包名（如 dsh-video）、Loader entry id（如 tool-video），或它们的子串。省略则只列清单。',
      },
      filter: {
        type: 'string',
        description: '列清单时的过滤子串（匹配 entry id 或包名）。省略时只列第三方/本地插件与所有未运行的行。',
      },
      dryRun: {
        type: 'boolean',
        description: '只报告会清理哪些模块，不真的重载。默认 false。',
      },
    },
    timeoutMs: 60000,
    output: output((value) => value.report, {
      report: { type: 'string', required: true },
      ok: { type: 'boolean', required: true },
    }),
    async execute(args, exec) {
      return doReloadPlugin(ctx, args.name, exec, { dryRun: args.dryRun === true, filter: args.filter });
    },
  }));

  // ── reload_skill ───────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'reload_skill',
    description: '强制技能目录重新发现（清缓存 + 广播 skills/change），并报告新增/移除/变更的技能。'
      + '新装了技能（~/.dsh/skills/<name>/SKILL.md、项目 .dsh/skills/…）但会话里看不见时用它。'
      + '带 name 时会做诊断：磁盘上有没有这个文件、frontmatter 有没有问题、哪个技能提供方在报错。',
    parameters: {
      name: { type: 'string', description: '可选：要确认能加载的技能名（kebab-case）。给了它就会做磁盘与提供方诊断。' },
      cwd: { type: 'string', description: '可选：按哪个目录解析项目技能根，默认取会话工作目录。' },
    },
    timeoutMs: 60000,
    output: output((value) => value.report, {
      report: { type: 'string', required: true },
      ok: { type: 'boolean', required: true },
    }),
    async execute(args, exec) {
      const cwd = resolveCwd(args.cwd, exec);
      const result = await refreshSkills(ctx, state, { cwd, scope: exec.agent });
      if (result.ok !== true) return { ok: false, report: `❌ ${result.error}` };
      const extra = {};
      const wanted = typeof args.name === 'string' ? args.name.trim() : '';
      if (wanted !== '') {
        if (result.skills.some((skill) => skill.name === wanted)) {
          extra.missing = `✅ 技能 "${wanted}" 在目录里。`;
        } else {
          const diagnosis = await diagnoseSkill(cwd, settings, wanted);
          const diagnostics = await providerDiagnostics(ctx, cwd);
          extra.missing = formatMissingSkill(wanted, diagnosis, diagnostics);
        }
      } else if (!result.hasFileSkill || result.complete === false) {
        // 一条「磁盘来源」的技能都没有、或本次观察不完整 —— 多半是某个提供方整体失败，直接给诊断
        extra.diagnostics = await providerDiagnostics(ctx, cwd);
      }
      return { ok: true, report: stamp(formatSkillReport(result, extra)) };
    },
  }));

  // ── 斜杠命令：人也可以直接用 ───────────────────────────────────────────
  ctx.inject(['commands'], (scoped) => {
    scoped.commands.register({
      definitionId: CommandDefinitionId('dsh-reload-plugin'),
      name: 'reload-plugin',
      description: '热重载一个 DSH 插件（不重启应用）',
      input: { hint: '[插件包名或 entry id]' },
      handler: async (invocation) => {
        const query = (invocation.rawInput ?? '').trim();
        const result = await doReloadPlugin(scoped, query, invocation);
        return { kind: 'success', text: stamp(result.report) };
      },
    });

    scoped.commands.register({
      definitionId: CommandDefinitionId('dsh-reload-skill'),
      name: 'reload-skill',
      description: '强制刷新技能目录（新装的技能立刻可见）',
      input: { hint: '[技能名]' },
      handler: async (invocation) => {
        const cwd = invocation.agent?.session?.header?.cwd ?? process.cwd();
        const result = await refreshSkills(scoped, state, { cwd, scope: invocation.agent });
        if (result.ok !== true) return { kind: 'success', text: stamp(`❌ ${result.error}`) };
        const wanted = (invocation.rawInput ?? '').trim();
        const extra = {};
        if (wanted !== '' && !result.skills.some((skill) => skill.name === wanted)) {
          const diagnosis = await diagnoseSkill(cwd, settings, wanted);
          const diagnostics = await providerDiagnostics(scoped, cwd);
          extra.missing = formatMissingSkill(wanted, diagnosis, diagnostics);
        }
        return { kind: 'success', text: stamp(formatSkillReport(result, extra)) };
      },
    });
  });
}
