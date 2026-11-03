# 로컬 PC(Windows) 이전 설계 — GitHub 의존 제거

작성: 2026-11-03 · 대상 저장소 `kospi-signal/kospi-signal.github.io` @ `36f1b4b`

## 0. 목표와 범위

| 목표 | 의미 |
| --- | --- |
| 코드 완전 비공개 | 수집·정산·모델 학습 코드, 워크플로우, 테스트, 문서, git 기록이 외부에 보이지 않는다. |
| GitHub 연결 제거 | GitHub Actions·Pages·API·저장소를 쓰지 않는다. 이전 완료 후 GitHub 저장소는 삭제한다. |
| 운영 연속성 | 지금의 일정(06:10 일봉 → 07:00 → 08:00 → 08:35 → 09:00 → 15:31 → 저녁 갱신 → 20:15 수급)과 지연·누락 정책을 그대로 유지한다. |

범위 밖: 모델·수집 로직 변경. 이 문서는 "어디서 어떻게 돌리느냐"만 바꾼다.

### 0.1 먼저 정해야 할 것 (결정 필요)

| # | 질문 | 추천 | 영향 |
| --- | --- | --- | --- |
| D1 | 사이트를 계속 **인터넷에 공개**할 것인가? | 공개 유지 → Cloudflare Pages 직접 업로드(§3.5) | 비공개면 §3.5를 "로컬 전용"으로 단순화 |
| D2 | 실행 환경 | **Windows 기본 Node 22**(WSL 없이) | WSL2를 고르면 §3.1 대안 경로 |
| D3 | 화면에서 모델 계산을 계속 할 것인가? | 화면용 계산 결과를 미리 만들어 두고 모델 코드는 비공개 | 공개 사이트에 `providers/*-model.js`가 실리는지 여부(§3.5.3) |
| D4 | 코드 백업 위치 | 외장 디스크/NAS의 bare 저장소 + 클라우드 드라이브에 암호화 번들 | §3.4 |
| D5 | 실패 알림 수단 | Windows 알림 + Telegram 봇(선택) | §3.8 |

## 1. 현재 구조와 GitHub 의존 목록

### 1.1 워크플로우 17개

| 워크플로우 | 실행 계기 | 시각(KST) | 동시 실행 그룹 | 하는 일 | 커밋 |
| --- | --- | --- | --- | --- | --- |
| `scheduler-keeper` | cron 9개 + 이어받기 dispatch | 상시(00:07~ ) | `kospi-scheduler-keeper` | `scheduler-plan.mjs`로 단계 시각 판단, GitHub API로 단계 워크플로우 dispatch, 5시간40분 전 이어받기 | 없음 |
| `naver-daily-history` | keeper | 06:10 (재시도 07:10, 마감 07:45) | pipeline | 거래일 확인 → 종목 목록 갱신 → 전일 일봉 수집 | `data/daily-history/D.json`, `kospi-universe.json` |
| `update-results` | keeper | 07:00 (마감 08:50) | pipeline(`_run-stage`) | 전일 결과 정리 | `data/runs`, `latest-snapshot.json`, `date-index.json` |
| `analysis` | keeper | 08:00 (마감 08:50) | pipeline | 장전 분석 | 같음 |
| `forecast` | keeper | 08:35 (마감 08:50) | pipeline | 장전 예측 + 장전 순위 고정 + 실험 기준선 | 같음 + `preopen-ranking`, `experiments` |
| `open-settlement` | keeper | 09:00 (마감 23:00) | pipeline | 시가 정산 + 단타 판단(open) | 같음 + `daytrade` |
| `close-catch-up` | keeper(누락 확인 시) | 09:30~14:30 | pipeline | 직전 5거래일 누락 종가 보충 | `data/runs`, `date-index`, `latest-snapshot` |
| `close-settlement` | keeper | 15:31 (마감 23:00) | pipeline | 종가 정산 + 사후 평가 + 단타 정산(close) | 같음 + `daytrade` |
| `personal-investor-flow` | close-settlement 성공 후(`workflow_run`) + cron 20:15 + 수동 | 15:3x, 20:15 | `personal-investor-flow` | 투자자별 매매동향 수집 | `data/investor-flow` |
| `next-day-history` | cron | 18:45, 20:00, 22:30 | pipeline | 저녁 일봉, 다음 거래일 미리보기 | `daily-history`, `next-preview`, universe |
| `update-market-calendar` | cron | 03:00 | `kospi-market-calendar` | KRX 휴장일 갱신 | `krx-market-holidays.json` |
| `run-now` | 수동 | — | pipeline | 현재 시각 단계 실행 | 단계와 같음 |
| `run-all-now` | 수동(날짜) | — | pipeline | 지정일 전 단계 재구성 | 단계와 같음 |
| `investor-flow-backfill` | 수동 | — | `investor-flow-backfill` | 매매동향 과거 수집 | `data/investor-flow` |
| `investor-source-probe` | 수동 | — | 없음 | 출처 점검(읽기 전용) | 없음 |
| `validation` | push/PR | — | per-ref | `npm test`, `check`, `collection:audit`, `test:future-clock` | 없음 |
| `_run-stage` | 위 단계들이 호출 | — | pipeline | 공용 단계 실행기(아래 §3.3.2) | — |

### 1.2 GitHub에 묶인 지점

