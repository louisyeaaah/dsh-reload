// 兜底的本地技能提供方。
//
// 存在的理由（不是重复造轮子，是补一个真实缺口）：
// 宿主自带的 `dsh-skill-filesystem` 按「根目录」整体 list()，任何一个根读失败，
// 整个 provider 就被注册表跳过并标记观察不完整 —— 表现形式是「磁盘上明明有技能，
// 会话里一个都看不见」。本机就踩到了：cordis preset 的 bundledSkillDir 指向
// app.asar 内的目录，list 抛 “Cannot mix BigInt and other types”，
// 于是该作用域下的 ~/.dsh/skills 也一起消失。
//
// 这个提供方按同样的规则扫同样的根（项目根 → 自定义 → 用户根），但逐根容错：
// 某个根读不了只丢那个根，其余技能照常出现。它注册在全局层，
// 宿主自己的 provider 正常工作时按「就近层优先」压过它，不会出现重复技能。

import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const PROVIDER_NAME = 'dsh-reload';

const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/u;
const BOOLEAN_TRUE = new Set(['true', 'yes', 'on', '1']);
const BOOLEAN_FALSE = new Set(['false', 'no', 'off', '0']);

/** 最近的、含 .git 的祖先目录；没有就用 cwd 自己（和宿主 provider 的规则一致）。 */
export function nearestProjectRoot(cwd) {
  let dir = resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    if (dir === dirname(dir)) return resolve(cwd);
    if (existsSync(join(dir, '.git'))) return dir;
    dir = dirname(dir);
  }
  return resolve(cwd);
}

