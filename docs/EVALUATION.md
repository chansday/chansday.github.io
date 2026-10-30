# 예측·평가 계약

[README](../README.md)에서 분리한 예측값·평가 상세입니다. 수익률·오차 정의, 종목 평가 점수, 순위 지표, 예상값 근거 필드를 다룹니다.

## 사후 평가 범위와 운영 원칙

장 마감 후 당일 수동 `run-all`은 직전 3거래일의 공개 일봉으로 별도의 사후 평가를 만듭니다. 최근 2개 갭 `(당일 시가 / 전일 종가 - 1)`의 평균을 ±5%로 제한해 직전 종가에 적용하여 예상 시가를 만들고, 최근 3개 일중 수익률 `(종가 / 시가 - 1)`의 평균을 ±5%로 제한해 예상 시가에 적용하여 예상 종가를 만듭니다. 예상 수익률과 실제 시가→종가 수익률 및 오차는 기존 평가 계약을 사용합니다. 당일 실제 시가·종가는 평가에만 사용하며, 입력 이력이나 당일 가격이 없으면 해당 종목을 평가에서 제외합니다. 이 값은 장전 당시 기록된 예측이 아니라 장 마감 후 재현한 기준선입니다. 일봉 최초 공개시각·수정 여부·이용 권리는 확인되지 않았고, 모형의 정확도는 검증되지 않았습니다. 이력 확보가 차단되거나 평가 가능한 종목이 없으면 수동 실행은 실패를 보고합니다.

지난 거래일을 수동 실행할 때는 저장된 해당 날짜의 정상 Naver 마감 정산 스냅샷을 확인한 뒤 사후 평가만 수행합니다. 정산 스냅샷은 덮어쓰지 않으며, 저장된 정산값이 없거나 날짜·출처가 맞지 않으면 실패합니다. 이미 저장된 유효한 사후 평가는 보존합니다.

기존 정시 워크플로의 시각과 단계는 유지합니다. 거래일의 `close-settlement` 정시·수동 실행과 장 마감 이후 `run now`도 정산이 정상 완료되면 같은 사후 평가 엔진을 실행하고 기존 예측 시트에 결과를 연결합니다. 주말과 KRX 휴장일에는 공용 실행기가 수집·계산·저장을 건너뜁니다. 휴장 여부를 확인할 수 없는 연도는 안전하게 실패합니다.