| 지점 | 위치 | 대체 |
| --- | --- | --- |
| cron 스케줄 | 워크플로우 `on.schedule` | 로컬 데몬 스케줄러(§3.2.4) |
| 단계 dispatch, 실행 기록 조회 | `scripts/scheduler-keeper.mjs`의 `githubClient`(Actions API, contents API) | 로컬 클라이언트(실행 장부 + 파일시스템)(§3.2.5) |
| 단계 연쇄 | `personal-investor-flow`의 `workflow_run` | 데몬 이벤트(`job.completed`)(§3.2.6) |
| 동시 실행 제한 | `concurrency.group` | 데몬 내부 잠금(§3.2.3) |
| 단계 출력/요약 | `GITHUB_OUTPUT`(스크립트 9개), `GITHUB_STEP_SUMMARY`(10개), `GITHUB_RUN_ID`(4개), `GITHUB_REF_NAME`·`GITHUB_REPOSITORY`·`GITHUB_TOKEN`(keeper) | **Actions 호환 계층**이 같은 환경변수를 파일로 제공(§3.2.2) — 스크립트 수정 없음 |
| 저장소 반영 | `scripts/commit-and-push.sh`(git pull --rebase + push) | 로컬 커밋 전용 `ops/lib/commit.mjs`(§3.4) |
| bash 단계 32개, python3 요약 9개 | 워크플로우 `run:` | Node로 옮긴 job 정의(§3.3) — bash·python 불필요 |
| bash 스크립트 2개 | `commit-and-push.sh`, `stage-daily-experiment.sh` | Node로 재작성 |
| 사이트 호스팅 | GitHub Pages(저장소 루트 전체 공개 — **현재 `scripts/`도 사이트 URL로 열림**) | 공개 번들만 업로드(§3.5) |
| 비밀값 | `secrets.KOSPI_PROVIDER_*`, `vars.KOSPI_PUBLIC_SOURCE_*` | `%LOCALAPPDATA%\kospi-signal\secrets.env` 또는 Windows 자격 증명 관리자(§3.6) |
| 코드 검증 | `validation.yml` | git `pre-commit`/`pre-push` 훅 + 공개 전 검사(§3.7) |
| 실행 화면·로그 | Actions UI | 로컬 로그·요약·상태 페이지(§3.8) |
| 사이트 URL | `https://kospi-signal.github.io/` (User-Agent에도 포함) | 새 URL로 교체(§5 단계 3) |

## 2. 목표 구조

```
Windows PC
├─ 작업 스케줄러: "kospi-signal daemon" (부팅 시 시작, 실패 시 재시작)
│    └─ node ops\daemon.mjs  ← 상시 실행, 하나만
│         ├─ 스케줄러: scheduler-plan.mjs(그대로) + 고정 시각 작업(cron 대체)
│         ├─ 실행기: job 정의(ops\jobs\*.mjs) → 기존 scripts\*.mjs를 자식 프로세스로 실행
│         ├─ Actions 호환 계층: GITHUB_OUTPUT/STEP_SUMMARY/RUN_ID 파일 제공
│         ├─ 잠금: pipeline / investor-flow / backfill / calendar
│         ├─ 실행 장부: var\ledger\YYYY-MM.jsonl
│         ├─ 커밋: 로컬 git 커밋(푸시 없음)
│         ├─ 공개: dist\ 빌드 → Cloudflare Pages 업로드(디바운스)
│         └─ 알림/상태: var\status.json, http://127.0.0.1:8787 상태 페이지
├─ C:\kospi-signal\            ← 작업 저장소(로컬 git, 원격 없음)
├─ D:\backup\kospi-signal.git  ← bare 백업(커밋마다 push) + 주간 암호화 번들
└─ %LOCALAPPDATA%\kospi-signal\secrets.env (저장소 밖)

인터넷
└─ Cloudflare Pages: index.html, styles.css, app.js, 화면용 providers 20개, data 허용 목록만
```

## 3. 구성요소 설계

### 3.1 실행 환경

**추천: Windows 기본(WSL 없이)**

| 항목 | 내용 |
| --- | --- |
| Node | 22 LTS(지금 워크플로우와 같은 메이저). `winget install OpenJS.NodeJS.LTS` 후 버전 고정 확인 |
| Git | Git for Windows. `core.autocrlf=false`, `core.longpaths=true`, `core.fsmonitor=false` |
| bash/python | **불필요**. 워크플로우의 bash·python3 단계를 전부 Node job으로 옮긴다 |
| 시간대 | 스크립트는 KST를 직접 계산(`market-calendar.mjs` 등)하므로 PC 시간대와 무관. 다만 **시계 정확도**가 중요 → `w32tm` 동기화 주기 단축(§3.9) |
| 경로 | 스크립트는 상대 경로·`node:path`를 사용. `npm test`의 `tests/*.test.mjs`는 cmd가 펼치지 않지만 Node 22 `--test`가 glob을 직접 처리 → 그대로 동작(이전 1단계에서 확인) |
| 줄바꿈 | 데이터 JSON은 `\n`. autocrlf를 끄지 않으면 커밋마다 전체 파일이 바뀐 것으로 보임 → 반드시 끔. `.gitattributes`에 `* text=auto eol=lf` 추가 |

**대안: WSL2 Ubuntu** — bash/python을 그대로 쓸 수 있지만 WSL VM이 유휴 시 꺼지고(`vmIdleTimeout`), Windows 작업 스케줄러와 systemd 사이 연결, 파일 시스템 경계(`/mnt/c` 느림) 관리가 추가된다. 어차피 워크플로우를 Node로 옮겨야 하므로 이점이 작다.

### 3.2 로컬 오케스트레이터 `ops/`

새 디렉터리(전부 Node, 외부 의존성 없음).

```
ops/
  daemon.mjs            상시 실행 진입점
  run.mjs               수동 실행 CLI (run-now, run-all, catch-up, backfill, probe, publish …)
  status.mjs            상태 출력 CLI
  lib/
    actions-compat.mjs  GITHUB_* 환경 흉내
    runner.mjs          job 실행(단계, 조건, 시간 제한, 출력)
    locks.mjs           동시 실행 잠금(파일 잠금 + 프로세스 내 큐)
    ledger.mjs          실행 장부(jsonl)
    schedule.mjs        고정 시각 작업 + keeper 계획 통합
    local-client.mjs    keeper용 githubClient 대체
    commit.mjs          로컬 커밋
    publish.mjs         dist 빌드·업로드
    notify.mjs          알림
    log.mjs             로그 파일·회전
  jobs/
    stage.mjs           _run-stage 이식 (update-results/analysis/forecast/open/close/run-now)
    naver-daily-history.mjs
    next-day-history.mjs
    close-catch-up.mjs
    personal-investor-flow.mjs
    investor-flow-backfill.mjs
    update-market-calendar.mjs
    run-all.mjs
    probe.mjs
  config.mjs            경로, 시각, 잠금 그룹, 공개 허용 목록
var/                    (gitignore) 로그·장부·상태·임시
dist/                   (gitignore) 공개 번들
```