/** 解析要扫描的技能根（顺序即优先级，同路径去重）。 */
export function resolveSkillRoots(cwd, config = {}, env = process.env) {
  const workDir = resolve(cwd ?? process.cwd());
  const projectRoot = nearestProjectRoot(workDir);
  const roots = [];
  if (config.includeProjectRoots !== false) {
    // 会话工作目录自己也算一个根：仓库根可能离工作目录很远（本机 $HOME 就是 git 仓库，
    // 于是「最近的 .git 祖先」= $HOME），只扫仓库根会把 <cwd>/.dsh/skills 整个漏掉。
    const projectRows = workDir === projectRoot
      ? [[projectRoot, 'project-dsh', 100], [projectRoot, 'project-agents', 200]]
      : [
        [workDir, 'cwd-dsh', 90],
        [workDir, 'cwd-agents', 95],
        [projectRoot, 'project-dsh', 100],
        [projectRoot, 'project-agents', 200],
      ];
    for (const [dir, source, rank] of projectRows) {
      const sub = source.endsWith('agents') ? '.agents' : '.dsh';
      roots.push({ path: join(dir, sub, 'skills'), source, rank });
    }
  }
  for (const dir of config.customSkillDirs ?? []) {
    if (typeof dir === 'string' && dir.trim() !== '') roots.push({ path: resolve(dir), source: 'custom', rank: 300 });
  }
  const dshHome = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh');
  roots.push({ path: join(dshHome, 'skills'), source: 'user-dsh', rank: 400, skip: new Set(['.system']) });
  const agentsHome = env.DSH_AGENTS_HOME !== undefined && env.DSH_AGENTS_HOME !== ''
    ? env.DSH_AGENTS_HOME
    : join(homedir(), '.agents');
  roots.push({ path: join(agentsHome, 'skills'), source: 'user-agents', rank: 500 });

  // 同一个目录可能被两条规则命中（例如 $HOME 既是工作目录的祖先又是 DSH_HOME 的父目录），
  // 去重时保留优先级最高的那条，避免重复扫描与来源标签打架。
  const seen = new Set();
  const deduped = [];
  for (const root of [...roots].sort((a, b) => a.rank - b.rank)) {
    let key = root.path;
    try {
      key = realpathSync(root.path);
    } catch {
      // 目录还不存在：用字面路径去重
    }
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(root);
  }

  // 撞名时按「用户根」标签展示更贴近人的直觉：~/.dsh/skills 就是用户技能目录，
  // 哪怕 $HOME 恰好是项目根、它同时也被算成了 project-dsh。
  const userLabels = [
    { path: join(dshHome, 'skills'), source: 'user-dsh', rank: 400, skip: new Set(['.system']) },
    { path: join(agentsHome, 'skills'), source: 'user-agents', rank: 500 },
  ];
  for (const root of deduped) {
    const hit = userLabels.find((label) => resolve(label.path) === resolve(root.path));
    if (hit === undefined) continue;
    root.source = hit.source;
    root.rank = hit.rank;
    if (hit.skip !== undefined) root.skip = hit.skip;
  }

  return deduped.sort((a, b) => a.rank - b.rank);
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function foldLines(lines) {
  // YAML 折叠规则：同一段内的换行折成空格，空行折成一个换行（连续空行也只有一个）。
  const paragraphs = [];
  let buffer = [];
  const flush = () => {
    if (buffer.length > 0) paragraphs.push(buffer.join(' '));
    buffer = [];
  };
  for (const line of lines) {
    if (line.trim() === '') flush();
    else buffer.push(line.trim());
  }
  flush();
  return paragraphs.join('\n').trim();
}

/**
 * 解析 SKILL.md 的 YAML frontmatter。
 *
 * 只做技能实际会用到的那一小撮：标量、`|` / `>` 块标量（含 `-` chomping）、
 * 以及 `metadata:` 这类嵌套块（整块忽略）。不引入 YAML 依赖 —— 插件里多一个
 * 依赖就多一种装不上的可能。
 */
export function parseFrontmatter(raw) {
  const normalized = raw.replace(/^\uFEFF/u, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/u.exec(normalized);
  if (match === null) return undefined;
  const lines = match[1].split(/\r?\n/u);
  const data = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    index += 1;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\s/u.test(line)) continue; // 嵌套内容由上面的键处理
    const entry = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/u.exec(line);
    if (entry === null) continue;
    const key = entry[1];
    const value = entry[2];
    const block = /^([|>])([+-]?)(\d*)\s*$/u.exec(value.trim());
    if (block !== null) {
      const collected = [];
      while (index < lines.length && (lines[index].trim() === '' || /^\s/u.test(lines[index]))) {
        collected.push(lines[index]);
        index += 1;
      }
      const indent = collected
        .filter((item) => item.trim() !== '')
        .reduce((min, item) => Math.min(min, item.match(/^\s*/u)[0].length), Number.POSITIVE_INFINITY);
      const body = collected.map((item) => item.slice(Number.isFinite(indent) ? indent : 0));
      let textValue = block[1] === '>' ? foldLines(body) : body.join('\n').trim();
      if (block[2] !== '-') textValue += '\n';
      data[key] = textValue.replace(/\n+$/u, '');
      continue;
    }
    if (value.trim() === '') {
      data[key] = undefined;
      continue;
    }
    data[key] = unquote(value.trim());
  }
  return data;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase();
  if (BOOLEAN_TRUE.has(lowered)) return true;
  if (BOOLEAN_FALSE.has(lowered)) return false;
  return undefined;
}

/** 把一条 SKILL.md 读成候选（不合法就返回 undefined，并给出原因）。 */
export async function readSkillCandidate(file, root, direntName) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    return { problem: `读不了 ${file}：${error.code ?? error.message}` };
  }
  const data = parseFrontmatter(raw);
  if (data === undefined) return { problem: `${file}: 缺少 YAML frontmatter（文件必须以 --- 开头）` };
  const name = typeof data.name === 'string' ? data.name.trim() : undefined;
  const description = typeof data.description === 'string' ? data.description.trim() : undefined;
  if (name === undefined || name === '') return { problem: `${file}: frontmatter 里没有 name` };
  if (description === undefined || description === '') return { problem: `${file}: frontmatter 里没有 description` };
  if (!SKILL_NAME.test(name)) return { problem: `${file}: 技能名 "${name}" 不是合法的 kebab-case` };
  if (direntName !== undefined && direntName !== name && direntName !== `${name}.md`) {
    return {
      problem: `${file}: 目录/文件名是 "${direntName}"，但 frontmatter 里的 name 是 "${name}" —— `
        + '按 frontmatter 的 name 生效；两者不一致时容易找不到技能',
      soft: true,
    };
  }
  const modelInvocable = toBoolean(data['disable-model-invocation']) === true ? false : true;
  const userInvocable = toBoolean(data['user-invocable']) === false ? false : true;
  return {
    candidate: {
      name,
      description,
      ...data.whenToUse !== undefined ? { whenToUse: String(data.whenToUse) } : {},
      invocation: { modelInvocable, userInvocable },
      source: root.source,
      provider: PROVIDER_NAME,
      path: file,
      resourceBase: { kind: 'directory', path: dirname(file) },
      rank: root.rank,
      locator: { file, root: root.path, source: root.source, rank: root.rank },
    },
    raw,
  };
}

