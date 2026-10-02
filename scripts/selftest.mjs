// 自检：不开 DSH 也能跑的那部分逻辑（frontmatter 解析、技能根发现、去重）。
//
//   node scripts/selftest.mjs
//
// 退出码 0 = 全过。

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  discoverSkills,
  nearestProjectRoot,
  parseFrontmatter,
  resolveSkillRoots,
  rootsSignature,
} from '../lib/skill-provider.js';

let failures = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${label}\n      ${error.message}`);
  }
}

console.log('frontmatter 解析');

await check('普通标量', () => {
  const data = parseFrontmatter('---\nname: demo\ndescription: 一句话\n---\n\n正文\n');
  assert.equal(data.name, 'demo');
  assert.equal(data.description, '一句话');
});

await check('折叠块标量 >-', () => {
  const raw = '---\nname: demo\ndescription: >-\n  第一行\n  第二行\n\n  第三行\n---\n正文\n';
  assert.equal(parseFrontmatter(raw).description, '第一行 第二行\n第三行');
});

await check('字面块标量 |', () => {
  const raw = '---\nname: demo\ndescription: |\n  第一行\n  第二行\n---\n正文\n';
  assert.equal(parseFrontmatter(raw).description, '第一行\n第二行');
});

await check('引号 + 布尔 + 嵌套块', () => {
  const raw = '---\nname: "demo-skill"\ndescription: \'单引号说明\'\n'
    + 'disable-model-invocation: true\nmetadata:\n  owner: someone\n---\n正文\n';
  const data = parseFrontmatter(raw);
  assert.equal(data.name, 'demo-skill');
  assert.equal(data.description, '单引号说明');
  assert.equal(data['disable-model-invocation'], 'true');
});

await check('没有 frontmatter → undefined', () => {
  assert.equal(parseFrontmatter('# 只是正文\n'), undefined);
});

await check('真实世界的多行 >- 描述（用临时文件，不依赖本机技能）', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-reload-fm-'));
  try {
    const file = join(dir, 'SKILL.md');
    await writeFile(file, [
      '---',
      'name: sample-skill',
      'description: >-',
      '  第一段说明，写得比较长，所以要折行，',
      '  折行之后应该被拼回同一段。',
      '',
      '  第二段在空行之后。',
      'whenToUse: 当用户问示例问题时。',
      '---',
      '',
      '正文。',
      '',
    ].join('\n'), 'utf8');
    const data = parseFrontmatter(readFileSync(file, 'utf8'));
    assert.equal(data.name, 'sample-skill');
    assert.equal(data.description, '第一段说明，写得比较长，所以要折行， 折行之后应该被拼回同一段。\n第二段在空行之后。');
    assert.equal(data.whenToUse, '当用户问示例问题时。');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

console.log('\n技能根与发现');

await check('nearestProjectRoot 无 .git 时回退到 cwd', () => {
  assert.equal(nearestProjectRoot('/tmp'), '/tmp');
});

await check('根列表顺序与来源标签', () => {
  const roots = resolveSkillRoots('/tmp', { customSkillDirs: ['/opt/skills'] });
  const shapes = roots.map((root) => `${root.source}@${root.rank}`);
  assert.deepEqual(shapes, ['project-dsh@100', 'project-agents@200', 'custom@300', 'user-dsh@400', 'user-agents@500']);
  assert.ok(roots.some((root) => root.path === '/opt/skills'));
});

await check('扫描用户技能根（0 个也算通过，只看结构合法）', async () => {
  const roots = resolveSkillRoots(process.cwd(), {});
  const result = await discoverSkills(roots);
  const names = result.candidates.map((item) => item.name);
  console.log(`      发现 ${names.length} 个：${names.join(', ') || '（这台机器上还没有）'}`);
  for (const candidate of result.candidates) {
    assert.ok(candidate.description, `${candidate.name} 缺 description`);
    assert.equal(typeof candidate.rank, 'number');
    assert.ok(candidate.locator?.file);
  }
});

await check('rootsSignature 稳定且非空', async () => {
  const roots = resolveSkillRoots(process.cwd(), {});
  const first = await rootsSignature(roots);
  const second = await rootsSignature(roots);
  assert.equal(first, second);
  assert.ok(first.length > 0);
});

await check('在根目录下新建技能能被发现', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-reload-'));
  try {
    await mkdir(join(dir, 'skills', 'demo-skill'), { recursive: true });
    await writeFile(
      join(dir, 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: 临时测试技能\nuser-invocable: false\n---\n\n正文\n',
      'utf8',
    );
    const roots = [{ path: join(dir, 'skills'), source: 'custom', rank: 300 }];
    const result = await discoverSkills(roots);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].name, 'demo-skill');
    assert.equal(result.candidates[0].invocation.userInvocable, false);
    assert.equal(result.candidates[0].invocation.modelInvocable, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

console.log(failures === 0 ? '\n✅ 自检通过' : `\n❌ 自检失败：${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
