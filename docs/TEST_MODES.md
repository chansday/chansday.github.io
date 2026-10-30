# 화면 조회와 테스트 모드

[README](../README.md)에서 분리한 화면 조회 방식과 운영 데이터와 분리된 테스트·실험 모드 상세입니다.

## Historical-test / TEST ONLY

기본 화면은 최신 운영 스냅샷을 표시합니다. live provider가 정확히 `no_data`일 때만 `data/runs/historical-test/YYYY-MM-DD/1530.json`을 읽어 표시하며, `partial`·`degraded`·stale 상태에서는 운영 상태를 그대로 유지합니다. fallback 화면의 최상단 라벨은 정확히 `TEST ONLY · HISTORICAL BASELINE · NOT LIVE`입니다. historical-test 날짜별 화면은 다음 주소로 별도 확인할 수 있습니다.

- `https://chansday.github.io/?mode=historical-test&date=2026-10-22`
- `https://chansday.github.io/?mode=historical-test&date=2026-10-23`

## 날짜별 조회 달력

종목 비교 제목 오른쪽의 `조회 날짜 YYYY.MM.DD` 버튼은 현재 URL의 `mode`를 유지한 채 `date=YYYY-MM-DD`를 갱신합니다. 예를 들어 `?mode=historical-test&date=2026-10-22`에서 2026-10-23을 고르면 `?mode=historical-test&date=2026-10-23`을 직접 읽습니다. 선택한 파일이 없으면 이전 날짜의 행을 재사용하지 않고 `미수집`으로 비웁니다.

- `결과 있음`: `data/date-index.json`의 mode별 `availableDates`에 있고, 실제 파일이 존재하는 날짜입니다.
- `조회 중`: 새 날짜 파일을 읽는 동안 표시합니다. 요청 토큰으로 늦게 도착한 이전 응답이 새 날짜를 덮지 못하게 합니다.
- `미수집`: 날짜 인덱스에 실제 stage 파일이 없습니다. 운영 provider는 `data/runs/YYYY-MM-DD/1530.json`, historical-test는 `data/runs/historical-test/YYYY-MM-DD/1530.json`을 기준으로 합니다.
- `휴장일`: [`data/krx-market-holidays.json`](../data/krx-market-holidays.json)의 KRX 휴장일과 주말입니다. 날짜 버튼은 비활성화되고 상태 문구를 함께 표시합니다.
- `오류`: 유효하지 않은 날짜·스냅샷 계약 위반·읽기 실패입니다. 이 경우에도 이전 순위는 유지하지 않습니다.

`data/date-index.json`은 [`scripts/generate-date-index.mjs`](../scripts/generate-date-index.mjs)가 `data/runs` 및 mode별 fixture/replay/backfill 폴더를 스캔해 생성합니다. 새 run stage를 추가할 때는 이 인덱스를 갱신하고, 브라우저는 mode별 실제 경로를 다시 읽습니다. 달력은 색상뿐 아니라 `결과 있음·조회 중·미수집·휴장일·오류` 텍스트, `aria-selected`, `aria-disabled`, `aria-live`로 상태를 전달합니다. 모바일에서는 860px 이하에서 제목·달력·컨텍스트가 줄바꿈되고 달력 폭은 viewport 안으로 제한됩니다.

화면의 `EXPECTED` 열은 실제 예측값이 아니라 사후 계산한 baseline이고, `ACTUAL` 열은 공개 일봉의 실제 시가·종가·거래량입니다. `종목 평가`(예상 수익률의 당일 백분위 점수)는 예상 시가→예상 종가가 확인된 경우에만 표시하며, `실제 장중 수익률`은 실제 시가→실제 종가로 계산합니다. fallback에서는 실제 run의 필드를 그대로 로드하며 숫자를 합성하지 않습니다. `TEST ONLY · HISTORICAL BASELINE · NOT LIVE` 또는 명시적 모드의 `HISTORICAL-TEST / TEST ONLY` 라벨, 출처 URL, 수집일, 범위, 행 수를 화면에 함께 표시합니다.

historical baseline은 직전 5개 거래일의 공개 일별 종가만 사용합니다. `prior_close`는 화면에서 보이지 않는 기준값으로, 계산 재현과 감사에만 저장합니다. `features`에는 전일 수익률, 최근 3개 수익률 평균(momentum), 최근 4개 수익률의 모집단 표준편차(volatility)를 함께 저장합니다.

```text
forecast input through 2026-10-22:
  returns         = each prior close / previous close - 1
  momentum        = mean(last 3 daily returns)
  volatility      = population standard deviation(last 4 daily returns)
  open_signal     = clamp(round(0.60 × momentum - 0.10 × volatility, 2), -5%, +5%)
  expected_open   = round(prior_close × (1 + open_signal / 100), 2)
  expected_close  = null (no close forecast is available from this input)
  expected_return = null (expected_close is unavailable)
  session_return  = (actual_close / actual_open - 1) × 100
  error           = null (expected_return is unavailable)
```

