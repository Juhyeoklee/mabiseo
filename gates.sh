#!/usr/bin/env bash
# 빈 틀. 코드 층을 만든 세션이 그 층의 게이트를 같은 커밋에 넣는다.
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

code_dirs=()
for d in desktop ios protocol; do [ -d "$d" ] && code_dirs+=("$d"); done

if [ ${#code_dirs[@]} -gt 0 ]; then
  zero "코드에 § 없음"            grep -rn '§' "${code_dirs[@]}" --include='*.ts' --include='*.tsx' --include='*.swift'
  zero "이름 없는 유틸 파일 없음"   find "${code_dirs[@]}" -type f \( -name 'utils.*' -o -name 'helpers.*' -o -name 'common.*' -o -name 'misc.*' \) -not -path '*/node_modules/*'
fi

if [ -d desktop ]; then
  zero "입력 합성 라이브러리 없음"      grep -rn -E 'robotjs|nut-js|nut-tree|node-key-sender|@computer-use' desktop --include='package.json' --include='*.ts'
  zero "child_process는 connector/에만" grep -rln 'child_process' desktop --include='*.ts' --exclude-dir=node_modules --exclude-dir=connector
  zero "agent/는 connector를 import하지 않음" grep -rn -E "from ['\"].*connector" desktop/agent --include='*.ts'
  zero "명시적 any 없음"                grep -rn -E ':\s*any\b|<any>|as any\b' desktop --include='*.ts' --include='*.tsx' --exclude-dir=node_modules
  skip "desktop: tsc · 테스트"
else
  skip "desktop"
fi

if [ -d protocol ]; then
  skip "protocol: 계약 검사(생성물 diff 0)"
else
  skip "protocol"
fi

if [ -d ios ]; then
  skip "ios: 빌드 · Swift 테스트"
else
  skip "ios"
fi

exit $fail