#### 3.2.1 job 모델

```js
// ops/jobs/naver-daily-history.mjs (예)
export default {
  id: "naver-daily-history",
  lock: "pipeline",
  timeoutMs: 20 * 60_000,
  steps: [
    { id: "market", run: ["node", "scripts/market-session-guard.mjs"] },
    { id: "universe", if: (c) => c.out.market.should_run === "true",
      run: ["node", "scripts/update-kospi-universe.mjs", "--candidates-csv", "latest"], continueOnError: true },
    { id: "collect", if: (c) => c.out.market.should_run === "true",
      run: ["node", "scripts/collect-naver-daily.mjs"] },
    { id: "save", if: (c) => c.out.market.should_run === "true",
      commit: { paths: (c) => [`data/daily-history/${c.out.market.market_date}.json`, "data/kospi-universe.json"],
                message: (c) => `chore(data): record prior daily history ${c.out.market.market_date}` } },
  ],
};
```

- 단계 결과: `outcome`(success/failure/skipped), `outputs`(키=값), 소요 시간, 종료 코드.
- `if`는 함수. 워크플로우의 `always()`는 `always: true`, `steps.X.outcome`은 `c.steps.X.outcome`.
- `continueOnError`는 워크플로우의 `continue-on-error`와 같다.
- 단계 하나는 자식 프로세스 하나. 표준출력·오류는 그대로 job 로그로 간다.

#### 3.2.2 Actions 호환 계층 (`actions-compat.mjs`)

스크립트를 고치지 않기 위한 핵심. 각 단계 실행 전에 만든다.

| 환경변수 | 로컬 값 | 단계 후 처리 |
| --- | --- | --- |
| `GITHUB_OUTPUT` | `var\runs\<runId>\<step>.output` (빈 파일) | `key=value` 줄 및 `key<<EOF` 블록을 파싱해 `outputs`로 |
| `GITHUB_STEP_SUMMARY` | `var\runs\<runId>\summary.md` (job 전체 공용, 추가 쓰기) | 상태 페이지에 표시 |
| `GITHUB_RUN_ID` | 단조 증가 정수(`var\run-counter`) — 기존 `run_id`와 충돌하지 않게 `9000000000`부터 | 데이터 메타의 `run_id`로 기록됨 |
| `GITHUB_RUN_ATTEMPT` | 1(재시도 시 증가) | |
| `GITHUB_REF_NAME` | `main` | |
| `GITHUB_REPOSITORY` | `local/kospi-signal` | keeper는 로컬 클라이언트를 쓰므로 검증만 통과 |
| `GITHUB_EVENT_NAME` | `schedule` / `workflow_dispatch` / `workflow_run` | 매매동향 job 분기에 사용 |
| `GITHUB_ACTIONS` | 설정하지 않음 | 로컬임을 구분하려면 `KOSPI_LOCAL_RUNNER=1` 추가 |

`run-context.mjs`가 워크플로우 입력(`inputs.stage`, `run_id`, `run_attempt`)을 환경변수로 받는 부분은 job 정의가 같은 이름으로 넘긴다(§3.3.2).

#### 3.2.3 동시 실행 잠금 (`locks.mjs`)

| 잠금 | 쓰는 job | 정책 |
| --- | --- | --- |
| `pipeline` | stage 6종, naver-daily-history, next-day-history, close-catch-up, run-all | 하나씩. 대기열 순서 = 요청 순서. 취소 없음(`cancel-in-progress: false`와 같음) |
| `investor-flow` | personal-investor-flow | 하나씩 |
| `investor-backfill` | investor-flow-backfill | 하나씩. **pipeline과 동시 실행 허용**(지금과 같음) |
| `calendar` | update-market-calendar | 하나씩 |
| `git` | 모든 커밋 | 커밋 순간만 짧게 잠금 — 여러 job이 같은 작업 트리에 쓰므로 필수 |

- 데몬 내부 큐 + `var\locks\<name>.lock` 파일(PID 기록). 데몬이 죽었다 살아나면 PID가 없는 잠금은 지운다.
- GitHub에서는 job마다 깨끗한 체크아웃을 받았지만 로컬은 **작업 트리 하나를 공유**한다. 그래서 job 시작 전에 `git status --porcelain`이 비어 있는지 확인하고, 비어 있지 않으면 해당 job은 `blocked_dirty_tree`로 실패 처리 + 알림(자동으로 지우지 않음). backfill처럼 pipeline과 동시에 도는 job은 자기 경로(`data/investor-flow`)만 add/commit하므로 문제없다.

#### 3.2.4 스케줄 (`schedule.mjs`)

두 종류를 하나의 루프(30초 tick)로 처리한다.

1. **keeper 계획**: `scripts/scheduler-plan.mjs`의 `planKeeper`를 그대로 호출. 입력의 "오늘 실행 기록"은 실행 장부에서, `data/runs/<D>` 파일 목록은 파일시스템에서 읽는다. 계획이 `dispatch`를 내면 job을 큐에 넣는다. 늦은 실행 정책(장전 단계는 `lastStart` 이후 `missed`, 정산은 23:00까지, catch-up은 09:30~14:30)은 그대로 유지된다. 6시간 제한·이어받기(`relay`)는 필요 없으므로 무시한다.
2. **고정 시각 작업**(cron 대체):

| 작업 | 시각(KST) | 요일 | 놓쳤을 때(PC 꺼짐 등) |
| --- | --- | --- | --- |
| next-day-history | 18:45, 20:00, 22:30 | 월~금 | 다음 슬롯에서 실행. 22:30 슬롯을 놓치면 다음 날 06:00 전까지 1회 보충 |
| personal-investor-flow(정시) | 20:15 | 월~금 | 같은 날 23:59까지 보충 1회, 그 뒤에는 다음 날 수동 대상으로 기록 |
| update-market-calendar | 03:00 | 매일 | 다음 시작 시 1회 보충 |

