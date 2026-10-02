// 共享工具：DSH 宿主内部结构的读取与改写。
//
// 这里刻意只依赖「运行中的宿主对象」（ctx.loader / ctx.hmr / ctx.skills / ctx.tools），
// 不 import 任何 DSH 内部包 —— 宿主换版本时，坏掉的只会是某几个函数，而不是整个插件加载失败。

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 插件版本，会打在工具报告末尾 —— 热重载后版本号变化本身就是「新代码生效了」的证据。 */
export const VERSION = '0.1.4';

/** 给 CJS 缓存清理用（Node 24 里通过 import() 载入的 CJS 会同时出现在两份缓存里）。 */
export const nodeRequire = createRequire(import.meta.url);

/** 工具的文本输出。 */
export function text(value) {
  return [{ type: 'text', text: value }];
}

/** defineTool 的 output 段：一份 JSON schema + 一个渲染函数。 */
export function output(render, properties) {
  return {
    schema: { type: 'object', additionalProperties: false, properties },
    render: (_args, value) => text(render(value)),
  };
}

/** 可选服务一律走 ctx.get()：组合里没有它就返回 undefined，而不是抛错。 */
export function loaderOf(ctx) {
  return ctx.get?.('loader');
}

export function skillsOf(ctx) {
  return ctx.get?.('skills');
}

export function entryIdOf(entry) {
  try {
    return entry.id;
  } catch {
    return entry.options?.id ?? '?';
  }
}

/** 是否是「真正的插件行」（而不是 cordis:group / cordis:include 这类结构节点）。 */
export function isPluginEntry(entry) {
  const name = entry.options?.name;
  return typeof name === 'string' && name !== '' && !name.startsWith('cordis:');
}

/** Loader 树里所有插件行。 */
export function listPluginEntries(loader) {
  const rows = [];
  if (loader === undefined) return rows;
  for (const entry of loader.entries()) {
    if (!isPluginEntry(entry)) continue;
    rows.push({
      entry,
      id: entryIdOf(entry),
      name: entry.options.name,
      active: Boolean(entry.fiber?.uid),
      disabled: Boolean(entry.disabled),
    });
  }
  return rows;
}

/** 把用户给的查询词匹配到 entry：id 全等 → 包名全等 → id 尾段全等 → 子串。 */
export function matchEntries(rows, query) {
  const needle = String(query ?? '').trim();
  if (needle === '') return [];
  const stages = [
    (row) => row.id === needle,
    (row) => row.name === needle,
    (row) => row.id.split(':').pop() === needle,
    (row) => row.id.includes(needle) || row.name.includes(needle),
  ];
  for (const stage of stages) {
    const hit = rows.filter(stage);
    if (hit.length > 0) return hit;
  }
  return [];
}

/**
 * 解析一个 entry 实际加载的模块 URL。
 *
 * 优先借 HMR 的 `_resolve`（它同时兼容 Node 22/23 的 v1 loader 与 Node 24 的 v2 loader），
 * 拿不到再退回 `ctx.loader.internal` 自己解析。
 */
export async function resolveEntryUrl(ctx, entry) {
  const spec = entry.options?.name;
  if (typeof spec !== 'string' || spec === '' || spec.startsWith('cordis:')) return undefined;
  const baseUrl = entry.parent?.tree?.ctx?.baseUrl;
  const hmr = ctx.get?.('hmr');
  if (typeof hmr?._resolve === 'function') {
    try {
      const resolved = await hmr._resolve(spec, baseUrl, {});
      if (resolved?.url !== undefined) return resolved.url;
    } catch {
      // 落到下面的 loader 解析
    }
  }
  const internal = loaderOf(ctx)?.internal;
  try {
    if (internal?.version === 'v2') return internal.resolveSync(baseUrl, { specifier: spec, attributes: {} }).url;
    if (internal?.version === 'v1') return (await internal.resolve(spec, baseUrl, {})).url;
  } catch {
    // 交给调用方报「解析不到」
  }
  return undefined;
}

/** 从某个模块 URL 往上找最近的 package.json —— 也就是插件包根目录。 */
export function packageRootOf(url) {
  let dir = dirname(fileURLToPath(url));
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(fileURLToPath(url));
}

