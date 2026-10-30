# CHANSDAY KOSPI Signal Board

정적 GitHub Pages 프론트엔드로 KOSPI 장전 예측 순위를 기록하고, 장 마감 뒤 실제 결과와 오차를 비교하는 공개 관찰판입니다.

- 사이트: <https://chansday.github.io/>
- 예상값은 정보 기록과 비교를 위한 값이며 정확도·수익·투자 결과를 보장하지 않습니다.
- 자동매매, 주문, 브로커 연동, 거래 실행 기능은 구현하지 않습니다.

## 목차

- [동작 개요](#동작-개요)
- [수익률·평가 정의](#수익률평가-정의)
- [데이터 출처와 수집 원칙](#데이터-출처와-수집-원칙)
- [실행 일정](#실행-일정)
- [화면 모드](#화면-모드)
- [구조](#구조)
- [로컬 실행과 검증](#로컬-실행과-검증)
- [상세 문서](#상세-문서)
- [라이선스·위험 고지](#라이선스위험-고지)

## 동작 개요

거래일마다 GitHub Actions가 다섯 단계를 순서대로 실행하고, 결과를 `data/runs/YYYY-MM-DD/`와 `data/latest-snapshot.json`에 커밋합니다.

| 단계 | KST | 기록 내용 |
| --- | --- | --- |
| 일봉 선행 수집 | 06:10 (실패 시 07:10 재시도) | 직전 거래일까지의 종목별 Naver 일봉 |
| `update-results` | 07:00 | 전일 EOD 결과 |
| `analysis` | 08:00 | 당일 기초 분석 |
| `forecast` | 08:20 | 예상 시가·예상 종가와 근거 |
| `open-settlement` | 09:00 | 실제 시가 |
| `close-settlement` | 15:30 | 실제 시가·종가·거래량, 사후 평가 |

- 예상 시가는 장전 quote 시가를 우선하고, 없으면 직전 3거래일 일봉의 시가 갭으로 계산합니다.
- 예상 종가는 매일 재학습하는 순위 ridge 모델 등으로 계산합니다. 모델과 근거 필드는 [docs/EVALUATION.md](docs/EVALUATION.md)에 있습니다.
- 주말과 KRX 휴장일에는 수집·계산·저장을 건너뜁니다. 휴장 여부를 확인할 수 없는 연도는 안전하게 실패합니다.
- 장 마감 후에는 직전 3거래일 공개 일봉으로 사후 평가(`retrospective-*.json`)를 만들어 예측 시트에 연결합니다. 이 값은 장전에 기록된 예측이 아니라 장 마감 후 재현한 기준선입니다.

## 수익률·평가 정의

- `expected_return = (expected_close / expected_open - 1) × 100`은 예상 시가와 예상 종가가 모두 있을 때만 계산합니다. 예상 종가 모델이 없으면 `expected_return`과 `error`는 `null`/`no_data`입니다.
- `session_return = (actual_close / actual_open - 1) × 100`은 실제 시가→실제 종가 기준입니다.
- `error = session_return - expected_return`입니다.
- `intraday_reference_return`은 별도 실행시점 참고값이며 `expected_return`과 구분합니다.
- 화면의 `종목 평가` 열은 반올림하지 않은 예상 수익률의 당일 백분위 점수(0–100, 소수 셋째 자리)입니다. 높을수록 예상 수익률이 높고, 동률은 평균 순위를 나눠 갖습니다. 계산은 [`providers/evaluation-score.js`](providers/evaluation-score.js) 한 곳에서 파이프라인과 브라우저가 함께 사용합니다.
- snapshot의 `evaluation` 요약은 오차 지표(MAE·RMSE·평균 오차)와 순위 지표 `ranking_metrics`(rank IC, 적중률, 보정 기울기, 상위 20 초과수익, 점수 10분위)를 기록합니다.
- 모든 필드는 [JSON Schema](schema/market-snapshot.schema.json)로 숫자 또는 `null`을 검증합니다.

공식, 반올림 규칙, 사후 평가 overlay 처리는 [docs/EVALUATION.md](docs/EVALUATION.md)를 참고하세요.

## 데이터 출처와 수집 원칙

운영 provider는 `naver-crawl`입니다. Naver 공개 polling·일봉 endpoint는 공식 API가 아니며 이용정책과 재배포 권한이 확인되지 않았습니다.

- source metadata는 `license_status=unconfirmed`를 유지하고 snapshot에 출처 경고를 남깁니다.
- 일봉의 시장·조정 기준과 보통주 분류가 확인되지 않아 운영 단계는 `partial`로 표시합니다. 우선주가 포함될 수 있습니다.
- 모든 요청 전에 robots.txt를 확인합니다. 403·429·challenge·Retry-After 응답에서는 즉시 중단하고 우회하거나 재시도하지 않습니다.
- 지연·빈 응답·차단은 `no_data`/`degraded`/`blocked`로 기록합니다. fixture, demo, 이전 snapshot을 대체값으로 쓰지 않습니다.
- 통화는 KRW, 시간대는 `Asia/Seoul`입니다.

endpoint, robots 확인 결과, 종목 목록 파일, timeout과 freshness 규칙은 [docs/OPERATIONS.md](docs/OPERATIONS.md)에 있습니다.

## 실행 일정

stage workflow에는 schedule cron이 없습니다. GitHub schedule 이벤트가 수 시간씩 지연된 실측(2026-10-28) 때문에, `[5 관리] scheduler keeper`가 KST 정시까지 기다렸다가 각 stage를 `workflow_dispatch`로 시작합니다.

수동 실행은 Actions에서 다음 버튼을 사용합니다. 입력값은 비워 둡니다.

| 목적 | 버튼 |
| --- | --- |
| 현재 시각에 맞는 단계 하나 실행 | `[4 수동] run now (현재 시각 단계)` → **Run workflow** |
| 특정 거래일의 전체 단계 순서 실행 | `[4 수동] run all now (전체 단계)` → **Run workflow** (`run_date` 입력) |
| 특정 단계만 실행 | `[2 단계] 08:20 forecast`, `[2 단계] 09:00 open-settlement`, `[2 단계] 15:30 close-settlement` 등 |
| 누락된 마감 정산 보충 | `[3 보충] 누락 마감 정산 catch-up` |

keeper 동작, 중복 방지, 거래일 guard, 연간 휴장일 갱신은 [docs/OPERATIONS.md](docs/OPERATIONS.md)를 참고하세요.

## 화면 모드

| 주소 | 용도 |
| --- | --- |
| `/` | 최신 운영 snapshot. provider가 정확히 `no_data`일 때만 historical-test 결과로 fallback |
| `?mode=historical-test&date=YYYY-MM-DD` | 공개 일봉 기반 검증용 과거 snapshot (TEST ONLY) |
| `?mode=replay&date=…`, `?mode=backfill-test&date=…`, `?mode=fixture&date=…` | 합성 데이터 기반 UI·계약 확인 |
| `?mode=demo` | 숫자 없는 UI demo |

`조회 날짜` 달력은 현재 `mode`를 유지한 채 `date`만 바꿉니다. 테스트 모드와 달력 상태 규칙은 [docs/TEST_MODES.md](docs/TEST_MODES.md)에 있습니다.

## 구조

```text
.
├─ index.html, app.js, styles.css      정적 화면
├─ providers/                          수집 adapter, 예측 모델, 평가 계약 (브라우저·파이프라인 공용)
├─ scripts/                            stage 실행, 수집, scheduler, 검증 스크립트
├─ schema/market-snapshot.schema.json  snapshot 계약
├─ data/
│  ├─ latest-snapshot.json             최신 운영 run 복사본
│  ├─ date-index.json                  날짜별 조회 인덱스
│  ├─ runs/YYYY-MM-DD/                 stage 파일 {0700,0800,0820,0900,1530}.json, retrospective-*.json
│  ├─ runs/historical-test/            검증용 과거 snapshot
│  ├─ daily-history/                   일봉 선행 수집 캐시
│  ├─ kospi-universe.json              KOSPI 종목 목록
│  └─ krx-market-holidays.json         KRX 휴장일 달력
├─ tests/                              node:test 테스트
├─ docs/                               상세 문서
└─ .github/workflows/                  stage·scheduler·검증 workflow
```

## 로컬 실행과 검증

정적 JSON을 읽으므로 파일을 직접 열지 말고 HTTP 서버를 사용합니다.

```bash
python -m http.server 4173
```

```bash
npm test
```

```bash
npm run check
```

```bash
npm run pipeline:dry-run
```

실제 snapshot을 바꾸지 않는 단계별 dry-run:

```bash
node scripts/update-results.mjs --mode forecast --dry-run
```

## 상세 문서

| 문서 | 내용 |
| --- | --- |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 데이터 출처, Naver crawl·robots 정책, 일봉 선행 수집, Actions·scheduler keeper, 거래일 guard, Pages 운영 |
| [docs/EVALUATION.md](docs/EVALUATION.md) | 사후 평가 범위, 종목 평가 점수, 예상값 근거 필드, 종가 예측 모델, 순위 지표 |
| [docs/TEST_MODES.md](docs/TEST_MODES.md) | 날짜 달력, historical-test, replay, backfill, fixture, 일봉 기준가 실험 |
| [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md) | 상태 전이와 보안 경계 |
| [docs/COLLECTION_AUDIT.md](docs/COLLECTION_AUDIT.md) | 수집 감사 |
| [docs/HISTORICAL_STAGE_VERIFICATION.md](docs/HISTORICAL_STAGE_VERIFICATION.md) | historical-test 단계 검증 보고서 |

## 라이선스·위험 고지

이 저장소는 데이터 공급자의 라이선스를 대신하지 않습니다. 데이터 수집·저장·재배포 가능 여부는 원출처 약관과 관련 법규를 따라야 합니다. 이 사이트의 예상·실제 비교·오차는 투자 조언이 아니며 미래 수익, 정확도 또는 손실 회피를 보장하지 않습니다.