- 슬롯마다 `ledger`에 `slot_key`(예: `next-day-history@2026-11-03T18:45`)를 남겨 중복 실행을 막는다.
- 시각 판단은 항상 KST(UTC+9 고정)로 계산. PC 시계가 다른 시간대여도 무관.

#### 3.2.5 keeper용 로컬 클라이언트 (`local-client.mjs`)

`scheduler-keeper.mjs`의 `githubClient`와 같은 인터페이스를 구현한다.

| 메서드 | GitHub | 로컬 |
| --- | --- | --- |
| `listRuns(workflow, sinceIso)` | Actions API | 장부에서 `job == workflow` 이고 `created_at >= since`인 항목 → `{id, event, status, conclusion, created_at}` 같은 모양 |
| `listRunFiles(date, ref)` | contents API | `fs.readdir("data/runs/<date>")` |
| `dispatch(workflow, ref, inputs)` | dispatch API | 데몬 큐에 job 추가 |

`runKeeper`의 루프(잠자기, 15분 재조회)는 쓰지 않고 `planKeeper`만 쓴다. 따라서 `scheduler-keeper.mjs`는 수정하지 않고, 테스트도 그대로 유지된다.

#### 3.2.6 단계 연쇄

- `close-settlement` job이 `success`로 끝나면 데몬이 `personal-investor-flow`를 `GITHUB_EVENT_NAME=workflow_run`, `CLOSE_STARTED=<close job 시작 시각>`으로 큐에 넣는다(지금 조건: 성공 + main + 같은 KST 날짜).
- 그 밖의 연쇄는 없다.

#### 3.2.7 시간 제한·재시도

- job별 `timeoutMs`(워크플로우 `timeout-minutes`와 같은 값). 넘으면 자식 프로세스 트리를 종료(`taskkill /T /F`)하고 `timed_out`.
- 자동 재시도는 keeper 정책(`naver-daily-history`의 07:10 재시도)만. 그 외는 지금처럼 재시도하지 않는다.

#### 3.2.8 수동 실행 CLI (`ops/run.mjs`)

| 지금(Actions 화면) | 로컬 명령 |
| --- | --- |
| 지금 실행 | `node ops\run.mjs run-now` |
| 전체 단계 실행(날짜) | `node ops\run.mjs run-all --date 2026-10-30` |
| 누락 마감 정산 보충 | `node ops\run.mjs close-catch-up [--date D[,D2]]` |
| 매매동향 수집(기간·종목) | `node ops\run.mjs investor-flow [--from D --to D] [--symbol 005930]` |
| 매매동향 과거 수집 | `node ops\run.mjs investor-backfill [--before D] [--budget-minutes N]` (6시간 제한이 없으므로 기본값은 무제한) |
| 출처 점검 | `node ops\run.mjs probe [--symbol 005930]` |
| KRX 휴장일 갱신 | `node ops\run.mjs calendar [--dry-run]` |
| 사이트 공개 | `node ops\run.mjs publish [--dry-run]` |

CLI는 데몬이 떠 있으면 데몬 큐에 넣고(로컬 HTTP `127.0.0.1:8787/api/enqueue`), 없으면 직접 실행한다. 어느 경우든 같은 잠금을 쓴다.

### 3.3 워크플로우 → job 이식표

#### 3.3.1 공통 변환 규칙

| 워크플로우 요소 | job |
| --- | --- |
| `actions/checkout`, `setup-node` | 없음(작업 트리 공유, Node 설치됨). 대신 시작 전 "작업 트리 깨끗함" 확인 |
| `run: node scripts/x.mjs` | `run: ["node","scripts/x.mjs",…]` |
| `npm test && npm run check && …` | `run: ["npm","test"]` 등 단계를 나눔(실패 지점이 로그에 바로 보이게) |
| `git add …; bash scripts/commit-and-push.sh "msg"` | `commit: { paths, message }` |
| bash 조건/변수 조립 | job 안의 JS 함수 |
| python3 "작업 단계 결과 요약" | 실행기가 자동으로 같은 표(단계·실제 결과·최종 판정)를 `summary.md`에 기록 |
| `if: always()` | `always: true` |
| `${{ secrets.X }}` / `${{ vars.X }}` | `secrets.env`에서 읽은 값(§3.6) |

#### 3.3.2 `_run-stage` → `jobs/stage.mjs`

가장 복잡한 이식. 단계 순서와 조건을 그대로 옮긴다.

1. 실행 시작 시각 기록(`run_started_at`).
2. `run-context.mjs`(입력 검증) — 입력: `stage`, `auto_stage`, `provider=naver-crawl`, `run_id`, `run_attempt`.
3. `market-session-guard.mjs` → `should_run`.
4. (auto_stage일 때) `run-context.mjs`로 현재 KST 단계 결정.
5. 정적 계약 검사: `npm test`, `npm run check`, `npm run check:experiment`. **로컬에서는 매 단계마다 300개 테스트(약 20초)를 돌리는 비용이 작으므로 유지**한다.
6. `update-results.mjs --mode <stage> --run-started-at … --attempted-at …`.
7. 실패 시 이전 결과 상태 파일 커밋.
8. forecast 성공 시 `freeze-preopen-ranking.mjs`.
9. 실험 기준선(`daily-baseline-run.mjs`) — 조건 동일.
10. 종가 단계 사후 평가(`stage-post-close-evaluation.mjs`).
11. 단타 판단(`daytrade-signal.mjs open|close --date`).
12. 요약 작성.
13. 변경 시 `generate-date-index.mjs` 후 `latest-snapshot.json`, `data/runs`, `date-index.json`, `daytrade`, `preopen-ranking` 커밋.
14. 실험 결과 저장(`stage-daily-experiment.sh` → Node 이식) 후 커밋.
15. 단계가 ready가 아니면 실패 처리, 실험 실패 시 실패 처리.