2026-10-22 forecast는 `10-15, 10-16, 10-19, 10-20, 10-21`, 2026-10-23 forecast는 `10-16, 10-19, 10-20, 10-21, 10-22` 공개 daily CSV를 사용합니다. 대상 날짜의 actual 값은 forecast 입력에 사용하지 않습니다. 이 입력에는 예상 종가 모델이 없으므로 `expected_close`와 `expected_return`은 `null`입니다. 당시 08:20에 실제로 게시된 예측이 아니고 과거 운영 성과나 수익을 보장하지 않습니다. `confidence`는 pre-open quote 부재 정책에 따라 `null`입니다.

원본을 다시 수집하고 두 스냅샷을 재생성하는 명령은 다음과 같습니다. 실제 API 키·주문·자동매매는 필요하지 않습니다.

```bash
npm run historical-test:collect
```

이 경로는 평일 운영 cron, `KOSPI_PROVIDER`, `naver-crawl` 운영 수집, 기존 합성 fixture/replay/backfill 파일과 분리되어 있습니다.

## Baseline replay 모드

2026-10-22·23 baseline replay는 전일 종가 기준 입력 계약, 예상값, 실제값, 오차 열을 검증하기 위한 합성 시뮬레이션입니다. 당시 08:20 입력 스냅샷이나 실제 시장값을 복원하지 않으며, 두 파일 모두 `mode=replay`, `provider.id=replay_baseline`, `meta.replay_type=replay_baseline`, `meta.isDemo=true`를 유지합니다.

브라우저에서 다음 주소로 확인할 수 있습니다.

- `https://chansday.github.io/?mode=replay&date=2026-10-22`
- `https://chansday.github.io/?mode=replay&date=2026-10-23`

로컬 검증 명령은 다음과 같습니다.

~~~bash
npm run replay:dry-run -- --date 2026-10-22
npm run replay:dry-run -- --date 2026-10-23
~~~

## 오늘 전용 backfill 테스트

2026-10-26의 backfill 테스트는 운영 data/latest-snapshot.json, 실제 provider 설정, 평일 Actions cron과 엄격히 분리되어 있습니다. 다음 주소는 기존 합성 replay의 expected_open/close/return 및 actual_open/close/error 숫자 흐름을 테스트 입력으로 채운 화면을 엽니다.

- https://chansday.github.io/?mode=backfill-test&date=2026-10-22
- https://chansday.github.io/?mode=backfill-test&date=2026-10-23

스냅샷은 mode=backfill_test, provider.id=backfill-test, meta.isDemo=true, meta.backfill=true를 사용하며 화면에 TEST ONLY / BACKFILL 라벨을 표시합니다. 08:20 KST 실제 원천 스냅샷이 없으므로 과거 08:20 예측을 재구성하지 않았고, 미래 데이터 누수를 막기 위해 날짜를 두 테스트 날짜로만 제한합니다. 숫자는 실제 금융 데이터·실적·예측 성과가 아닙니다.

두 날짜를 실제 파일에 쓰지 않는 dry-run으로 확인합니다.

~~~bash
npm run backfill:dry-run -- --date 2026-10-22
npm run backfill:dry-run -- --date 2026-10-23
~~~

이 경로는 2026-10-26 테스트 전용입니다. 2026-10-27부터 운영 모드는 backfill/replay가 아니라 설정된 실제 provider를 사용해야 하며, 실제 provider가 없거나 출처·라이선스가 확인되지 않으면 기존 정책대로 no_data/degraded를 유지합니다. backfill 테스트는 cron에 연결되지 않습니다.

## Historical-test 단계 누적 검증

실제 공개 일봉 기반 historical-test를 운영 latest와 분리한 상태로 07:00·08:00·08:20·09:00·15:30 파일에 기록하려면 다음 명령을 사용합니다.

```text
npm run historical-test:pipeline
npm run historical-test:verify
```

파일은 `data/runs/historical-test/YYYY-MM-DD/{0700,0800,0820,0900,1530}.json`에 생성되며, 순서 변경 검증과 결과 보고서는 `docs/HISTORICAL_STAGE_VERIFICATION.md`에 기록합니다. 모든 파일은 `test_only=true`, `historical_test=true`이며 `data/latest-snapshot.json`을 갱신하지 않습니다.

