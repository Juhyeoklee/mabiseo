# 마비서 (mabiseo)

집 와이파이 안에서 아이폰으로 자연어 할 일을 보내면, Windows PC의 데스크탑 앱이 AI 에이전트로 마비노기 모바일 공식 AI 커넥터(CLI)를 불러 수행하고 진행을 폰에 돌려준다.

결정은 `docs/skeleton.md`에 있다. 상태는 GitHub 이슈와 마일스톤에서 읽는다. 이 파일에는 상태를 적지 않는다. 하네스가 바뀔 때만 고친다.

## 구조

```
protocol/   메시지 스키마. 두 언어가 공유하는 유일한 계약 (TS 타입 · Swift Codable)
desktop/    Electron + TS
  agent/       Agent SDK 호스트 (세션 · 스트림 · 도구 승인 콜백)
  connector/   CLI 어댑터. 실물(Windows) ↔ 가짜(녹화 재생). CLI 실행은 여기 한 곳
  tools/       에이전트에 내놓는 도구 + 보호 장치(날개 예산 · 가방 · 재시도 차단)
  jobs/        긴 활동 관리. 한 번에 하나
  server/      LAN WebSocket + Bonjour 광고 + 페어링
ios/        SwiftUI. 발견·페어링(01) · 대화(02)
recordings/ Windows에서 녹화한 CLI 응답. 가짜 커넥터의 재료이자 테스트 픽스처
scripts/    win-setup(실행기 설치) · win-exec(로그인 세션 실행) · win(브랜치 동기화 + 실행) · win-status(조회 전용)
```

의존 방향은 `agent/ → tools/ → connector/` 한 방향이다. 에이전트가 커넥터를 직접 부르면 보호 장치가 우회된다.

## 문서의 자리

| | 어디 | 규칙 |
|---|---|---|
| 안내 | `CLAUDE.md` | 구조 · 규칙 포인터 · 작업 방식. 상태 없음. 120줄 상한 |
| 결정 | `docs/skeleton.md` | 결정이 바뀌면 그 자리를 고친다. 계약이라 사용자 판정 |
| 로드맵 · 상태 | GitHub 이슈 + 마일스톤 | 마일스톤 M0~M3, 덩어리는 이슈. 상태는 닫힌 이슈와 라벨(`m0` …)로 읽는다 |
| 과정 | 커밋 메시지 | 판정 서사 · 설계 근거 · 주석에서 이관한 「왜」 |

- 이슈 본문은 세 줄이다. 무엇 · 완료 조건 · 실물 관문. 서사를 쓰지 않는다
- 판정 불가는 `재판정` 라벨 이슈로 둔다. 제목에 재판정 사건을 적는다
- 세션 플랜은 `.claude/design/`에 설계안으로 세우고 닫을 때 지운다. 결과는 커밋 메시지로
- 세션마다 이슈 댓글 둘. 킥오프 때 닫힘 조건, 닫을 때 결과 한 줄. 인계문을 쓰지 않는다

## 규칙

- 코드: `docs/coding-conventions.md`. 코드 리뷰어의 유일한 기준
- 주석: `.claude/rules/comments.md`. 기본값은 주석 없음
- 게이트: `./gates.sh`. 코드 층을 만든 세션이 그 층의 게이트를 같은 커밋에 넣는다

## 작업 방식

- 매 세션은 `/kickoff`로 시작하고 `/review`로 닫는다
- 설계는 이 세션이, 구현은 `.claude/agents/mabiseo-implementer.md`가 한다. 설계안의 인터페이스 · 테스트 명세 · 멈춤 조건이 다 채워질 때만 위임한다. 구현자는 판단하지 않고 멈춘다
- 가짜 커넥터로 먼저 만든다. 기본값은 가짜, 실물(`--real`)은 Windows에서만 켜진다. 실패 재현은 `--fail=wings|bag|popup|offline|login`
- 관측은 에이전트가, 입력(탭 · 스크롤 · PC 화면 확인)은 사용자에게 요청한다
- 기존 코드의 결함에 맞추느라 새 코드가 기이해지면 우회를 완성하지 말고 멈춘다
- Windows는 `ssh mabiseo-win`으로 닿는다. SSH 세션(세션 0)은 게임 파이프에 닿지 못하므로, 게임을 건드리는 명령은 `scripts/win-exec`가 로그인 세션의 실행기(작업 스케줄러 작업 `mabiseo-run`)를 깨워 돌린다. `scripts/win <명령>`은 세션 브랜치 체크아웃까지 얹은 것이고, `scripts/win-setup`이 실행기를 한 번 설치한다
- Windows에 두는 ps1은 UTF-8 BOM으로 저장한다. BOM이 없으면 Windows PowerShell이 한글 주석을 CP949로 읽어 줄바꿈을 먹는다
- 녹화는 Windows에서 파일로 쓰고 `scp`로 가져온다. `scp` 경로는 슬래시(`C:/Users/...`)로 쓴다
- 원격 작업(gh · push)은 개인 계정 Juhyeoklee로 한다. `gh auth status`로 확인하고 아니면 `gh auth switch --user Juhyeoklee`. 원격 URL은 SSH 별칭 `github-personal`

## 신호원

| 판정 | Mac · 가짜 | Windows · 실물 |
|---|---|---|
| 파싱 · 정규화 · 보호 장치 · 작업 관리 | 단위 테스트로 끝낸다 | 관문에서 1판 |
| 에이전트의 도구 호출 순서 | 시나리오 몇 개를 손으로 돌린다. 게이트 아님 | 가끔 |
| 한글 인코딩 · 팝업 · 게임 상태 · 소요 시간 | 녹화로만 | 여기서 |
| LAN · Bonjour · 방화벽 | Mac 로컬 | 방화벽은 여기서만 드러난다 |

## 금지선

넘기 전에 사용자에게 묻는다. 날개를 쓰는 호출 · 채팅 전송 · 프로토콜 계약 변경 · 범위 추가.

팝업 자동 클릭은 묻지도 않는다. 영구 금지다. 방치 파밍 방지 장치의 우회다.

## 사용자가 불려 들어가는 자리

킥오프 합의 · 실물 관문 반응 · 금지선 · 리뷰 발견의 수정 여부 · 커밋과 머지.

## 만들지 않는 것

- 인계문 · 플래닝 세션 · 검산 세션 · 정리 세션 · 규칙 표본 측정
- 참고 저장소의 코드. 도메인 지식의 출처로만 쓴다
- 전역 `~/.claude/agents/code-reviewer.md`는 다른 프로젝트 전용이다. 부르지 않는다. 코드 리뷰는 `.claude/agents/mabiseo-reviewer.md`, 구현은 `.claude/agents/mabiseo-implementer.md`