이식 방법: `.github/workflows/_run-stage.yml`의 각 `if:` 식을 JS로 1:1 옮기고, 이식 테스트(§4.2)에서 "같은 입력이면 같은 단계가 실행된다"를 표 형태로 검증한다.

#### 3.3.3 나머지 job 요약

| job | 단계(조건) | 커밋 경로 |
| --- | --- | --- |
| naver-daily-history | market → universe(실패 허용) → collect → save | `daily-history/D`, universe |
| next-day-history | market → universe → collect `--evening` → preview-ranking(수집 성공 시) → preview-state → save | `daily-history/T`, universe, `next-preview` |
| close-catch-up | 계약 검사 → `close-catch-up.mjs`(입력 `KOSPI_CATCH_UP_DATES`) → 변경 시 커밋 → ready 아니면 실패 | `runs`, `date-index`, `latest-snapshot` |
| personal-investor-flow | market → collect(수동 또는 거래일, `workflow_run`이면 종가 정산 날짜 확인) → 저장(`saved=true`일 때) | `investor-flow` |
| investor-flow-backfill | `backfill-investor-flow.mjs` — 바퀴마다 커밋하는 `--commit`을 로컬 커밋 함수로 교체 | `investor-flow` |
| update-market-calendar | 계약 검사 → `update-market-calendar.mjs` → 계약 재검사 → 변경 시 커밋 | `krx-market-holidays.json` |
| run-all | 날짜 검증 → 과거 날짜 확인 → 계약 검사 + `collection:audit` → `run-all.mjs` → 실패 시 상태 커밋 → 순위 고정 → 한 번에 커밋 → 실험 게이트 | 단계와 같음 |
| probe | `probe-investor-sources.mjs` | 없음 |

### 3.4 코드·데이터 보관 (git)

- 작업 저장소 `C:\kospi-signal`은 **원격이 없는** 로컬 git 저장소. 커밋 이력은 지금처럼 남긴다(데이터 감사 추적).
- `ops/lib/commit.mjs`가 `commit-and-push.sh`를 대신한다.
  - `git` 잠금 획득 → `git add -- <paths>` → 변경 없으면 종료 → `git -c user.name="kospi-signal-bot" -c user.email="bot@localhost" commit -m <msg>` → 백업 push → 잠금 해제.
  - pull/rebase가 필요 없다(작성자가 하나).
- **백업**(D4):
  - 1차: 외장 디스크/NAS의 bare 저장소 `D:\backup\kospi-signal.git`에 커밋마다 `git push backup main`(실패해도 job은 성공, 알림만).
  - 2차: 매주 일요일 03:30 `git bundle create` → 7-Zip AES-256으로 암호화 → OneDrive 같은 클라우드 폴더에 복사(최근 8개 유지). 비밀번호는 저장소 밖에 보관.
  - 복구 훈련: 이전 단계 4에서 bundle로 새 폴더에 복원해 `npm test`가 통과하는지 1회 확인.
- 저장소 크기: 현재 `data/` 208MB(대부분 `data/runs`의 2MB 안팎 파일). 매매동향 5년치를 받으면 +100MB 남짓. 로컬 git에서는 문제없지만, 1년에 한 번 `git gc --aggressive`를 일정에 넣는다.

### 3.5 공개 사이트

#### 3.5.1 공개 번들 (`ops/lib/publish.mjs` → `dist/`)

지금 GitHub Pages는 저장소 전체를 서비스한다(수집 스크립트·테스트·문서까지 URL로 열림). 이전 후에는 **허용 목록에 있는 파일만** 내보낸다.

| 포함 | 결정 방법 |
| --- | --- |
| `index.html`, `styles.css` | 고정 |
| `app.js` + 브라우저 모듈 | `index.html`의 `<script>`에서 시작해 `import`를 따라가며 자동 수집(현재 20개). 수동 목록이 아니라 그래프로 계산해 누락·과다 포함을 막는다 |
| `data/` | 브라우저가 읽는 경로만: `latest-snapshot.json`, `date-index.json`, `krx-market-holidays.json`, `runs/**`, `daily-history/**`, `investor-flow/**`, `experiments/**`, `next-preview/**`, `preopen-ranking/**`, `daytrade/**`(화면이 쓰는 파일만 — 구현 시 fetch 경로에서 확정) |

빌드 후 **유출 검사**(하나라도 걸리면 공개 중단 + 알림):
- `dist/`에 `scripts/`, `tests/`, `ops/`, `docs/`, `.github/`, `*.sh`, `package.json`, `.env*`, `var/`가 없는지.
- 브라우저 모듈이 `node:` 모듈을 import하지 않는지.
- 모든 파일 25MiB 미만, 전체 파일 수 20,000개 미만(Cloudflare Pages 제한).
- `index.html`이 참조하는 모든 파일이 `dist/`에 있는지(깨진 링크 방지).

#### 3.5.2 호스팅 선택(D1)

| 선택지 | 장점 | 단점 |
| --- | --- | --- |
| **A. Cloudflare Pages 직접 업로드(추천)** `wrangler pages deploy dist --project-name kospi-signal` | 무료, PC가 꺼져도 사이트 유지, 바뀐 파일만 업로드 | Cloudflare 계정·API 토큰 필요. 무료 플랜 배포 횟수 제한이 있을 수 있어 구현 전 확인 필요 → 공개는 디바운스(아래) |
| B. Cloudflare Tunnel로 PC에서 직접 서비스 | 배포 과정 없음, 즉시 반영 | PC가 꺼지면 사이트도 꺼짐, 집 PC가 인터넷에 노출 |
| C. 공개 안 함(로컬 `http://127.0.0.1:8788`) | 가장 단순 | 다른 기기에서 못 봄 |