각 historical-test snapshot에는 화면이 평가 결과를 평면 필드 추측 없이 사용할 수 있도록 top-level `evaluation` 계약도 포함됩니다. `evaluation.target`은 `expected_return`(예측), `session_return`(실제), `error`(오차)의 정규화된 필드 매핑과 `session_return - expected_return` 공식을 선언합니다. 현재 historical 입력에는 expected close가 없어 모든 단계가 `pending`이며, 두 값이 모두 존재하는 별도 snapshot만 `evaluated`가 됩니다. `sample_count`, `evaluated_sample_count`, `missing_sample_count`, `evaluation_range`, MAE/RMSE/평균 오차 집계 및 `test_only=true`, `dataset=historical_test`를 함께 기록합니다.

원본 JSON의 `expected_open`, `expected_close`, `expected_return` 값은 저장 정밀도를 그대로 보존합니다. 화면 표시가 필요할 때만 `evaluation.display_policy`의 `maximum_fraction_digits=0`, `rounding=half_up` 정책을 사용해 소수점 없는 표시값을 만들며, 이 정책은 저장값·실제값·오차 계산을 변경하지 않습니다.

이 평가 메타데이터는 `data/historical-test/`와 `data/runs/historical-test/`에만 생성됩니다. 운영 `data/latest-snapshot.json`에는 historical-test 평가를 병합하지 않으며, historical-test fallback도 원본 `evaluation`을 보존하면서 `meta.historical_fallback`으로만 표시합니다. `providers/provider-adapter.js`는 historical-test snapshot에 test-only 평가 계약이 없거나 표본수가 행 수와 다르면 로드를 거부합니다.

## 합성 fixture 모드

data/fixtures/2026-10-22.json과 data/fixtures/2026-10-23.json은 UI·스키마·정산 흐름을 확인하기 위한 합성 fixture입니다. 두 파일 모두 provider.id=fixture, mode=fixture, meta.isDemo=true를 명시하고, FIXTURE / SYNTHETIC ONLY 라벨과 fixture_synthetic 품질을 사용합니다. 값은 실제 종목·가격·수익률이 아니며, 실제 08:20 KST 입력 스냅샷이 없으므로 역사적 예측을 사후 재구성한 자료도 아닙니다.

운영 cron은 fixture를 사용하지 않습니다. fixture 확인은 로컬 dry-run으로만 수행합니다.

~~~
node scripts/update-results.mjs --provider fixture --fixture-date 2026-10-22 --mode forecast --dry-run
npm run pipeline:dry-run -- --provider fixture --fixture-date 2026-10-23
~~~

브라우저에서는 ?mode=fixture&date=2026-10-22 또는 ?mode=fixture&date=2026-10-23을 사용합니다. 화면에는 FIXTURE / SYNTHETIC ONLY와 SYN 접두사가 표시됩니다.

## 일봉 기준가 실험

정시 forecast 및 run-all은 `providers/daily-baseline-experiment.js`를 호출하고, 결과를 운영 snapshot과 별도인 `data/experiments/YYYY-MM-DD-{before-open,during-market}.json`에 최초 기록만 저장합니다. 화면의 독립 실험 영역에서 날짜와 종목을 선택합니다. 현재 거래일 장전 또는 장중에 실제로 수집한 과거 일봉 세 개를 사용하며, 가장 최근 일봉의 종가를 **예상시가가 아닌 추정 기준가**로 둡니다. 예상 종가는 기준가에 세 일봉의 종가/시가 수익률 평균을 적용한 실험값입니다. 필요한 거래일 파일이 HTTP 404면 최대 한 거래일만 건너뛰고 `stale`과 누락 날짜를 기록합니다. 기타 오류·차단, 두 거래일 결측, 장 마감 후, 과거 대상일, 수집 중 시장 단계 변경은 실패로 처리합니다. 실험 행에는 `expected_open`, `actual_open`, `actual_close`, `error` 필드를 저장하지 않습니다.

최근 실험 시도 상태는 별도 `data/experiments/YYYY-MM-DD-status.json`에 저장하며 재시도 때 갱신합니다. 상태 기록이 없으면 미실행 또는 기록 누락으로 표시하고, robots 차단·데이터 부족·수집 실패는 구분합니다. 기존 예측은 덮어쓰지 않으며 운영 snapshot과 실험의 성공 여부는 별도로 보고합니다. 상태 저장 실패도 workflow 실패로 표시합니다.

예측 파일 저장 후 상태 저장이 실패하면 같은 checkout의 재시도에서 기존 예측을 검증하고 미추적 상태일 때만 게시 후보로 선택합니다. 추적 중인 예측은 변경하지 않습니다. 파일 생성은 같은 디렉터리의 임시 파일과 원자적 링크 생성으로 충돌 시 기존 파일을 보존하며, 링크를 지원하지 않는 파일시스템은 실패합니다. 상태 파일의 게시 자체가 실패하거나 checkout이 사라지면 웹 화면에 실패를 알릴 수 없으므로 Actions 로그 확인과 재실행이 필요합니다.
