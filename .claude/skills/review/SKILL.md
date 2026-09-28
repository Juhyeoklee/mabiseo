---
name: review
description: |
  마비서 세션의 닫기. 게이트 → 코드 리뷰 1회 → 주석 리뷰 1회 → 이관 → 게이트 재실행 → 커밋 · 머지.
  "/review", "리뷰", "세션 닫기", "닫자" 시 활성화.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Edit
  - Agent
  - Skill
---

# /review — 세션 닫기

두 리뷰는 겹치지 않는다. 코드 리뷰는 주석을 안 보고, 주석 리뷰는 코드 로직을 안 건드린다. 각 1회. 재리뷰는 반영이 코드를 바꿨을 때만.

## 1. 게이트

```
./gates.sh
```

빨간 게이트가 있으면 여기서 멈춘다. 리뷰는 게이트를 통과한 코드에만 한다.

## 2. 코드 리뷰 (1회)

diff를 파일로 넘긴다. 리뷰어는 `Read` `Grep` `Glob`만 가지므로 git을 직접 부르지 못한다.

```
mkdir -p .claude/review
git diff main...HEAD > .claude/review/diff.patch
git diff main...HEAD --name-only > .claude/review/files.txt
```

`Agent` 도구로 `mabiseo-reviewer`를 부른다. 프롬프트에 두 파일 경로를 적는다. **전역 `code-reviewer`는 부르지 않는다.**

리뷰어는 보고만 한다. 발견마다 **수정 여부는 사용자가 정한다.** 사용자에게 발견 목록을 보이고 하나씩 결정을 받는다. 반영이 코드를 바꿨으면 그 부분만 재리뷰한다.

대상이 없으면(코드 변경 없음) 「대상 없음」으로 기록하고 넘어간다.

## 3. 주석 리뷰 (1회)

전역 스킬 `comment-review`를 부른다. 기준은 `.claude/rules/comments.md`와 `docs/coding-conventions.md`.

- 트림 · 이관은 직접 반영한다
- 결과 표는 커밋 승인 전에 사용자에게 보인다
- 대상이 없으면 「대상 없음」

## 4. 이관

🔴 이관 항목(「왜 이렇게 설계했나」)은 커밋 메시지 초안으로 옮긴 뒤 코드에서 지운다. 결정이 바뀐 것은 `docs/skeleton.md`의 결정 표로 옮긴다(사용자 판정).

## 5. 게이트 재실행

```
./gates.sh
```

## 6. 커밋 · 머지 (사용자 승인)

커밋 메시지는 판정 서사 · 설계 근거 · 이관한 「왜」를 담는다. 마지막 줄은 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

```
git add -A && git commit
git checkout main && git merge --no-ff s/<이슈번호>-<이름> -m "Merge s/<이슈번호>-<이름>

Closes #<이슈번호>"
git push origin main
gh issue close <이슈번호> 2>/dev/null || true
git branch -d s/<이슈번호>-<이름>
```

스쿼시하지 않는다. 푸시 전에 `gh auth status`가 `Juhyeoklee`인지 확인한다.

못 끝냈으면 커밋 · 머지 대신 이슈에 댓글 한 줄을 남긴다. 인계문을 쓰지 않는다.
