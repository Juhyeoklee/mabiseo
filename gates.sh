#!/usr/bin/env bash
# 코드 층을 만든 세션이 그 층의 게이트를 같은 커밋에 넣는다.
set -u
cd "$(dirname "$0")"
fail=0
red()   { printf '\033[31m✗ %s\033[0m\n' "$*"; fail=1; }
green() { printf '\033[32m✓ %s\033[0m\n' "$*"; }
skip()  { printf '\033[90m- %s (아직 없음)\033[0m\n' "$*"; }

# grep 대조 — 0이어야 한다. 틀릴 여지가 있는 자는 들이지 않는다
zero() {
  local name="$1"; shift
  local hits
  hits=$("$@" 2>/dev/null | head -20)
  if [ -n "$hits" ]; then red "$name"; printf '%s\n' "$hits"; else green "$name"; fi
}

run() {
  local name="$1"; shift
  local out
  if out=$("$@" 2>&1); then green "$name"; else red "$name"; printf '%s\n' "$out" | tail -40; fi
}

code_dirs=()
for d in desktop ios protocol; do [ -d "$d" ] && code_dirs+=("$d"); done

if [ ${#code_dirs[@]} -gt 0 ]; then
  zero "코드에 § 없음"            grep -rn '§' "${code_dirs[@]}" --include='*.ts' --include='*.tsx' --include='*.swift' --exclude-dir=node_modules
  zero "이름 없는 유틸 파일 없음"   find "${code_dirs[@]}" -type f \( -name 'utils.*' -o -name 'helpers.*' -o -name 'common.*' -o -name 'misc.*' \) -not -path '*/node_modules/*' -not -path '*/.build/*'
  zero "명시적 any 없음"            grep -rn -E ':\s*any\b|<any>|as any\b' "${code_dirs[@]}" --include='*.ts' --include='*.tsx' --exclude-dir=node_modules
fi

if [ -d desktop ]; then
  zero "입력 합성 라이브러리 없음"      grep -rn -E 'robotjs|nut-js|nut-tree|node-key-sender|@computer-use' desktop --include='package.json' --include='*.ts'
  zero "child_process는 connector/에만" grep -rln 'child_process' desktop --include='*.ts' --exclude-dir=node_modules --exclude-dir=connector
  zero "agent/는 connector를 import하지 않음(테스트 제외)" grep -rn -E "from ['\"].*connector" desktop/agent --include='*.ts' --exclude='*.test.ts'
  zero "맡기기 명령 이름은 tools/와 connector/에만(테스트 제외)" grep -rn -E "execute_(gathering|altering|crafting)|complete_altering_work|play_music_score|change_instrument|stop_action|stand_up" desktop --include='*.ts' --exclude='*.test.ts' --exclude-dir=node_modules --exclude-dir=connector --exclude-dir=tools
  [ -d desktop/node_modules ] || run "desktop: npm ci" npm --prefix desktop ci --silent
  run "desktop: tsc"    npm --prefix desktop run -s typecheck
  run "desktop: 테스트" npm --prefix desktop test -s -- --reporter=dot
else
  skip "desktop"
fi

if [ -d protocol ]; then
  [ -d protocol/node_modules ] || run "protocol: npm ci" npm --prefix protocol ci --silent
  run "protocol: tsc"        npm --prefix protocol run -s typecheck
  run "protocol: TS 왕복"    npm --prefix protocol test -s -- --reporter=dot
  run "protocol: Swift 왕복" swift test --package-path protocol -q
else
  skip "protocol"
fi

if [ -d ios ]; then
  skip "ios: 빌드 · Swift 테스트"
else
  skip "ios"
fi

if [ -d recordings ]; then
  zero "녹화는 전부 UTF-8 JSON" bash -c 'for f in $(find recordings -name "*.json"); do python3 -c "import sys,json; s=open(sys.argv[1],encoding=\"utf-8\").read(); json.loads(s); assert \"\ufffd\" not in s" "$f" >/dev/null 2>&1 || echo "$f"; done'
fi

exit $fail