- 운영 provider의 보통주·우선주 분류는 미확인이고 우선주가 포함될 수 있습니다. 이번 historical-test는 공개 원본에 security type이 없어 `mrktCtg=KOSPI` 전체 913행을 그대로 저장했으며, 이 예외를 화면과 메타데이터에 명시합니다.
- 운영 quote의 시장 표기와 일봉의 시장·조정 기준은 독립적으로 확인되지 않았습니다. 관측·계산값은 원본과 출처 경고를 표시하며, 일봉과 정규시장 quote의 시장 범위가 다를 수 있습니다. 통화는 KRW, 시간대는 `Asia/Seoul`입니다.
- `expected_return = (expected_close / expected_open - 1) × 100`은 예상 시가와 예상 종가가 모두 있을 때만 계산합니다. 예상 종가 모델이 없으면 `expected_return`과 `error`는 `null`/`no_data`입니다. `session_return = (actual_close / actual_open - 1) × 100`은 실제 시가→실제 종가 기준입니다. `intraday_reference_return`은 별도 실행시점 참고값이며 `expected_return`과 구분합니다. 모든 필드는 JSON Schema로 숫자 또는 `null`을 검증합니다.
- 화면의 `종목 평가` 열(이전 `예상 수익률` 열)은 예상 수익률 자체가 아니라 그 날 snapshot 안에서의 백분위 점수 0–100을 소수 셋째 자리(예: `87.342`)로 표시합니다. 입력은 반올림하지 않은 `expected_return_raw = (expected_close / expected_open - 1) × 100`이고, 값이 있는 종목 수를 N, 자신보다 낮은 종목 수를 L, 자신과 정확히 같은 종목 수(자신 포함)를 E라 할 때 `score = (L + 0.5 × (E - 1)) / (N - 1) × 100`(평균 순위 백분위, `(평균 오름차순 순위 - 1) / (N - 1) × 100`과 같음)입니다. 예상 수익률이 높을수록 점수가 높고, 최고 단독 값은 100, 최저 단독 값은 0, 동률은 차지한 순위의 평균을 나눠 갖습니다. N = 1이면 50입니다. 예상 시가·예상 종가가 없는 종목은 N에서 제외되고 `—`로 표시됩니다. 마우스를 올리면 `885종목 중 113위 · 원래 값 +0.0371%`처럼 내림차순 순위(동률은 `공동`)와 반올림하지 않은 원래 예상 수익률(소수 넷째 자리)을 보여 줍니다. 정렬 키 `expectedReturn`(종목 평가 높은 순)은 같은 원값 순서를 사용합니다.
- 계산은 `providers/evaluation-score.js` 한 곳에 있으며 파이프라인과 브라우저가 함께 사용합니다. `update-results.mjs`와 `close-catch-up.mjs`는 snapshot을 쓸 때마다 최종 행 전체로 선택 필드 `expected_return_raw`, `evaluation_score`(half-up 소수 셋째 자리 반올림), `evaluation_score_rank`, `evaluation_score_count`를 다시 계산해 저장합니다. 기존 `expected_return`(소수 둘째 자리)과 `error = session_return - expected_return` 평가 계약은 바뀌지 않습니다. 화면은 표시 중인 행(사후 평가 overlay 적용 후 포함)의 `expected_open`/`expected_close`로 같은 함수를 실행해 점수를 그리므로, 이 필드가 없는 과거 snapshot도 같은 방식으로 표시됩니다.
- 사후 평가 overlay를 적용한 뒤에는 저장된 `evaluation_*`·`expected_return_raw` 필드가 갱신되지 않으며, 화면이 표시 행으로 다시 계산한 점수를 보여 줍니다. 점수는 정수 연산 `round_half_up((2L + E - 1) × 100000 / (2 × (N - 1)))`(0.001 단위)으로 반올림하며, 터치 기기에서도 보이도록 모바일 카드와 상세 패널에 `113위/885 · +0.0371%` 형식의 순위·원래 값을 함께 표시합니다.
- 예상은 정보 기록과 비교를 위한 값이며 정확도·수익·투자 결과를 보장하지 않습니다.
- 자동매매, 주문, 브로커 연동, 거래 실행 기능은 구현하지 않습니다.
- Naver 공개 웹 크롤링은 출처와 비공식·지연 가능성을 화면과 snapshot metadata에 표시하며, 403/429/CAPTCHA·challenge·HTML 응답은 즉시 중단합니다. HTML 우회, rate-limit 우회, 무한 재시도는 하지 않습니다.
- `?mode=demo`는 UI/스키마 확인 전용이며 금융 실측값이나 예측 성과를 의미하지 않습니다.

## 예상 시가 출처

운영 행의 `expected_open_source`는 장전 호가 기록(`preopen_quote`), 장전 계산(`preopen_history`), 또는 장중·장후 사후 계산(`retrospective_history`)을 구분합니다. 장전 기록을 우선 보존하며 장중 현재가와 실제 시가는 예상 시가로 사용하지 않습니다. 장전 기록이 없으면 직전 3거래일 공개 일봉의 시가와 종가로 기존 사후 모델의 평균 시가 갭(±5% 제한)을 전일 종가에 적용합니다. 이력의 날짜와 수집 시각을 저장하고 화면에 표시합니다. 사후 계산은 장전에 실제 기록된 예측이 아닙니다. 필요한 이력이 없거나 출처 접근이 거부되면 해당 예상 시가는 데이터 없음이며, 원인과 상태는 source metadata와 메시지에 기록됩니다. 공개 일봉의 발행 시각·수정 여부·권리는 확인되지 않았습니다. 예상 수익률 계산식은 기존 그대로 유지합니다.

동일 run-all 실행에서 앞 단계가 수집한 장전 기록은 현재 단계의 실제 수집 시작 시각까지 인정하며, run-start 이후 기록은 동일 run ID일 때만 이어받습니다. 차단·오류 재실행은 이미 존재하는 최신 snapshot과 단계 파일을 덮어쓰지 않고 실패 상태와 원인을 실행 결과에 남깁니다.

## 예상값 근거 필드

