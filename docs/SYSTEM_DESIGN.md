# KOSPI Signal Board 시스템 설계

상태: 정적 Pages MVP 구현 및 안전한 provider 경계 반영
기준 시간대: `Asia/Seoul` (KST)

이 시스템은 KOSPI 정규시장 보통주의 장전 예상값을 정적 JSON 스냅샷에 기록하고, 장마감 뒤 실제 결과와 오차를 비교하기 위한 공개 관찰판이다. 자동매매·주문·브로커 연동을 수행하지 않으며, 예측의 정확도·수익·손실 회피를 보장하지 않는다.

## 1. 범위와 기준

기본 종목 범위는 KOSPI 정규시장 보통주다. KOSDAQ, ETF·ETN, 파생상품 및 우선주는 provider가 별도로 허용하고 범위를 기록하지 않는 한 제외한다. 가격 통화는 KRW이며 기준 시간대는 `Asia/Seoul`이다.

가격은 승인된 provider가 정의한 공식 정규장 시작가·종가만 사용한다. 조정주가, 호가, 첫 체결가, 장중 추정값을 공식 가격으로 섞지 않는다. source의 가격 정의가 확인되지 않으면 숫자를 공개하지 않고 `no_data` 또는 `degraded`로 남긴다.

장전 예측은 KST 08:20 수집 시점에 허용된 입력만 사용해 KST 09:00 시작가를 목표로 한다. 컷오프 이후 입력이 섞였거나 수집 시각을 확인할 수 없으면 해당 단계는 `degraded`가 된다.

## 2. 정적 데이터 모델

Pages가 읽는 최신 파일은 `data/latest-snapshot.json`이며 계약은 `schema/market-snapshot.schema.json`에 있다. 모든 랭킹 행은 다음 금융 필드를 포함한다.

| 필드 | 의미 | 허용값 |
| --- | --- | --- |
| `expected_open` | 예상 시작가 | 유한한 숫자 또는 `null` |
| `expected_close` | 예상 종가 | 유한한 숫자 또는 `null` |
| `expected_return` | 예상 수익률 | 유한한 숫자 또는 `null` |
| `actual_open` | 실제 시작가 | 유한한 숫자 또는 `null` |
| `actual_close` | 실제 종가 | 유한한 숫자 또는 `null` |
| `actual_return` | 실제 09:00 시가 수익률(전일 종가 대비) | 유한한 숫자 또는 `null` |
| `error` | 예상과 실제의 오차 | 유한한 숫자 또는 `null` |
| `actual_volume` | 실제 거래량(주) | 유한한 숫자 또는 `null` |

`confidence`와 `quality`는 선택적 설명 필드이며 투자 성과나 성공 확률을 뜻하지 않는다. 기존 camelCase 가격 필드는 저장 계약으로 허용하지 않는다. `providers/provider-adapter.js`가 필드 존재·타입·유한수·추가 필드를 검사하고 JSON Schema가 정적 계약을 재확인한다.

`no_data`, `degraded`, `blocked` 상태에서는 runner가 `rows: []`로 기록한다. 데이터 부족 시 이전 숫자를 새 단계의 결과인 것처럼 재사용하지 않는다.

## 3. 출처·수집 메타데이터

`meta.source`는 실제로 사용한 출처를 다음 구조로 기록한다.

```json
{
  "name": "출처 표시명",
  "url": "https://example.invalid/data.json",
  "license_status": "confirmed",
  "license_url": "https://example.invalid/terms",
  "retrieved_at": "2026-10-26T07:00:00.000Z"
}
```

`retrieved_at`은 성공한 데이터 요청의 수집시각이다. 실행 시각은 `meta.lastAttemptAt`, 단계의 `attemptedAt`, `publishedAt`에 별도로 기록한다. 활성 source가 없으면 `meta.source`는 `null`이다.

## 4. 상태 모델

각 Actions 단계는 독립적인 `pipeline` 상태를 가진다. 단계는 `previousResult`, `analysis`, `forecast`, `openSettlement`, `closeSettlement`이다.

```text
pending
  ├─ no_data   : provider 미설정 또는 유효한 행 없음
  ├─ degraded  : 설정·응답·라이선스·품질 문제
  ├─ blocked   : 계약 위반, 미등록 provider, 정책 조건 미충족
  ├─ demo      : UI/스키마 전용, 금융 데이터 아님
  └─ ready     : 확인된 출처 + 수집시각 + 스키마 검증 통과
```

`ready`는 source의 `license_status`가 `confirmed`이고 `retrieved_at`이 있는 경우에만 허용한다. 상태와 사유는 UI, `meta.blockedReason`, 단계 `message`에 공개한다.

## 5. Provider adapter

모든 adapter는 다음 계약을 구현한다.

- 문자열 `id`
- `getSourceMetadata()`
- `fetchPreviousDay(context)`
- `runAnalysis(context)`
- `generateForecast(context)`
- `settleOpen(context)`
- `settleClose(context)`

