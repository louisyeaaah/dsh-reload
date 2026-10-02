#!/usr/bin/env bash
# 静态自检：语法、bundle manifest、patch YAML、工具清单、纯逻辑单测。
#
#   scripts/verify.sh
#
# 全部不需要 DSH 在跑，也不需要网络 —— CI 与别人 clone 下来都能直接跑。
# 「重载能不能真的生效」只能在宿主里验证，见 README 的 Verification 一节。
set -uo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PKG_DIR"

fail=0
step() { printf '\n== %s ==\n' "$1"; }

step '1/5 JS 语法'
for file in lib/*.js scripts/selftest.mjs; do
  if node --check "$file" 2>/dev/null; then
    echo "  ✓ $file"
  else
    echo "  ✗ $file"
    fail=1
  fi
done

step '2/5 bundle manifest'
node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
let bad = 0;
const patch = pkg.dsh?.bundle?.patch;
const check = (label, ok) => { console.log(`  ${ok ? "✓" : "✗"} ${label}`); if (!ok) bad = 1; };
check(`dsh.bundle.patch = ${patch ?? "(缺失)"}`, typeof patch === "string");
check(`patch 文件存在（${patch}）`, typeof patch === "string" && fs.existsSync(patch));
check("main 指向存在的文件", typeof pkg.main === "string" && fs.existsSync(pkg.main));
check("license 字段存在", typeof pkg.license === "string" && pkg.license !== "");
check("repository 指向本仓库", typeof pkg.repository?.url === "string" && pkg.repository.url.includes("dsh-reload"));
check("dsh-plugin 关键词已声明", (pkg.keywords ?? []).includes("dsh-plugin"));
for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
  // node-semver 的坑：不带显式预发布分支的范围会静默排除 harness 的预发布构建
  check(`peer ${name} 带显式预发布分支（${range}）`, /-rc\.[0-9]/.test(range));
}
process.exit(bad);
' || fail=1

step '3/5 cordis.patch.yml 可解析'
python3 scripts/validate-patch.py cordis.patch.yml
status=$?
if [ "$status" -ne 0 ] && [ "$status" -ne 79 ]; then
  echo "  ✗ patch 文件结构不合法"
  fail=1
fi

step '4/5 工具与命令清单'
node -e '
const fs = require("node:fs");
const src = fs.readFileSync("lib/index.js", "utf8");
const want = ["reload_plugin", "reload_skill", "reload-plugin", "reload-skill"];
let bad = 0;
for (const name of want) {
  const ok = src.includes(name);
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) bad = 1;
}
process.exit(bad);
' || fail=1

step '5/5 纯逻辑自检'
node scripts/selftest.mjs || fail=1

printf '\n'
if [ "$fail" -eq 0 ]; then
  echo "✅ 静态自检通过"
else
  echo "❌ 静态自检失败"
fi
exit "$fail"
