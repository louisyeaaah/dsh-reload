#!/usr/bin/env bash
# 把 dsh-reload 从 profile 里卸载。
#
#   scripts/uninstall.sh [profile]      # 默认 desktop
#
# 卸载**需要重启 DSH**：Loader 树里删行没有稳定的公开入口，
# 这个插件也做不到把自己从正在运行的进程里摘干净。
set -euo pipefail

PKG_NAME="dsh-reload"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${1:-desktop}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PATCH="$PROFILE_DIR/cordis.patch.yml"
DEST="$PROFILE_DIR/node_modules/$PKG_NAME"
BEGIN_MARK="# >>> $PKG_NAME (managed by scripts/install.sh) >>>"
END_MARK="# <<< $PKG_NAME <<<"

say() { printf '%s\n' "$*"; }

if [ -f "$PATCH" ]; then
  cp "$PATCH" "$PATCH.bak-$(date +%Y%m%d-%H%M%S)"
  python3 - "$PATCH" "$BEGIN_MARK" "$END_MARK" <<'PY'
import re, sys
patch, begin, end = sys.argv[1:4]
text = open(patch, encoding='utf-8').read()
text = re.sub(re.escape(begin) + r'.*?' + re.escape(end) + r'\n?', '', text, flags=re.S)
open(patch, 'w', encoding='utf-8').write(text)
PY
  say "patch   : 已移除插件行（${PATCH}）"
fi

[ -d "$DEST" ] && rm -rf "$DEST" && say "插件    : 已删除 $DEST"
[ -d "$DSH_HOME/skills/$PKG_NAME" ] && rm -rf "$DSH_HOME/skills/$PKG_NAME" && say "技能    : 已删除 $DSH_HOME/skills/$PKG_NAME"

say ""
say "patch 行、插件目录、技能都清掉了。"
say "宿主会把 patch 的删除热协调掉（实测：删除后 Loader 树里对应行立即消失），一般不用重启。"
say "如果发现工具还在，再完全退出并重开 DSH（⌘Q 后重新打开）。"