각 메서드는 `status`, `message`, `rows`, `source`, `asOfDate`를 반환하며, runner가 결과를 다시 검증한다.

### 기본 상태

`KOSPI_PROVIDER` 기본값은 계좌·API key가 필요 없는 `public-csv`이다. 이 provider는 명시적 allowlist의 공개 bulk CSV만 수집하고, HTML·로그인·CAPTCHA·차단 우회를 하지 않는다. `none`으로 설정하면 외부 요청을 하지 않고 `no_data`와 `blocked` 단계 상태만 기록한다. `demo`는 모든 금융 필드가 `null`인 UI 전용 행을 제공하며 `meta.isDemo=true`를 설정한다. Demo 행은 실측값이나 예측 성과로 표시하지 않는다.

`public-csv`는 source timeout 8초, stage overall deadline 20초, 최대 동시 요청 2개, 429/5xx 최대 2회 backoff를 사용한다. forecast workflow는 08:20 KST에 시작하고 08:29:00 KST cutoff를 넘긴 응답은 당일 데이터로 사용하지 않는다. stale·partial·deadline 결과는 정상 순위가 아니라 `partial`/`degraded`/`no_data`로 기록하고 이전 snapshot을 재사용하지 않는다. `meta.source`에는 run id, 수집 시각, source 상태와 요청 metrics를 보존한다.

### 합성 fixture

data/fixtures/2026-10-22.json과 data/fixtures/2026-10-23.json은 운영 데이터가 아닌 테스트 전용 snapshot이다. provider.id는 fixture, top-level mode는 fixture, meta.isDemo는 true이며, 모든 값과 fixture_synthetic 품질은 합성임을 전제로 한다. 대표 행은 expected_*, actual_*, error의 UI·정산 병합을 확인할 수 있게 제공하지만 실제 종목·가격·수익률이 아니다.

실제 08:20 KST 입력 snapshot이 없으므로 fixture의 expected_*는 역사적 예측을 사후 재구성한 값이 아니다. fixture provider는 forecast 단계에서 합성 expected 필드만, open/close-settlement 단계에서 합성 actual/error 필드를 반환하고, 화면에는 FIXTURE / SYNTHETIC ONLY와 SYN 접두사를 표시한다. KOSPI_PROVIDER=fixture는 자동 cron에서 사용하지 않으며, 수동 workflow_dispatch 또는 --provider fixture --fixture-date 2026-10-22|2026-10-23 dry-run에서만 선택한다.

### 오늘 전용 backfill test

?mode=backfill-test&date=2026-10-22|2026-10-23은 운영 snapshot과 분리된 2026-10-26 테스트 경로다. data/backfill-test의 두 snapshot은 기존 replay의 expected/actual/error 숫자 흐름을 복사해 mode=backfill_test, provider.id=backfill-test, meta.isDemo=true, meta.backfill=true로 표시한다. 화면에는 TEST ONLY / BACKFILL 라벨과 함께 08:20 KST 실제 원천 snapshot이 없고 미래 데이터 누수를 막기 위한 테스트 입력이라는 설명을 보여준다. 실제 금융 데이터나 과거 예측 성과를 주장하지 않는다. 2026-10-27부터 운영 모드는 실제 provider 설정만 사용하며 backfill test는 cron에 연결하지 않는다.

### Historical-test / TEST ONLY

`?mode=historical-test&date=2026-10-22|2026-10-23`은 운영 provider와 합성 fixture/replay/backfill을 건드리지 않는 과거 데이터 검증 경로다. `data/historical-test`의 두 스냅샷은 공개 일별 파일의 `mrktCtg=KOSPI` 전체 행을 저장하며, 날짜별 913행의 `actual_open`/`actual_close`/`actual_volume`을 실제 값으로 표시한다. 공개 원본에 security type이 없으므로 우선주 포함 가능성을 `meta.source_range`에 명시한다.

`expected_*`는 당시 08:20 예측이 아니다. historical baseline은 대상일을 제외한 직전 5개 거래일 공개 daily CSV의 종가만 사용한다. 2026-10-22는 `10-15, 10-16, 10-19, 10-20, 10-21`, 2026-10-23은 `10-16, 10-19, 10-20, 10-21, 10-22`가 입력이다. 각 종목에 대해 `r_t = close_t / close_(t-1) - 1`, `momentum = mean(last 3 r_t)`, `volatility = population_stddev(last 4 r_t)`를 계산하고, `expected_return = clamp(round(0.60 × momentum - 0.10 × volatility, 2), -5, +5)`로 저장한다. 그 다음 `expected_open = round(prior_close × (1 + expected_return / 100), 2)`를 유지한다. `actual_return = round((actual_open / prior_close - 1) × 100, 2)`, `error = actual_return - expected_return`이다. 대상 날짜의 actual 값은 forecast 입력에 사용하지 않는다. 이 모델은 공개 일봉만으로 재현 가능한 historical baseline이며 실제 장전 호가·예상체결가·주문잔량을 사용하지 않는다. 따라서 `confidence`는 `null`이고 `quality`는 `historical_baseline_public_daily`로 표시한다. 화면에는 `HISTORICAL-TEST / TEST ONLY`, `historical baseline`, `pre-open quote unavailable`, 출처 URL, 수집일, 범위, 행 수를 표시하며 기본 latest snapshot은 2026-10-23 historical-test를 가리킨다. 최근 가격 급등락과 상한 ±5% 때문에 예측력·수익률·실전 성과를 의미하지 않는다.