`prior_close`는 polling quote의 종가에서 부호 있는 전일 대비(`compareToPreviousClosePriceRaw`, 하락 시 음수)를 뺀 정규시장 기준가이며 `prior_close_source=naver_polling_close_minus_change`로 표시합니다. 방향 코드(`compareToPreviousPrice.code`)와 부호가 맞지 않거나 값이 없으면 null입니다(이전에는 하락 종목에서 현재가가 저장되던 결함이 있었습니다). Naver 일봉 chart의 종가는 정규시장 종가와 다를 수 있어(예: 2026-10-26 005930 chart 213,500 vs 공개 CSV 213,000) `prior_close`로 쓰지 않고, 일봉 모델이 실제로 쓴 값은 `expected_open_basis.inputs.prior_close`에만 남깁니다. 기준가에서 시가가 형성되는 종목은 `prior_close == actual_open`이 정상입니다.

운영 행은 예상값과 함께 실제 계산에 쓴 입력만 저장합니다([`providers/forecast-basis.js`](../providers/forecast-basis.js)). 새 수치를 만들지 않으며, 행 계약([`providers/provider-adapter.js`](../providers/provider-adapter.js))은 저장된 입력으로 값을 다시 계산해 일치하지 않으면 행을 거부합니다.

- `expected_open_basis` (`expected_open_source`와 함께만 존재)
  - `naver_preopen_quote_open_v1`: 장전 quote의 시가(`open_price`), `quote_at`, `market_status=PREOPEN`. 계산식 없음.
  - `prior_3_sessions_open_gap_mean_capped_5pct`: 직전 거래일 종가(`prior_close_date`, `prior_close`), 두 시가 갭(`gaps[]`: 날짜·시가·앞 날짜·앞 종가·비율), `mean_gap`, ±5% 제한 후 `applied_gap`, `cap`. 예상 시가 = `prior_close × (1 + applied_gap)` (소수 둘째 자리 반올림).