**공개 주기(A일 때)**: 데이터 커밋이 생기면 `publish` 요청을 디바운스 2분으로 모아서 실행. 하루 예상 10~20회. 장전(08:35 예측) 직후와 09:00 정산 직후는 디바운스 없이 즉시.

#### 3.5.3 모델 코드 노출(D3)

브라우저 모듈에 `daytrade-model.js`, `rank-model.js`, `ridge-model.js`, `forecast-basis.js`가 들어 있다(화면에서 예측 근거를 다시 계산하기 때문). 공개 사이트를 유지하는 한 이 코드는 누구나 볼 수 있다. 숨기려면:
- 화면이 쓰는 계산 결과(근거 값)를 단계 실행 때 JSON에 미리 넣고, 화면은 그 값을 표시만 하도록 바꾼다(`selected-detail.js`, `post-close-overlay.js` 등에서 모델 import 제거).
- 이 작업은 이전과 분리된 별도 작업으로 하고, 이전 단계 1에서는 현재 동작 그대로 공개한다.
- 참고: JS를 압축·난독화하는 건 숨기는 게 아니므로 쓰지 않는다.

#### 3.5.4 URL 변경

- 새 주소 예: `https://kospi-signal.pages.dev` 또는 개인 도메인.
- User-Agent 문자열의 `(+https://kospi-signal.github.io/)`를 새 주소로 교체(`providers/*.js`, `scripts/*.mjs`, 테스트 기대값).
- GitHub 저장소를 지우면 `kospi-signal.github.io`는 사라진다. 이전 기간(단계 3~4) 동안만 옛 주소에 새 주소로 넘기는 안내 페이지를 둔다.

### 3.6 비밀값

| 이름 | 지금 | 로컬 |
| --- | --- | --- |
| `KOSPI_PROVIDER_API_KEY`, `KOSPI_PROVIDER_BASE_URL` | Actions secrets | `secrets.env`(아래) |
| `KOSPI_PUBLIC_SOURCE_NAME/URL/LICENSE_STATUS/LICENSE_URL/ALLOWED_HOSTS` | Actions variables(기본값 있음) | `config.mjs` 기본값 + `secrets.env` 덮어쓰기 |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | 없음 | `secrets.env` — 토큰 권한은 "Pages 편집" 하나만 |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`(선택) | 없음 | `secrets.env` |

- 위치: `%LOCALAPPDATA%\kospi-signal\secrets.env`(저장소 밖). NTFS 권한을 현재 사용자만 읽게 설정(`icacls … /inheritance:r /grant:r %USERNAME%:R`).
- 데몬은 시작 시 읽어 job의 자식 프로세스 환경으로만 넘긴다. 로그에 값이 찍히지 않도록 로그 출력에서 해당 값들을 `***`로 가린다.
- 현재 GitHub secrets 값은 GitHub에서 다시 읽을 수 없다. 이전 전에 원래 값을 직접 확보해야 한다(값을 설정한 적이 없다면 빈 값으로 둔다 — 지금 `naver-crawl` 경로는 이 값을 쓰지 않는다).

### 3.7 검증 (`validation.yml` 대체)

- `pre-commit` 훅(사람이 하는 커밋만, 봇 커밋은 `--no-verify` 대신 `KOSPI_BOT_COMMIT=1`로 건너뜀): 바뀐 파일이 코드면 `npm run check`.
- `pre-push`가 없으므로 대신 **`node ops\run.mjs verify`**: `npm test`, `npm run check`, `npm run collection:audit`, `npm run test:future-clock`, 그리고 "검증이 스냅샷을 수집하지 않았는지"(`git diff --exit-code -- data/latest-snapshot.json data/runs`). 사람이 코드 커밋을 하면 데몬이 자동으로 이 검증을 큐에 넣고 실패 시 알림.
- 공개 직전 검사: §3.5.1 유출 검사 + `npm run check`.

### 3.8 로그·상태·알림

**로그 위치**

```
var\
  logs\daemon-YYYY-MM-DD.log        데몬(스케줄 판단, 큐, 잠금, 공개)
  runs\<runId>\job.log              job 전체 출력(단계 경계 표시 + 각 줄 타임스탬프)
  runs\<runId>\summary.md           GITHUB_STEP_SUMMARY 내용 + 단계 결과 표
  runs\<runId>\meta.json            job, 계기, 시작·종료, 단계별 결과·출력·소요, 종료 코드
  ledger\YYYY-MM.jsonl              실행 장부(한 줄 = 한 실행)
  status.json                       현재 상태(진행 중 job, 대기열, 최근 실패, 마지막 공개, 하트비트)
```

- 기존 스크립트의 진행 로그(`progress-log.js` 형식, UTC + KST + 경과)는 그대로 `job.log`에 들어간다.
- 회전: `logs`는 30일, `runs`는 90일 보관 후 압축, 1년 뒤 삭제. 장부는 영구 보관.

**상태 페이지**: 데몬이 `http://127.0.0.1:8787`(로컬 전용 바인딩)에 간단한 페이지를 띄운다 — 오늘 일정표(단계별 예정/실행/결과), 진행 중 job과 실시간 로그 꼬리, 최근 실패, 마지막 공개 시각, 디스크 여유. Actions 화면을 대신한다.

**알림**(D5)

| 이벤트 | 수단 |
| --- | --- |
| job 실패, 시간 초과, 작업 트리 더러움 | Windows 알림 + Telegram |
| 장전 단계 `missed`(PC가 늦게 켜짐 등) | 같음 |
| 공개 실패, 유출 검사 실패 | 같음 |
| 백업 push 실패 | 하루 1회 묶어서 |
| 하트비트 끊김(데몬 정지) | 별도 감시 작업(작업 스케줄러 10분 주기)이 `status.json` 갱신 시각을 보고 알림 |
| 매일 22:45 일일 요약 | Telegram(선택) |

### 3.9 Windows 운영 설정 체크리스트

