// reload_skill 的核心：强制技能注册表重新发现 + 把「为什么看不见」诊断清楚。
//
// 技能注册表没有 TTL：只有 provider 自己调用 registration-scoped 的 invalidate()，
// 或者运行期技能注册/注销，才会清掉已完成的目录缓存并广播 `skills/change`。
// 本插件注册了一个（可选服务的）技能提供方，因此手上就有一个合法的 invalidate 句柄 ——
// 这正是「手动刷新」需要的东西。

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { providerDiagnostics, skillsOf } from './shared.js';
import { discoverSkills, parseFrontmatter, resolveSkillRoots } from './skill-provider.js';

function indexByName(list) {
  const map = new Map();
  for (const item of list) map.set(item.name, item);
  return map;
}

const FILE_SOURCES = new Set(['project-dsh', 'project-agents', 'custom', 'user-dsh', 'user-agents']);

/** 强制重新发现：拿到 provider 控制句柄就直接 invalidate。 */
export function invalidateSkills(state) {
  if (state?.control === undefined) return { ok: false, reason: '技能注册表不可用（本组合没有 ctx.skills）' };
  state.control.invalidate();
  return { ok: true };
}

/**
 * 刷新技能目录并给出差异。
 *
 * @param ctx 插件 Context
 * @param state 插件内部状态（含 provider 的 invalidate 句柄）
 * @param options `{ cwd, scope, name }`
 */
export async function refreshSkills(ctx, state, options = {}) {
  const skills = skillsOf(ctx);
  if (skills === undefined) {
    return { ok: false, error: '这个组合里没有技能注册表（ctx.skills 不存在），reload_skill 用不了' };
  }
  const lookup = { cwd: options.cwd, scope: options.scope };
  const before = await skills.snapshot(lookup);
  const invalidated = invalidateSkills(state);
  const after = await skills.snapshot(lookup);

  const beforeMap = indexByName(before.skills);
  const afterMap = indexByName(after.skills);
  const added = after.skills.filter((skill) => !beforeMap.has(skill.name));
  const removed = before.skills.filter((skill) => !afterMap.has(skill.name));
  const changed = after.skills.filter((skill) => {
    const previous = beforeMap.get(skill.name);
    return previous !== undefined
      && (previous.description !== skill.description || previous.path !== skill.path);
  });

  const hasFileSkill = after.skills.some((skill) => FILE_SOURCES.has(skill.source));
  return {
    ok: true,
    invalidated: invalidated.ok,
    invalidateReason: invalidated.reason,
    complete: after.complete,
    beforeComplete: before.complete,
    skills: after.skills,
    added,
    removed,
    changed,
    hasFileSkill,
    provider: options.provider,
  };
}

/** 在磁盘上按名字找一个技能，并顺带把 frontmatter 问题说清楚。 */
export async function diagnoseSkill(cwd, config, name) {
  const roots = resolveSkillRoots(cwd, config);
  const found = [];
  for (const root of roots) {
    const bundle = join(root.path, name, 'SKILL.md');
    const flat = join(root.path, `${name}.md`);
    const file = existsSync(bundle) ? bundle : existsSync(flat) ? flat : undefined;
    if (file === undefined) continue;
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      found.push({ root: root.path, source: root.source, file, problem: `读不了：${error.code ?? error.message}` });
      continue;
    }
    const data = parseFrontmatter(raw);
    let problem;
    if (data === undefined) problem = '没有 YAML frontmatter（文件必须以 --- 开头）';
    else if (typeof data.name !== 'string' || data.name.trim() === '') problem = 'frontmatter 缺少 name';
    else if (typeof data.description !== 'string' || data.description.trim() === '') problem = 'frontmatter 缺少 description';
    else if (data.name.trim() !== name) problem = `frontmatter 里的 name 是 "${data.name.trim()}"，与查询的 "${name}" 不一致（按 frontmatter 生效）`;
    found.push({ root: root.path, source: root.source, file, problem, declaredName: data?.name });
  }
  const discovered = await discoverSkills(roots);
  return { roots, found, available: discovered.candidates.map((item) => item.name), problems: discovered.problems };
}