### 공개 JSON provider

`providers/public-json-provider.js`는 정책이 확인된 단일 공개 JSON endpoint를 위한 안전한 opt-in adapter다. 다음 조건을 모두 충족해야 요청한다.

1. `KOSPI_PUBLIC_SOURCE_URL`이 HTTPS 단일 URL이다.
2. URL hostname이 `KOSPI_PUBLIC_SOURCE_ALLOWED_HOSTS`에 정확히 포함된다.
3. `KOSPI_PUBLIC_SOURCE_NAME`과 HTTPS `KOSPI_PUBLIC_SOURCE_LICENSE_URL`이 있다.
4. `KOSPI_PUBLIC_SOURCE_LICENSE_STATUS=confirmed`다.
5. 응답 `Content-Type`이 `application/json`이고 `rows`가 스키마를 통과한다.

redirect를 거부하고 HTML·검색 결과·페이지 목록을 파싱하지 않으며 timeout을 둔다. 조건 미충족, 약관 미확인, 응답 오류, 스키마 오류는 네트워크 요청을 하지 않거나 `degraded`로 기록한다. 이 저장소에는 실제 source가 기본 설정되어 있지 않다.

## 6. 실행 단계와 시간대

GitHub Actions cron은 UTC 기준이며 KST는 UTC+9다. 한국은 서머타임이 없으므로 변환은 고정이다.

| UTC cron | KST | pipeline key | 동작 |
| --- | --- | --- | --- |
| `0 22 * * 0-4` | 월–금 07:00 | `previousResult` | 전일 예상·실제 결과 업데이트 |
| `0 23 * * 0-4` | 월–금 08:00 | `analysis` | 당일 기초 분석 |
| `20 23 * * 0-4` | 월–금 08:20 | `forecast` | 08:29 cutoff 전 공개 bulk 수집 및 장전 상태 |
| `0 0 * * 1-5` | 월–금 09:00 | `openSettlement` | 실제 시작가 정산 |
| `30 6 * * 1-5` | 월–금 15:30 | `closeSettlement` | 장마감 실제 정산 |

UTC 날짜가 KST보다 하루 빠른 오전 단계가 있으므로 `0 22 * * 0-4`는 KST 월요일 07:00에 UTC 일요일 22:00으로 실행된다. 공개 일별 CSV만으로는 09:00 시작가를 실시간 수집할 수 없으므로 `openSettlement`는 연결된 licensed intraday/open provider가 없으면 `no_data`를 기록한다. 휴장일이나 데이터 부족 시 숫자를 만들지 않고 상태만 기록한다.

## 7. 프론트엔드와 운영

`index.html`과 `styles.css`는 정적 Pages UI를 제공한다. `app.js`는 snapshot을 검증한 뒤 검색·정렬·상태 필터·pipeline 상태·예상/실제 비교표를 렌더링한다. `?mode=demo`는 숫자 없는 UI demo를, `?mode=fixture&date=2026-10-22|2026-10-23`은 명시적인 합성 fixture snapshot을 사용한다.

Actions는 `workflow_dispatch`에서 `all`, `update-results`, `analysis`, `forecast`, `open-settlement`, `close-settlement` 중 하나를 선택할 수 있다. workflow는 `npm test`와 `npm run check` 후 provider-aware runner를 실행하고 변경된 snapshot만 커밋한다.

## 8. 보안·라이선스·한계

- API key는 코드·fixture·정적 snapshot·로그에 기록하지 않는다. 향후 인증 provider만 `KOSPI_PROVIDER_API_KEY` GitHub Secret을 사용할 수 있다.
- 공개 source 설정은 GitHub Variables로 관리하고 source URL·라이선스 URL·allowlist를 수동 검토한다.
- 자동매매·주문·브로커 API·계좌 정보는 구현하지 않는다.
- GitHub Actions 실행 시각은 지연될 수 있으므로 실제 시각과 cutoff/published 시각을 구분한다.
- 운영 provider endpoint는 공개 daily CSV만 연결되어 있으며, 장전 호가·예상체결가·실시간 09:00 시가 provider는 연결하지 않았다. historical-test의 공개 파일 접근·라이선스·행 수·필수 숫자 필드는 수집 시점에 검증했지만, 한국거래소 인증 API 원문 응답과 각 종목의 security type은 확인하지 못했다.

검증 명령은 `npm test`, `npm run check`, `npm run pipeline:dry-run`, `git diff --check`이다. 로컬 HTTP smoke test는 `/`, `/?mode=demo`, `/data/latest-snapshot.json`의 응답과 JSON 파싱을 확인한다.