| 항목 | 설정 |
| --- | --- |
| 데몬 등록 | 작업 스케줄러: 트리거 "시스템 시작 시" + "로그온 시", "사용자가 로그온했는지 여부에 관계없이 실행", "가장 높은 수준의 권한" 불필요, "작업이 실패하면 1분마다 다시 시작, 최대 999회", "이미 실행 중이면 새 인스턴스 시작 안 함" |
| 감시 작업 | 10분마다 `node ops\status.mjs --check-heartbeat` |
| 전원 | 전원 계획 "절전 안 함", 디스플레이만 끄기. 최대 절전 끄기(`powercfg /hibernate off`). 노트북이면 덮개 닫기 동작 "아무것도 안 함" |
| Windows 업데이트 | 사용 시간 06:00~23:59로 설정(이 시간에 자동 재부팅 안 함). 재부팅 후 데몬 자동 시작 확인 |
| 시계 | `w32tm /config /update /manualpeerlist:"time.windows.com,0x9" /syncfromflags:manual` 후 동기화 주기 1시간. 08:35·09:00·15:31 단계가 분 단위라 중요 |
| 백신 | Windows Defender 실시간 검사에서 `C:\kospi-signal\data`, `var` 제외(대용량 JSON 쓰기 지연 방지) |
| 경로 길이 | `git config --system core.longpaths true` |
| 네트워크 | 네이버 요청이 집 IP에서 나감. 차단되면 집의 다른 기기 네이버 접속도 영향받을 수 있음. 공유기 재부팅으로 IP가 바뀌는지 미리 확인 |
| 디스크 | 여유 20GB 이상 유지. 상태 페이지에 표시, 5GB 미만이면 알림 |
| UPS(선택) | 장중 정전 대비 |

### 3.10 장애 시 동작

| 상황 | 동작 |
| --- | --- |
| 장전에 PC가 꺼져 있었음 | 켜진 시각 기준으로 keeper 계획이 판단: `lastStart` 이전이면 즉시 실행, 지났으면 `missed`로 기록 + 알림(지금과 같은 정책) |
| 09:00/15:31 정산을 놓침 | 23:00까지 늦게라도 실행(같은 날). 다음 날이면 `close-catch-up`이 09:30~14:30에 보충 |
| job 도중 데몬/PC 종료 | 재시작 시 장부의 `running` 항목을 `aborted`로 바꾸고 잠금 해제. 작업 트리가 더러우면 자동 정리하지 않고 알림 → 사람이 `node ops\run.mjs doctor`로 확인(변경 내역 보여 주고 커밋/폐기 선택) |
| 네이버 403/429 | 기존 스크립트 정책 그대로(매매동향은 User-Agent 순환). 실패 알림 |
| 디스크 가득 | job 시작 전 여유 공간 확인(1GB 미만이면 시작 안 함) |
| Cloudflare 장애 | 공개만 실패 처리하고 다음 커밋 때 재시도. 데이터는 로컬에 안전 |

## 4. 코드 변경 목록

### 4.1 새로 만드는 것

| 파일 | 내용 | 규모(대략) |
| --- | --- | --- |
| `ops/daemon.mjs`, `ops/run.mjs`, `ops/status.mjs` | 진입점 3개 | 300줄 |
| `ops/lib/*.mjs` (9개) | §3.2 | 1,200줄 |
| `ops/jobs/*.mjs` (9개) | §3.3 | 900줄 |
| `ops/status-page/` | 정적 HTML 1장 | 200줄 |
| `scripts/stage-daily-experiment.mjs` 진입 래퍼 | `.sh` 대체 | 40줄 |
| `tests/ops-*.test.mjs` | §4.2 | 800줄 |
| `.gitattributes` | `* text=auto eol=lf` | 1줄 |

### 4.2 테스트

- **이식 동등성**: 워크플로우 YAML을 파싱해 각 단계의 `if:` 결과와 job 정의의 `if` 함수 결과가 같은지, 대표 입력 조합(거래일/휴장일, 성공/실패, auto_stage 여부)으로 표 검증. 이전 완료 후 YAML을 지우면 이 테스트도 함께 지운다.
- 호환 계층: `GITHUB_OUTPUT` 파싱(여러 줄 값 포함), 요약 누적.
- 스케줄: 가짜 시계로 하루를 돌려 06:10~22:30 job이 정확히 한 번씩 큐에 들어가는지, PC가 07:50에 켜진 경우 등 놓침 시나리오.
- 잠금: 동시 요청 시 순서, 데몬 재시작 후 고아 잠금 정리.
- 공개: 유출 검사가 `scripts/` 포함 번들을 거부하는지, 브라우저 모듈 그래프가 20개를 모두 찾는지.
- Windows 경로: `path.win32`로 경로 조립 테스트.

### 4.3 수정하는 것

| 파일 | 변경 |
| --- | --- |
| `scripts/backfill-investor-flow.mjs` | `--commit`이 `commit-and-push.sh` 대신 주입된 커밋 함수를 쓰도록 |
| `scripts/stage-experiment-status.mjs`, `stage-daily-experiment.mjs`, `daily-baseline-run.mjs` | `spawnSync("git", …)`은 Windows에서도 PATH의 `git.exe`로 동작. `daily-baseline-run.mjs`의 `git hash-object --path`는 autocrlf가 꺼져 있어야 HEAD와 같은 해시가 나옴(§3.1) — 단계 0에서 확인 |
| User-Agent 문자열 6곳(`providers`·`scripts`) + 테스트 파일 3개 | 새 사이트 주소 |
| `docs/OPERATIONS.md` | "Actions → …" 안내를 `ops\run.mjs` 명령으로 |
| 삭제 | `.github/` 전체, `scripts/commit-and-push.sh`, `scripts/stage-daily-experiment.sh`, `scripts/probe-investor-sources.mjs`의 GitHub 전용 부분 없음(그대로 사용) |

`scripts/scheduler-keeper.mjs`는 `githubClient`가 더 이상 쓰이지 않지만 `planKeeper` 테스트와 함께 남겨 두었다가, 이전 완료 1개월 후 정리한다.

## 5. 이전 절차

각 단계는 "완료 조건"을 만족해야 다음으로 간다.