/** 把刷新结果写成报告。 */
export function formatSkillReport(result, extra = {}) {
  if (result.ok !== true) return `❌ ${result.error}`;
  const lines = [];
  lines.push(result.invalidated
    ? '技能目录已强制重新发现（缓存已清，`skills/change` 已广播）。'
    : `⚠️ 没能拿到 invalidate 句柄（${result.invalidateReason}），本次只做了读取。`);
  lines.push(`技能总数：${result.skills.length}${result.complete ? '' : '（本次观察不完整，某个来源失败了 —— 见下方诊断）'}`);
  const delta = `新增 ${result.added.length} / 移除 ${result.removed.length} / 变更 ${result.changed.length}`;
  lines.push(`与刷新前相比：${delta}`);
  if (result.added.length === 0 && result.removed.length === 0 && result.changed.length === 0) {
    lines.push('（说明刷新前目录就已经是最新的 —— 新增的技能要么已经被自动发现，要么根本没被任何提供方看见）');
  }
  if (result.added.length > 0) {
    lines.push('新增：');
    for (const skill of result.added) lines.push(`  • ${skill.name}  [${skill.source}] ${skill.path ?? ''}`);
  }
  if (result.removed.length > 0) {
    lines.push('移除：');
    for (const skill of result.removed) lines.push(`  • ${skill.name}  [${skill.source}]`);
  }
  if (result.changed.length > 0) {
    lines.push('变更：');
    for (const skill of result.changed) lines.push(`  • ${skill.name}  [${skill.source}] ${skill.path ?? ''}`);
  }
  lines.push('当前目录：');
  for (const skill of result.skills) {
    lines.push(`  • ${skill.name}  [${skill.source}/${skill.provider}]${skill.path !== undefined ? ` ${skill.path}` : ''}`);
  }
  if (result.skills.length === 0) lines.push('  （空）');
  if (extra.diagnostics !== undefined && extra.diagnostics.length > 0) {
    lines.push('提供方诊断（逐个调用 list() 的结果）：');
    for (const row of extra.diagnostics) {
      const status = row.error === undefined ? `${row.count} 条` : `❌ ${row.error}`;
      lines.push(`  • ${row.layer}/${row.provider}: ${status}`);
    }
  }
  if (extra.missing !== undefined) lines.push(extra.missing);
  return lines.join('\n');
}

/** 请求了某个具体技能、但注册表里没有时，给出的磁盘侧诊断文本。 */
export function formatMissingSkill(name, diagnosis, diagnostics) {
  const lines = [`❌ 技能 "${name}" 不在（刷新后的）目录里。`];
  if (diagnosis.found.length > 0) {
    lines.push('磁盘上找到了同名技能，但没能进入目录：');
    for (const row of diagnosis.found) {
      lines.push(`  • ${row.file}`);
      lines.push(`    根：${row.root}（${row.source}）`);
      lines.push(`    问题：${row.problem ?? '没看出问题 —— 那多半是提供方整体失败了，见下'}`);
    }
  } else {
    lines.push('扫描过的根里没有这个技能文件：');
    for (const root of diagnosis.roots) lines.push(`  • ${root.path}（${root.source}）`);
  }
  if (diagnosis.problems.length > 0) {
    lines.push('扫描时跳过的问题文件：');
    for (const problem of diagnosis.problems.slice(0, 10)) lines.push(`  • ${problem}`);
  }
  if (diagnosis.available.length > 0) {
    lines.push(`磁盘上能扫到的技能（${diagnosis.available.length}）：${diagnosis.available.join(', ')}`);
  }
  if (diagnostics.length > 0) {
    lines.push('提供方诊断：');
    for (const row of diagnostics) {
      const status = row.error === undefined ? `${row.count} 条` : `❌ ${row.error}`;
      lines.push(`  • ${row.layer}/${row.provider}: ${status}`);
    }
  }
  return lines.join('\n');
}

export { providerDiagnostics };