- `expected_close_basis` (일봉 기반 예상 시가에만): `model`, `history_dates`, `inputs`로 구성되며 모델은 아래 [종가 예측 모델](#종가-예측-모델) 중 하나입니다. 장 마감 후 사후 평가는 `prior_3_sessions_gap_and_session_mean_capped_5pct`를 사용합니다. 세 거래일 장중 수익률(`session_returns[]`: 날짜·시가·종가·비율), `mean_session_return`, ±5% 제한 후 `applied_session_return`. 예상 종가 = `expected_open × (1 + applied_session_return)`. 장전 quote 시가에는 종가 모델이 없어 `expected_close`는 null입니다.
- 예상 시가·근거·예상 종가·종가 근거는 한 묶음으로 09:00 open-settlement와 15:30 close-settlement 병합에서 보존되며, 다른 run의 값과 섞이지 않습니다. 장전 근거가 없는 장중 현재가 기준값은 기존대로 제거되고, 그 값에서 파생된 종가 근거도 함께 제거됩니다.
- 장 마감 후 사후 평가 파일(`data/runs/YYYY-MM-DD/retrospective-*.json`)의 행에도 같은 두 근거 필드가 기록됩니다.
- 기존 `data/runs` 파일은 다시 쓰지 않으므로 이전 날짜에는 근거 필드가 없습니다.

## 종가 예측 모델

운영 예상 종가는 [`providers/forecast-basis.js`](../providers/forecast-basis.js)가 그날 사용할 수 있는 모델 하나로 계산합니다. 같은 날의 모든 예상 수익률이 같은 척도를 갖도록, 그날 모델이 점수를 내지 못한 종목은 다른 모델로 대체하지 않고 `expected_close = null`입니다.

| 우선순위 | 모델 ID | 정의 | 요약 |
| --- | --- | --- | --- |
| 1 | `ridge_rank_11_features_60_sessions_v1` | [`rank-model.js`](../providers/rank-model.js) | 직전 20봉의 11개 피처를 당일 횡단면 순위로 바꾸고, 직전 60거래일로 매일 재학습한 ridge(λ 0.1). 목표는 시장 평균 대비 장중 수익률 |
| 2 | `ridge_6_features_60_sessions_v1` | [`ridge-model.js`](../providers/ridge-model.js) | 6개 피처, 직전 60거래일 매일 재학습 ridge(λ 0.5) |
| 3 | `prior_20_sessions_trimmed_shrunk_mean_capped_1pct` | [`forecast-basis.js`](../providers/forecast-basis.js) | 최대 20개 장중 수익률의 절사 평균을 t² / (1 + t²)로 축소하고 ±1% 제한 |

각 모델 파일 주석에 walk-forward 백테스트 수치(rank IC, MAE, calibration slope 등)가 기록되어 있습니다. 백테스트는 운영 성과를 보장하지 않습니다.

## 순위 지표 (`ranking_metrics`)

`evaluation` 요약은 오차 크기(MAE·RMSE·평균 오차·최소·최대) 외에 순위가 맞았는지를 보는 `ranking_metrics`를 함께 기록합니다. 계산은 [`providers/evaluation-contract.js`](../providers/evaluation-contract.js)의 `buildRankingMetrics`이며, `evaluated` 행만 반올림하지 않은 예상 수익률과 실제 시가→종가 수익률로 계산합니다. 거래 없음 행은 제외합니다.

| 필드 | 의미 |
| --- | --- |
| `sample_count` | 계산에 쓴 행 수 |
| `rank_ic` | 예상·실제 수익률의 Spearman 순위상관(동률은 평균 순위) |
| `hit_rate` | 예상·실제가 모두 0이 아닌 행 중 부호가 같은 비율 |
| `calibration_slope` | 실제 수익률을 예상 수익률에 OLS 회귀한 기울기 |
| `top_k` | 예상 상위 20종목(동률은 종목코드 순)의 실제 평균 수익률과 전체 평균 대비 `excess_return`. 21행 이상일 때만 |
| `score_buckets` | 예상 수익률 오름차순 10개 동일 개수 구간(1 = 최저 점수)의 평균 예상·실제 수익률. 10행 이상일 때만 |
| `bucket_spread` | 최상위 구간 − 최하위 구간 평균 실제 수익률 |

표본이 2개 미만이거나 분산이 0이면 해당 값은 `null`입니다. 이 필드가 생기기 전에 저장된 요약도 유효한 계약으로 읽습니다.

## 하루 단타 점수 (`daytrade_open_gap_rank_ridge_v1`)

하루 단타(시가 매수 → 종가 매도)를 위한 별도 점수입니다. [`providers/daytrade-model.js`](../providers/daytrade-model.js)에 있습니다.

- **채점 시각:** 09:00 시가 정산 직후입니다. 그날의 실제 시가를 알고 난 뒤 점수를 매깁니다.
- **피처:** 순위 모델의 11개 피처(직전 20봉)에 그날의 시가 갭(시가 ÷ 전일 종가 − 1)을 더하고, 모두 당일 종목 간 순위(−0.5~+0.5)로 바꿉니다.
- **예측 대상:** 시가 대비 종가·고가·저가 수익률 세 가지입니다. 각 대상은 시장 수준(그날 전체 종목의 평균 시가 갭으로 회귀)과 종목별 편차(순위 피처 ridge, λ 0.1)로 나눠 학습합니다.
- **학습:** 아침 일봉 수집(`[1 수집] 장전 일봉 선행 수집`)이 그날 이전 60거래일로 학습해 `data/daily-history/D.json`의 `daytrade_model`에 저장합니다.
- **후보:** 직전 20봉 평균 거래대금 10억 원 이상 종목 중 예상 종가 수익률 상위 20종목입니다.
- **기록:** 09:00에 `data/daytrade/D.json`을 쓰고, 15:30 정산 뒤 실제 결과(비용 0.2% 차감)를 더해 `data/daytrade/ledger.json`에 누적합니다.
- **종목별 비교 표:** 같은 시점에 `0900.json`·`1530.json`의 예상 종가를 이 모델로 바꿉니다. 예상 종가 = 예상 시가 × (1 + 모델의 시가→종가 예측)이므로, 표의 예상 수익률이 모델 예측과 같습니다. 근거는 `expected_close_basis`(`daytrade_open_gap_rank_ridge_v1`)에 순위·계수·시장 갭과 함께 저장되어 다시 계산할 수 있습니다. 모델이 채점하지 못한 종목은 예상 종가가 비어 있습니다. 2026-10-26~10-30은 `scripts/daytrade-backfill.mjs`로 사후 계산했고, 예상 시가가 없던 10-28은 직전 3거래일 일봉으로 채웠습니다.
- **백테스트:** [`scripts/daytrade-backtest.mjs`](../scripts/daytrade-backtest.mjs)가 같은 조건으로 날짜별 walk-forward 검증을 하고, 결과를 `data/daytrade/backtest.json`에 씁니다. 비교 대상은 현재 순위 모델(갭 없음)과 단순 갭 역추세입니다.

비용 0.2%는 거래세와 수수료를 합친 가정값이며 실제 세율 확인이 필요합니다. 정보 제공용 점수이고 수익을 보장하지 않으며, 주문·자동매매 기능은 없습니다.