### 단계 0 — 준비 (GitHub 그대로)
1. 전체 이력 확보: `git clone --mirror https://github.com/kospi-signal/kospi-signal.github.io.git` → 같은 내용으로 `git bundle create kospi-signal-full.bundle --all`. **얕은 복제(shallow)로는 안 됨.** 모든 브랜치·태그 포함 확인(`git rev-list --all --count`가 GitHub의 커밋 수와 같은지).
2. GitHub secrets/variables의 실제 값 확보(§3.6).
3. Windows PC 준비(§3.1, §3.9), Cloudflare 계정·Pages 프로젝트·토큰 발급(D1=A일 때).
- 완료 조건: 번들로 새 폴더에 복원 → `npm ci && npm test` 통과(Windows에서).

### 단계 1 — 오케스트레이터 개발 (GitHub에서 계속 운영하며)
1. `ops/` 구현 + §4.2 테스트. 이때는 아직 GitHub 저장소에서 개발하므로 Actions 운영과 충돌하지 않는다.
2. 공개 번들 빌드 + 유출 검사 구현, Cloudflare에 **임시 프로젝트**로 업로드해 사이트가 같은 화면을 보이는지 확인.
- 완료 조건: 테스트 통과, 임시 사이트에서 오늘 화면이 GitHub Pages와 같음.

### 단계 2 — 그림자 운영 (3거래일 이상)
1. PC에서 데몬을 **`--shadow` 모드**로 실행: job은 전부 돌리되 별도 작업 폴더(`C:\kospi-signal-shadow`, 매일 06:00에 GitHub main으로 갱신)에서, 커밋·공개 없이.
2. 같은 날 GitHub Actions 결과와 비교하는 스크립트(`ops\run.mjs compare --date D`): 단계별 실행 여부·상태, `data/runs/D/*.json`의 행 수와 핵심 필드(예상 시가, 정산 가격) 일치 여부. 수집 시각이 달라 생기는 값 차이는 허용 범위로 보고서에 표시.
3. 매매동향 과거 수집은 이 기간 동안 GitHub에서 끝낸다.
- 완료 조건: 3거래일 연속 모든 단계가 같은 시각대에 실행되고 결과가 일치(차이는 설명 가능한 것만).

### 단계 3 — 전환 (장이 없는 날, 예: 토요일)
1. GitHub에서 모든 워크플로우 비활성화(Actions → 각 워크플로우 → Disable). 진행 중인 실행이 없는지 확인.
2. 최종 동기화: GitHub main을 PC 작업 저장소로 받기 → 원격 `origin` 제거(`git remote remove origin`) → 백업 원격 추가.
3. User-Agent·문서 URL 교체 커밋(§3.5.4).
4. 데몬을 정식 모드로 시작, `publish` 1회 → 새 URL 확인.
5. GitHub Pages의 `index.html`을 "주소가 바뀌었습니다 → 새 주소" 안내로 교체(이 커밋만 GitHub에 push).
6. 월요일 06:10부터 전 단계를 지켜보고 22:45 일일 요약 확인.
- 완료 조건: 월~수 3거래일 정상 운영, 새 사이트 반영 확인.
- **되돌리기**: 문제가 생기면 GitHub 워크플로우를 다시 Enable하고, PC의 새 커밋을 GitHub에 push(원격 다시 추가) — 단계 4 전까지는 언제든 가능.

### 단계 4 — GitHub 정리 (전환 2주 후)
1. 최종 번들을 다시 만들어 백업 2곳에 보관.
2. GitHub 저장소 Private 전환 → 1주 관찰(안내 페이지는 사라짐) → 저장소 삭제.
3. GitHub의 Claude 앱 설치 해제, 개인 접근 토큰·SSH 키 중 이 프로젝트용 삭제, `kospi-signal` 조직 삭제(원하면).
4. 로컬 저장소의 `.github/` 삭제, §4.3 정리 커밋.
- 완료 조건: `git remote -v`에 백업만 남음, 사이트·데몬 정상.

## 6. 위험과 대응

| 위험 | 영향 | 대응 |
| --- | --- | --- |
| PC 한 대에 모든 것이 걸림 | 고장 시 수집 중단 | 백업 2곳 + 복구 절차 문서화, 예비 PC에서 복구 리허설(단계 0) |
| 장전 시각에 PC 꺼짐/업데이트 재부팅 | 장전 단계 `missed` | 전원·업데이트 설정(§3.9), 하트비트 알림 |
| 시계 오차 | 08:35/09:00 판단 오류 | 시간 동기화 주기 1시간, 상태 페이지에 시계 오차 표시 |
| 집 IP 차단 | 수집 중단, 집 네트워크 영향 | 요청 간격 유지, 차단 시 알림 후 수동 판단 |
| 작업 트리 충돌(동시 job) | 잘못된 커밋 | 경로 한정 커밋 + git 잠금 + 시작 전 깨끗함 확인 |
| 공개 번들에 비공개 파일 포함 | 코드 유출 | 허용 목록 방식 + 유출 검사 실패 시 공개 중단 |
| 모델 코드가 공개 사이트에 실림 | "완전 비공개" 미달 | D3 별도 작업(§3.5.3) |
| Cloudflare 무료 플랜 제한 | 공개 실패 | 디바운스, 제한 확인 후 필요 시 유료 또는 B안 |
| 비밀값 유실 | 일부 공급자 사용 불가 | 단계 0에서 값 확보, 백업 번들과 분리 보관 |

## 7. 작업량 추정

| 단계 | 작업 | 기간(대략) |
| --- | --- | --- |
| 0 | 백업·PC 설정·계정 | 반나절(사용자) |
| 1 | `ops/` 구현·테스트·공개 빌드 | 3~5일 |
| 2 | 그림자 운영 + 비교 | 3~5거래일 |
| 3 | 전환 | 반나절 + 3거래일 관찰 |
| 4 | 정리 | 2주 후 1시간 |
| (별도) | D3 모델 코드 비공개화 | 1~2일 |