/** 扫一个根的直接子项：目录包 `<name>/SKILL.md`、扁平文件 `<name>.md`。 */
async function scanRoot(root) {
  let entries;
  try {
    entries = await readdir(root.path, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { candidates: [], problems: [], missing: true };
    return { candidates: [], problems: [`根目录 ${root.path} 读不了：${error.code ?? error.message}`], complete: false };
  }
  const candidates = [];
  const problems = [];
  for (const dirent of entries) {
    const direntName = dirent.name;
    if (direntName.startsWith('.') || root.skip?.has(direntName) === true) continue;
    if (dirent.isDirectory()) {
      const file = join(root.path, direntName, 'SKILL.md');
      try {
        const info = await stat(file);
        if (!info.isFile()) continue;
      } catch {
        continue;
      }
      const parsed = await readSkillCandidate(file, root, direntName);
      if (parsed.candidate !== undefined) candidates.push(parsed.candidate);
      else if (parsed.problem !== undefined) problems.push(parsed.problem);
      continue;
    }
    if (!dirent.isFile() || !direntName.endsWith('.md')) continue;
    const parsed = await readSkillCandidate(join(root.path, direntName), root, direntName);
    if (parsed.candidate !== undefined) candidates.push(parsed.candidate);
    else if (parsed.problem !== undefined) problems.push(parsed.problem);
  }
  return { candidates, problems, missing: false, complete: true };
}

/** 扫描全部根，按 rank 去重（同名的取先出现的那条）。 */
export async function discoverSkills(roots) {
  const candidates = [];
  const seen = new Set();
  const problems = [];
  let complete = true;
  for (const root of roots) {
    const result = await scanRoot(root);
    if (result.complete === false) complete = false;
    problems.push(...result.problems);
    for (const candidate of result.candidates) {
      if (seen.has(candidate.name)) continue;
      seen.add(candidate.name);
      candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  return { candidates, problems, complete };
}

/** 每个根的内容指纹，用来判断「要不要 invalidate」。 */
export async function rootsSignature(roots) {
  const parts = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root.path, { withFileTypes: true });
    } catch {
      parts.push(`${root.path}:-`);
      continue;
    }
    const rows = [];
    for (const dirent of entries) {
      if (dirent.name.startsWith('.') || root.skip?.has(dirent.name) === true) continue;
      const target = dirent.isDirectory() ? join(root.path, dirent.name, 'SKILL.md') : join(root.path, dirent.name);
      if (dirent.isFile() && !dirent.name.endsWith('.md')) continue;
      try {
        const info = await stat(target);
        rows.push(`${dirent.name}:${info.mtimeMs}:${info.size}`);
      } catch {
        rows.push(`${dirent.name}:-`);
      }
    }
    rows.sort();
    parts.push(`${root.path}:${rows.join(',')}`);
  }
  return parts.join('|');
}

/**
 * 造一个技能提供方。
 *
 * @param options `{ roots, onProblem }`；roots 每次 list 时重算（项目根取决于 cwd）
 */
export function createSkillProvider(options) {
  const { rootsFor, onProblem } = options;
  return {
    name: PROVIDER_NAME,
    async list(lookup) {
      const roots = rootsFor(lookup?.cwd);
      const discovered = await discoverSkills(roots);
      if (typeof onProblem === 'function' && discovered.problems.length > 0) onProblem(discovered.problems);
      return { candidates: discovered.candidates, complete: discovered.complete };
    },
    async get(candidate) {
      const file = candidate?.locator?.file ?? candidate?.path;
      if (typeof file !== 'string') return undefined;
      let raw;
      try {
        raw = await readFile(file, 'utf8');
      } catch {
        return undefined; // 文件被删了：让注册表下次重新发现
      }
      const front = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/u.exec(raw.replace(/^\uFEFF/u, ''));
      const content = front === null ? raw : raw.slice(front[0].length);
      return { ...candidate, content };
    },
  };
}
