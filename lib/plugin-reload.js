// reload_plugin 的核心：把一个已加载插件的模块闭包从缓存里摘掉，重新 import 并重新 apply。
//
// 为什么不能借 dsh-hmr 的自动重载：
//   HMR 的 `partialReload()` 在判断「这个插件要不要重载」时会跳过位于 node_modules
//   下的模块（`loadDependencies()` 里对 `/node_modules/` 直接 return），
//   而用户装的插件恰恰都在 `<profile>/node_modules/` 下 —— 所以那条路对它们永远不生效。
//   （HMR 的 root 默认还是 `[]`，源码级 watch 也没开。）
//
// 这里走的是和 HMR 同一套动作，只是把「要不要重载」的判断换成调用方明确指定：
//   清模块缓存 → 卸载旧 fiber → entry.init() 重新 import + apply，失败则回滚。

import {
  clearModuleCaches,
  diffNames,
  entryIdOf,
  localModuleUrls,
  packageRootOf,
  readPackageManifest,
  resolveEntryUrl,
  restoreModuleCaches,
  runExclusive,
  toolNames,
} from './shared.js';

/** 列出现在有哪些插件行、分别在不在跑。 */
export function formatInventory(rows) {
  if (rows.length === 0) return 'Loader 树里没有插件行。';
  const width = Math.max(...rows.map((row) => row.id.length));
  return rows
    .map((row) => {
      const mark = row.disabled ? '✗ disabled' : row.active ? '● 运行中' : '○ 未激活';
      return `${mark.padEnd(11)} ${row.id.padEnd(width)}  ${row.name}`;
    })
    .join('\n');
}

/**
 * 热重载一个 entry。
 *
 * @param ctx 插件所在的 Context
 * @param entry Loader entry（要重载/激活的那一行）
 * @param options `{ scope, dryRun }`
 */
export async function reloadEntry(ctx, entry, options = {}) {
  const loader = ctx.get?.('loader');
  const cache = loader?.internal?.loadCache;
  const started = Date.now();
  const report = {
    ok: false,
    entryId: entryIdOf(entry),
    name: entry.options?.name,
    mode: undefined,
    url: undefined,
    packageRoot: undefined,
    cleared: [],
    restored: false,
    clientHalf: false,
    added: [],
    removed: [],
    error: undefined,
    elapsedMs: 0,
  };
  const before = toolNames(ctx, options.scope);

  // ── 1. entry 没在跑：把它拉起来（新装但还没激活的情况） ────────────────
  if (!entry.fiber?.uid) {
    report.mode = 'activate';
    if (entry.disabled) {
      report.error = '这一行是 disabled 的，先改 profile 的 cordis.patch.yml（或插件管理面板）把它启用';
      report.elapsedMs = Date.now() - started;
      return report;
    }
    try {
      await runExclusive(ctx, () => entry.init());
      report.ok = Boolean(entry.fiber?.uid);
      if (!report.ok) report.error = 'entry.init() 之后仍然没有活动 fiber —— 多半是模块 import 或插件 apply 抛错了，看宿主日志';
    } catch (error) {
      report.error = String(error?.message ?? error);
    }
    report.elapsedMs = Date.now() - started;
    report.added = diffNames(before, toolNames(ctx, options.scope)).added;
    return report;
  }

  // ── 2. entry 在跑：热重载它 ──────────────────────────────────────────
  report.mode = 'reload';
  const url = await resolveEntryUrl(ctx, entry);
  report.url = url;
  if (url === undefined) {
    report.error = '解析不出这个 entry 的模块 URL（可能是 cordis: 内置插件，或 loader 解析失败）';
    report.elapsedMs = Date.now() - started;
    return report;
  }
  const job = cache === undefined ? undefined : Map.prototype.get.call(cache, url);
  if (job === undefined) {
    report.error = `模块不在 ESM loadCache 里：${url}（插件可能不是通过 Loader 加载的）`;
    report.elapsedMs = Date.now() - started;
    return report;
  }

  const root = packageRootOf(url);
  report.packageRoot = root;
  const manifest = readPackageManifest(root);
  report.clientHalf = manifest?.dsh?.client !== undefined;

  let urls = localModuleUrls(cache, root);
  if (urls.length === 0) urls = [url];
  report.cleared = urls;

  if (options.dryRun === true) {
    report.ok = true;
    report.elapsedMs = Date.now() - started;
    return report;
  }

  // 备份 → 清缓存 → 卸载 → 重新加载；任何一步失败都回滚到旧模块
  const backup = clearModuleCaches(cache, urls);
  const oldFiber = entry.fiber;
  const oldPlugin = oldFiber?.runtime?.callback;
  const runtime = oldPlugin === undefined ? undefined : ctx.registry.get(oldPlugin);
  const fibers = [...(runtime?.fibers ?? [])];

  const perform = async () => {
    if (oldPlugin !== undefined) {
      ctx.registry.delete(oldPlugin); // 顺带 dispose 这个插件的全部 fiber
      await Promise.all(fibers.map((fiber) => fiber.await()));
    }
    entry.fiber = undefined;
    await entry.init(); // 重新 import（缓存已清，会重新求值）+ registry.plugin(...)
    if (!entry.fiber?.uid) throw new Error('重新加载后 entry 没有活动 fiber —— 模块 import 或插件 apply 失败');
  };

  try {
    await runExclusive(ctx, perform);
    report.ok = true;
  } catch (error) {
    report.error = String(error?.message ?? error);
    restoreModuleCaches(cache, backup);
    report.restored = true;
    try {
      entry.fiber = undefined;
      await runExclusive(ctx, () => entry.init());
    } catch (rollbackError) {
      report.error += `；回滚也失败：${String(rollbackError?.message ?? rollbackError)}`;
    }
  }

  const after = toolNames(ctx, options.scope);
  const diff = diffNames(before, after);
  report.added = diff.added;
  report.removed = diff.removed;
  report.elapsedMs = Date.now() - started;
  return report;
}

/** 把一次重载的结果写成给人/模型看的报告。 */
export function formatReloadReport(report) {
  const lines = [];
  const title = report.ok ? '✅ 重载成功' : '❌ 重载失败';
  lines.push(`${title}：${report.entryId}（${report.name}）`);
  if (report.mode === 'activate') lines.push('模式：激活未运行的 entry（不是重载，之前没有活动实例）');
  if (report.url !== undefined) lines.push(`模块：${report.url}`);
  if (report.packageRoot !== undefined) lines.push(`包根：${report.packageRoot}`);
  if (report.cleared.length > 0) {
    lines.push(`清理并重新求值的本地模块（${report.cleared.length}）：`);
    for (const url of report.cleared) lines.push(`  • ${url}`);
  }
  if (report.restored) lines.push('⚠️ 已回滚到重载前的模块（本次改动没生效）');
  if (report.added.length > 0) lines.push(`新增工具：${report.added.join(', ')}`);
  if (report.removed.length > 0) lines.push(`消失工具：${report.removed.join(', ')}`);
  if (report.added.length === 0 && report.removed.length === 0 && report.ok) lines.push('工具清单无变化。');
  if (report.clientHalf) {
    lines.push('提示：这个插件带 Web 客户端半边（dsh.client）—— 宿主这半边已经热重载；'
      + '浏览器那半边要页面刷新一次（或用 pnpm run dev:web 的 bundle watcher 自动换）。');
  }
  if (report.error !== undefined) lines.push(`原因：${report.error}`);
  lines.push(`耗时 ${report.elapsedMs}ms`);
  return lines.join('\n');
}