/** 读插件包 manifest（找不到就是 undefined）。 */
export function readPackageManifest(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * 一个插件包「自己的」模块 URL：位于包根目录之下、且不在嵌套 node_modules 里。
 *
 * 这些才是应该随插件一起重新求值的文件（lib/*.js、src/*.js…）；
 * 依赖树（node_modules）留在缓存里不动，那本来就是共享代码。
 */
export function localModuleUrls(cache, root) {
  const prefix = `${pathToFileURL(root).href}/`;
  const urls = [];
  if (cache === undefined) return urls;
  Map.prototype.forEach.call(cache, (_value, key) => {
    if (typeof key !== 'string' || !key.startsWith(prefix)) return;
    const rest = key.slice(prefix.length);
    if (rest.includes('node_modules/')) return;
    urls.push(key);
  });
  return urls.sort();
}

/**
 * 把给定 URL 从 ESM loadCache 与 CJS require.cache 里摘掉，返回可回滚的备份。
 *
 * Node 24 的 LoadCache 是 `Map<url, {[type]: ModuleJob}>`，它的 delete 只把类型槽置空，
 * 所以这里统一用 `Map.prototype.*` 直接操作，行为与 dsh-hmr 自己的实现一致。
 */
export function clearModuleCaches(cache, urls) {
  const backup = new Map();
  for (const url of urls) {
    if (cache !== undefined) {
      const job = Map.prototype.get.call(cache, url);
      if (job === undefined) continue;
      backup.set(url, job);
      Map.prototype.delete.call(cache, url);
    }
    try {
      const filepath = fileURLToPath(url);
      if (nodeRequire.cache?.[filepath] !== undefined) {
        backup.set(`cjs:${filepath}`, nodeRequire.cache[filepath]);
        Reflect.deleteProperty(nodeRequire.cache, filepath);
      }
    } catch {
      // 非文件 URL（node: 等）直接跳过
    }
  }
  return backup;
}

/** 回滚 `clearModuleCaches`。 */
export function restoreModuleCaches(cache, backup) {
  for (const [key, value] of backup) {
    if (typeof key === 'string' && key.startsWith('cjs:')) {
      nodeRequire.cache[key.slice(4)] = value;
      continue;
    }
    Map.prototype.set.call(cache, key, value);
  }
}

/** 在 HMR 的事务队列里跑一段操作（没有 HMR 就直接跑）。 */
export async function runExclusive(ctx, operation) {
  const hmr = ctx.get?.('hmr');
  if (typeof hmr?.runExclusive !== 'function') return operation();
  try {
    return await hmr.runExclusive(operation);
  } catch (error) {
    // 已经身处一个 HMR 事务里时不允许嵌套，此时直接执行即可。
    if (String(error?.message ?? '').includes('nested')) return operation();
    throw error;
  }
}

/**
 * 当前作用域下模型能看到的工具名（用于「重载前后多了/少了什么」的对照）。
 *
 * 必须走**根 Context** 读：热重载会把本插件自己的 fiber 连同它的 ctx 一起 dispose，
 * 用已销毁的 ctx 读工具表只会拿到空数组 —— 于是报告会荒谬地说「所有工具都消失了」。
 */
export function toolNames(ctx, scope) {
  const root = ctx.root ?? ctx;
  try {
    const tools = root.get?.('tools') ?? ctx.get?.('tools');
    const schemas = tools?.schemas?.(scope) ?? [];
    return schemas.map((item) => item.name).filter((name) => typeof name === 'string').sort();
  } catch {
    return [];
  }
}

/** 两个名字数组的差集报告。 */
export function diffNames(before, after) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((name) => !beforeSet.has(name)),
    removed: before.filter((name) => !afterSet.has(name)),
  };
}

/**
 * 逐个调用技能提供方的 `list()`，把抛错的抓出来。
 *
 * 这是排查「磁盘上明明有技能，会话里却看不见」的关键一步：注册表遇到某个 provider
 * 抛错时会跳过它并标记本次观察不完整，模型侧完全看不到诊断信息。
 */
export async function providerDiagnostics(ctx, cwd) {
  const skills = skillsOf(ctx);
  const rows = [];
  if (skills === undefined) return rows;
  const layers = skills.layers ?? {};

  const visit = async (label, providers) => {
    const data = providers?.data;
    if (!(data instanceof Map)) return;
    for (const [name, value] of data) {
      const provider = value?.provider ?? value;
      const row = { layer: label, provider: String(name), count: undefined, error: undefined };
      if (typeof provider?.list !== 'function') {
        rows.push(row);
        continue;
      }
      try {
        const result = await provider.list({ cwd });
        row.count = Array.isArray(result) ? result.length : result?.candidates?.length;
      } catch (error) {
        row.error = String(error?.message ?? error);
      }
      rows.push(row);
    }
  };

  await visit('global', layers.global?.providers);
  const scoped = layers.scoped;
  const scopedRows = scoped instanceof Map ? [...scoped.entries()] : [];
  let index = 0;
  for (const [, value] of scopedRows) {
    index += 1;
    await visit(`scope#${index}`, value?.providers);
  }
  return rows;
}
