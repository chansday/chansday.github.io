# CHANSDAY KOSPI Signal Board

정적 GitHub Pages 프론트엔드로 KOSPI 사전예측 랭킹을 기록하고, 장마감 뒤 실제 결과와 오차를 비교하는 공개 관찰판입니다.

평일 운영 provider 기본값과 GitHub Actions provider는 `naver-crawl`입니다. Naver 공개 polling endpoint에서 현재 KOSPI quote를 읽어 장전 예상시가·장중 실제시가·장마감 실제값을 계산하지만, Naver endpoint는 공식 API가 아니고 이용정책/재배포 권한이 확인되지 않았습니다. 따라서 source metadata는 `license_status=unconfirmed`를 유지하고 snapshot/meta/summary에 source warning을 남깁니다. 일봉의 시장·조정 기준과 보통주 분류가 확인되지 않아 Naver 운영 단계는 `partial`로 표시하고 신규 운영 snapshot 게시를 차단합니다. crawl 결과가 지연·빈 응답·차단이면 `no_data`/`degraded`/`blocked`를 기록하고 fixture, demo 또는 이전 snapshot을 대체값으로 사용하지 않습니다.

운영 forecast 및 정산은 별도의 `KOSPI prior daily history`가 06:10 KST(두 번째 시도 07:10 KST)에 시작하는 종목별 Naver 일봉 선행 수집(`api.stock.naver.com/chart/domestic/item/{code}/day`)을 사용합니다. 수집은 08:00 전에 완료되어야 하며, 기존 08:20·09:00·15:30 스케줄은 변경하지 않습니다. KRX 캘린더에서 직전 세 거래일을 확인하고 세 날짜의 유효한 OHLC와 거래량이 모두 있는 종목만 계산합니다. chart 일봉에는 전일 대비값이 없으므로 모든 행의 `comparison`은 `unverified`로 기록하고 원본 OHLC는 변경하지 않습니다. OHLC·거래량이 유효하지 않거나 필요한 날짜가 빠진 종목은 제외합니다. 서버의 403·429·challenge 또는 Retry-After는 수집을 중단하며 재시도나 헤더 교체로 우회하지 않습니다. 500ms 이상의 순차 요청 간격을 사용합니다. 900종목이면 간격만 약 7분 30초이고 Actions 지연·네트워크 시간은 별도입니다. 06:10 시작은 08:00 cutoff까지 약 110분 여유가 있고, 07:10 두 번째 실행은 완전한 파일이 있으면 보존하며 부분 파일만 개선합니다. 그래도 완료를 보장하지는 않습니다. open/close-settlement는 관측 가격만 기록하므로 일봉 이력이 없거나 차단돼도 정산 상태를 degraded/blocked로 바꾸지 않고, `history_status`·`history_reason`과 메시지에만 남깁니다(예상 시가는 저장된 장전 기록이 없으면 null). forecast·analysis 단계는 기존대로 이력 실패를 상태에 반영합니다. 지연 또는 차단으로 선행 파일이 없으면 이력 예측은 degraded/no_data이며 과거 파일을 대체하지 않습니다. 네이버 일봉의 KRX 정규장 구분, 수정 여부, 최초 게시시각과 이용·재배포 권한은 확인되지 않았습니다. 선행 파일에는 수집 원본의 일부가 포함되어 공개 저장소에 기록됩니다. 수동 실행이 08:00 전 또는 선행 수집 실패 후라면 필요한 이력을 사용할 수 없습니다. 이전 CSV 이력 설명은 별도 실험과 명시적 public-csv 경로에 적용됩니다.

국내 종목코드는 숫자와 ASCII 대문자로 이뤄진 정확히 6자리만 허용합니다. 예를 들어 `0126Z0`을 수용하며 소문자, 공백, 경로 문자 및 다른 길이는 거부합니다. 이는 코드 형식 검증이며 해당 종목이 보통주 또는 KRX 정규장 데이터라는 확인을 대신하지 않습니다.

부분 이력은 전체 forecast/정산도 `partial`로 표시하며 정상 스냅샷 commit gate를 통과하지 못합니다. 08:00 전 재실행은 같은 종목 범위에서 기존 유효 행을 보존하고 세 거래일 완전 종목이 증가한 경우에만 검증된 임시 파일을 원자적으로 교체합니다. 실패·차단·커버리지 미개선은 기존 파일을 보존합니다. 날짜별 독점 잠금으로 동일 checkout의 동시 수집을 차단합니다. 손상 파일은 자동 교체하지 않고 실패합니다. 운영자가 원본을 별도 보존해 조사한 뒤 명시적으로 복구해야 합니다. 비정상 종료로 `.lock`이 남았다면 실제 해당 수집 프로세스가 종료됐는지 먼저 확인하고 잠금 파일을 보존·조사한 뒤 수동으로 해제합니다. 공유 잠금이 아닌 별도 checkout 간의 동시성은 Actions의 공통 concurrency 그룹이 제어합니다.

## 범위와 운영 원칙

장 마감 후 당일 수동 `run-all`은 직전 3거래일의 공개 일봉으로 별도의 사후 평가를 만듭니다. 최근 2개 갭 `(당일 시가 / 전일 종가 - 1)`의 평균을 ±5%로 제한해 직전 종가에 적용하여 예상 시가를 만들고, 최근 3개 일중 수익률 `(종가 / 시가 - 1)`의 평균을 ±5%로 제한해 예상 시가에 적용하여 예상 종가를 만듭니다. 예상 수익률과 실제 시가→종가 수익률 및 오차는 기존 평가 계약을 사용합니다. 당일 실제 시가·종가는 평가에만 사용하며, 입력 이력이나 당일 가격이 없으면 해당 종목을 평가에서 제외합니다. 이 값은 장전 당시 기록된 예측이 아니라 장 마감 후 재현한 기준선입니다. 일봉 최초 공개시각·수정 여부·이용 권리는 확인되지 않았고, 모형의 정확도는 검증되지 않았습니다. 이력 확보가 차단되거나 평가 가능한 종목이 없으면 수동 실행은 실패를 보고합니다.

지난 거래일을 수동 실행할 때는 저장된 해당 날짜의 정상 Naver 마감 정산 스냅샷을 확인한 뒤 사후 평가만 수행합니다. 정산 스냅샷은 덮어쓰지 않으며, 저장된 정산값이 없거나 날짜·출처가 맞지 않으면 실패합니다. 이미 저장된 유효한 사후 평가는 보존합니다.

기존 정시 워크플로의 시각과 단계는 유지합니다. 거래일의 `close-settlement` 정시·수동 실행과 장 마감 이후 `run now`도 정산이 정상 완료되면 같은 사후 평가 엔진을 실행하고 기존 예측 시트에 결과를 연결합니다. 주말과 KRX 휴장일에는 공용 실행기가 수집·계산·저장을 건너뜁니다. 휴장 여부를 확인할 수 없는 연도는 안전하게 실패합니다.

+ 운영 provider의 보통주·우선주 분류는 미확인이고 우선주가 포함될 수 있습니다. 이번 historical-test는 공개 원본에 security type이 없어 `mrktCtg=KOSPI` 전체 913행을 그대로 저장했으며, 이 예외를 화면과 메타데이터에 명시합니다.
- 운영 quote의 시장 표기와 일봉의 시장·조정 기준은 독립적으로 확인되지 않았습니다. 관측·계산값은 원본과 출처 경고를 표시하며, 일봉과 정규시장 quote의 시장 범위가 다를 수 있습니다. 통화는 KRW, 시간대는 `Asia/Seoul`입니다.
- `expected_return = (expected_close / expected_open - 1) × 100`은 예상 시가와 예상 종가가 모두 있을 때만 계산합니다. 예상 종가 모델이 없으면 `expected_return`과 `error`는 `null`/`no_data`입니다. `session_return = (actual_close / actual_open - 1) × 100`은 실제 시가→실제 종가 기준입니다. `intraday_reference_return`은 별도 실행시점 참고값이며 `expected_return`과 구분합니다. 모든 필드는 JSON Schema로 숫자 또는 `null`을 검증합니다.
- 예상은 정보 기록과 비교를 위한 값이며 정확도·수익·투자 결과를 보장하지 않습니다.
- 자동매매, 주문, 브로커 연동, 거래 실행 기능은 구현하지 않습니다.
- Naver 공개 웹 크롤링은 출처와 비공식·지연 가능성을 화면과 snapshot metadata에 표시하며, 403/429/CAPTCHA·challenge·HTML 응답은 즉시 중단합니다. HTML 우회, rate-limit 우회, 무한 재시도는 하지 않습니다.
- `?mode=demo`는 UI/스키마 확인 전용이며 금융 실측값이나 예측 성과를 의미하지 않습니다.

## 구조

?mode=backfill-test는 2026-10-26 오늘만 사용하는 TEST ONLY / BACKFILL 화면이며 운영 데이터와 분리되어 있습니다.

```text
.
├─ index.html
├─ styles.css
├─ app.js
├─ data/latest-snapshot.json
├─ data/date-index.json
├─ data/runs/YYYY-MM-DD/{0700,0800,0820,0900,1530}.json
├─ schema/market-snapshot.schema.json
├─ providers/evaluation-contract.js
├─ providers/provider-adapter.js
├─ providers/demo-provider.js
├─ providers/fixture-provider.js
├─ providers/public-json-provider.js
├─ providers/public-csv-provider.js
├─ providers/naver-crawl-provider.js
├─ data/fixtures/2026-10-22.json
├─ data/fixtures/2026-10-23.json
├─ data/backfill-test/2026-10-22.json
├─ data/backfill-test/2026-10-23.json
├─ data/runs/historical-test/YYYY-MM-DD/{0700,0800,0820,0900,1530}.json
├─ scripts/update-results.mjs
├─ scripts/collect-historical-test.mjs
├─ scripts/workflow-dry-run.mjs
├─ scripts/run-all.mjs
├─ scripts/replay-dry-run.mjs
├─ scripts/backfill-test-dry-run.mjs
├─ tests/snapshot.test.mjs
├─ docs/SYSTEM_DESIGN.md
├─ docs/COLLECTION_AUDIT.md
└─ .github/workflows/{run-now,update-results,analysis,forecast,open-settlement,close-settlement}.yml
```

## 현재 데이터 출처 상태

운영 provider 기본값은 `naver-crawl`이며, 고정 stage workflow와 `run-now`가 같은 reusable runner를 사용합니다. `KOSPI_PROVIDER=none`은 명시적 비활성화로만 허용되며 해당 stage는 `no_data`를 기록하고 non-zero exit로 종료합니다. 공개 원천이 늦거나 품질 검사를 통과하지 못하면 `no_data`/`partial`/`degraded`/`blocked` 상태로 기록합니다. 운영 루트는 정확히 `no_data`일 때만 `data/runs/historical-test`의 settled run을 fallback으로 읽고, `partial`·`degraded`·`blocked`·stale 상태에서는 fallback하지 않습니다.

### Naver 공개 crawl provider

- quote endpoint: `https://polling.finance.naver.com/api/realtime/domestic/stock/{codes}`
- KOSPI universe endpoint: `https://api.stock.naver.com/stock/exchange/KOSPI/marketValue?page={page}&pageSize={pageSize}` (live list). 빈 목록이거나 해당 host의 robots가 경로를 금지하면 커밋된 [`data/kospi-universe.json`](data/kospi-universe.json)을 사용합니다. 403·429·challenge·형식 오류는 fallback 없이 중단합니다.
- 일봉 endpoint: `https://api.stock.naver.com/chart/domestic/item/{code}/day?startDateTime={YYYYMMDD}0000&endDateTime={전일 YYYYMMDD}2359` (대상일 당일 봉은 요청·사용하지 않음)
- quote의 `stockExchangeType.code`가 `KS`가 아니면 해당 행은 제외하고 `excluded_non_kospi_quotes`로 기록합니다. 커밋된 목록을 사용할 때 quote host가 반환하지 않은 종목(상장폐지 등)은 제외하고 `excluded_missing_quotes`로 기록하며, 두 경우 모두 결과는 `partial`입니다. live list 사용 시에는 기존대로 요청 종목이 정확히 한 번씩 있어야 합니다.
- 사용 필드: `openPriceRaw`, `closePriceRaw`, `localTradedAt`, `marketStatus`, `stockName`, `symbolCode` (가능한 경우 전일 대비 원시값과 누적 거래량도 계산 보조용으로 기록)
- 각 행에 `quote_at`과 `quote_age_seconds`, `market_status`를 보존하고, source metadata에 `retrieved_at`, 요청 수, freshness max age, universe/quote endpoint와 지연 가능성, `universe_source`(`live`/`cache`), `universe_as_of`, `universe_stale`, cache 사용 시 `universe_fallback_reason`, host별 robots 확인 결과(`robots`)를 기록합니다.
- 장전(`KST < 09:00`): 신선하고 PREOPEN으로 확인된 `openPriceRaw`를 기록하며, 없으면 검증된 직전 3거래일 이력으로 예상 시가를 계산합니다. 이력 수집이 실패하면 차단은 `blocked`, 그 밖의 오류는 `degraded`로 기록합니다.
- 장중(`09:00 ≤ KST < 15:30`): 신선한 `openPriceRaw`를 `actual_open`으로 저장합니다.
- 장마감 후(`KST ≥ 15:30`): 당일 `openPriceRaw`와 `closePriceRaw`를 실제 시가·종가로 저장합니다. 장마감 quote의 허용 max age는 별도로 검증합니다.
- 수동 `run-all`의 장중 현재가는 `intraday_reference_return` 참고값에만 사용합니다. 예상 시가는 저장된 장전 값 또는 직전 이력의 사후 계산값이며, `openPriceRaw`는 정산 단계에서 `actual_open`으로 기록합니다. `close-settlement`는 15:30 KST 이후에만 실행됩니다.
- `run-started-at`은 단계 eligibility와 target 거래일을 정하는 기준시각이고, `meta.source.retrieved_at`은 각 provider 요청이 실제로 수집된 시각입니다. 두 시각을 동일한 값으로 가장하지 않으며, Naver `localTradedAt`은 실제 수집시각보다 최대 5초 앞선 서버 clock skew만 허용합니다. 그 밖의 stale·missing·다른 날짜 timestamp는 계속 `degraded`/`no_data`입니다.
- Naver 이용정책/라이선스가 확인되지 않아 `license_status=unconfirmed`이며, 이 값은 source metadata에 그대로 보존합니다. fresh·current-day·schema-valid quote여도 시장 기준과 보통주 분류가 확인되기 전에는 `partial`로 처리하고 신규 운영 snapshot commit을 차단합니다. stale·missing·out-of-date timestamp, HTTP/parse failure는 계속 `no_data`/`degraded`/`blocked`로 처리되어 run-all commit을 허용하지 않습니다.

`data/runs/historical-test/YYYY-MM-DD/*.json`은 운영 run과 분리된 검증용 과거 스냅샷입니다. `data/latest-snapshot.json`은 운영 provider의 최신 run 복사본이며, fallback 선택 시에도 파일·운영 상태·메타데이터를 덮어쓰지 않습니다. historical-test 수집기는 latest 운영 복사본을 갱신하지 않습니다.

- 출처: [한국주식데이터 일별 시세 파일](https://aikstockdata.com/data/public/daily/quotes_20261023.csv), 원천 표기: 금융위원회 공공데이터포털·한국거래소
- 라이선스: [aiksd-public-1.1](https://aikstockdata.com/licenses/aiksd-public-1.1.txt), 출처표시·비영리 이용 조건 및 공공누리 제4유형 조건을 준수해야 합니다.
- 수집일: 2026-10-26 (스냅샷의 `meta.source.retrieved_at`에 ISO 시각 기록)
- 실제 날짜/파일: 2026-10-22 → `quotes_20261022.csv`, 2026-10-23 → `quotes_20261023.csv`
- 범위: 각 원본 CSV의 `mrktCtg=KOSPI` 행 전체, 날짜별 913행. 원본 전체는 날짜별 2,778행입니다. 이 공개 파일은 security type을 제공하지 않으므로 KOSPI 행에는 우선주가 포함될 수 있으며, 빈 행을 만들거나 미수집 값을 숫자로 채우지 않았습니다. ETF 행은 원본에 없습니다.
- 저장한 실제 필드: `actual_open` = `mkp`, `actual_close` = `clpr`, `actual_volume` = `trqu`; `session_return`은 `(actual_close / actual_open - 1) × 100`으로 계산합니다. 모두 날짜별 913행에서 결측 없이 검증했습니다.

### Historical-test / TEST ONLY

기본 화면은 최신 운영 스냅샷을 표시합니다. live provider가 정확히 `no_data`일 때만 `data/runs/historical-test/YYYY-MM-DD/1530.json`을 읽어 표시하며, `partial`·`degraded`·stale 상태에서는 운영 상태를 그대로 유지합니다. fallback 화면의 최상단 라벨은 정확히 `TEST ONLY · HISTORICAL BASELINE · NOT LIVE`입니다. historical-test 날짜별 화면은 다음 주소로 별도 확인할 수 있습니다.

- `https://chansday.github.io/?mode=historical-test&date=2026-10-22`
- `https://chansday.github.io/?mode=historical-test&date=2026-10-23`

### 날짜별 조회 달력

종목 비교 제목 오른쪽의 `조회 날짜 YYYY.MM.DD` 버튼은 현재 URL의 `mode`를 유지한 채 `date=YYYY-MM-DD`를 갱신합니다. 예를 들어 `?mode=historical-test&date=2026-10-22`에서 2026-10-23을 고르면 `?mode=historical-test&date=2026-10-23`을 직접 읽습니다. 선택한 파일이 없으면 이전 날짜의 행을 재사용하지 않고 `미수집`으로 비웁니다.

- `결과 있음`: `data/date-index.json`의 mode별 `availableDates`에 있고, 실제 파일이 존재하는 날짜입니다.
- `조회 중`: 새 날짜 파일을 읽는 동안 표시합니다. 요청 토큰으로 늦게 도착한 이전 응답이 새 날짜를 덮지 못하게 합니다.
- `미수집`: 날짜 인덱스에 실제 stage 파일이 없습니다. 운영 provider는 `data/runs/YYYY-MM-DD/1530.json`, historical-test는 `data/runs/historical-test/YYYY-MM-DD/1530.json`을 기준으로 합니다.
- `휴장일`: [`data/krx-market-holidays.json`](data/krx-market-holidays.json)의 KRX 휴장일과 주말입니다. 날짜 버튼은 비활성화되고 상태 문구를 함께 표시합니다.
- `오류`: 유효하지 않은 날짜·스냅샷 계약 위반·읽기 실패입니다. 이 경우에도 이전 순위는 유지하지 않습니다.

`data/date-index.json`은 [`scripts/generate-date-index.mjs`](scripts/generate-date-index.mjs)가 `data/runs` 및 mode별 fixture/replay/backfill 폴더를 스캔해 생성합니다. 새 run stage를 추가할 때는 이 인덱스를 갱신하고, 브라우저는 mode별 실제 경로를 다시 읽습니다. 달력은 색상뿐 아니라 `결과 있음·조회 중·미수집·휴장일·오류` 텍스트, `aria-selected`, `aria-disabled`, `aria-live`로 상태를 전달합니다. 모바일에서는 860px 이하에서 제목·달력·컨텍스트가 줄바꿈되고 달력 폭은 viewport 안으로 제한됩니다.

화면의 `EXPECTED` 열은 실제 예측값이 아니라 사후 계산한 baseline이고, `ACTUAL` 열은 공개 일봉의 실제 시가·종가·거래량입니다. `예상 수익률`은 예상 시가→예상 종가가 확인된 경우에만 표시하며, `실제 장중 수익률`은 실제 시가→실제 종가로 계산합니다. fallback에서는 실제 run의 필드를 그대로 로드하며 숫자를 합성하지 않습니다. `TEST ONLY · HISTORICAL BASELINE · NOT LIVE` 또는 명시적 모드의 `HISTORICAL-TEST / TEST ONLY` 라벨, 출처 URL, 수집일, 범위, 행 수를 화면에 함께 표시합니다.

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

### 공개 crawl 수집 전략과 08:20 cutoff

운영 수집은 KOSPI market-list JSON을 페이지 단위로 한 번 읽고(비어 있으면 커밋된 목록 사용), 종목코드를 제한된 batch로 polling endpoint에 전달합니다. 로그인·CAPTCHA·redirect·HTML challenge 또는 기술적 차단을 우회하지 않으며 robots 확인을 통과한 host 외에는 요청하지 않습니다.

#### robots.txt 정책

- [`providers/robots-policy.js`](providers/robots-policy.js)가 모든 Naver 요청(universe·quote·일봉) 직전에 요청 URL의 경로+query를 해당 origin의 robots.txt와 대조합니다. robots.txt는 수집 1회당 origin별 한 번 읽고 결과를 source metadata(`robots`)와 일봉 파일(`robots_url`, `robots_status`, `robots_checked_at`)에 남깁니다.
- 금지 경로이거나 robots.txt를 확인할 수 없으면(5xx, 401/403/406/429, 네트워크 오류, timeout, redirect, HTML 200) `blocked`로 중단하고 데이터 요청을 보내지 않습니다.
- robots.txt 자체가 HTTP 404/410이면 RFC 9309 §2.3.1.3에 따라 "robots.txt 없음(제한 없음)"으로 처리합니다. 이 예외는 Naver crawl 경로에서만 `allowMissing` 옵션으로 켜며, public-csv 등 다른 경로는 기존대로 fail-closed입니다.
- 429 또는 Retry-After 응답은 기다리거나 재시도하지 않고 즉시 `blocked`로 중단하며 `retry not before` 시각만 기록합니다. 정상적으로 파싱되는 JSON 응답은 본문 단어(예: 종목명 "Doosan Robotics")로 challenge 판정하지 않고, HTML 또는 비JSON 본문에만 challenge 문구 검사를 적용합니다.
- `data/kospi-universe.json`과 `data/daily-history/`는 작업 디렉터리가 아니라 저장소 루트(`providers/repo-paths.js`, `import.meta.url` 기준)에서 해석합니다. `KOSPI_DATA_ROOT`로 다른 루트를 지정할 수 있습니다(테스트 격리용).
- User-Agent는 `chansday-kospi-signal-board/1.0 (+https://chansday.github.io/)`로 고정이며 교체·위장하지 않습니다. robots 요청의 `Accept`는 `text/plain, */*;q=0.1`입니다(일부 host가 `text/plain` 단독에는 실제 404 대신 406을 반환함).
- 2026-10-28 확인 결과: `m.stock.naver.com`, `finance.naver.com`, `fchart.stock.naver.com`은 `User-agent: * / Disallow: /`이므로 요청하지 않습니다. `api.stock.naver.com`, `polling.finance.naver.com`은 robots.txt 404입니다. `data.krx.co.kr`은 robots.txt 404이지만 종목 목록 JSON endpoint가 키 없는 요청에 HTTP 403을 반환해 사용하지 않습니다(우회 시도 없음).

#### KOSPI universe 목록 파일

- `api.stock.naver.com`의 KOSPI 목록은 2026-10-28 장전·장마감 후(after-market 진행 중) 모두 `totalCount: 0`, `marketStatus: PREOPEN`을 반환했습니다(같은 경로의 NASDAQ은 정상). 정규장(09:00–15:30) 중 반환 여부는 아직 확인하지 않았으므로 코드는 live list를 먼저 시도합니다.
- [`data/kospi-universe.json`](data/kospi-universe.json)은 종목코드·종목명 목록일 뿐 가격 원천이 아닙니다. `candidates_as_of`(후보 기준일), `collected_at`(후보 수집시각), `verified_at`(마지막 quote host 재확인), `source.method`(`live_list` 또는 `candidate_verification`), `candidate_source`, `discovers_new_listings`, host별 robots 확인 결과, `license_status=unconfirmed`를 포함합니다. `candidates_as_of`가 7일(`KOSPI_UNIVERSE_MAX_AGE_DAYS`)보다 오래되면 `universe_stale=true`이며 결과는 `partial`입니다.
- 초기 파일은 금융위원회 공공데이터포털·한국거래소 원천의 공개 일별 CSV `https://aikstockdata.com/data/public/daily/quotes_20261026.csv`(basDt 2026-10-26, robots.txt `Allow: /data/public/` 확인 후 요청)의 `mrktCtg=KOSPI` 913행 종목코드를 후보로, `polling.finance.naver.com`에서 `stockExchangeType.code === "KS"`를 재확인해 만들었습니다(913/913 확인). 출처 URL·basDt·수집시각·robots 확인 시각은 파일의 `candidate_source`에 기록됩니다. robots 금지 host(`m.stock.naver.com`)에서 목록이 수집된 `data/latest-snapshot.json`과 `data/runs/YYYY-MM-DD/` 운영 파일은 후보로 거부합니다. 후보 검증 방식은 CSV 기준일 이후 신규 상장 종목을 추가할 수 없습니다.
- 갱신: `npm run universe:update` (dry-run: `npm run universe:dry-run`, 공개 CSV 후보: `node scripts/update-kospi-universe.mjs --candidates-csv YYYY-MM-DD`, 다른 후보 파일: `--candidates <file>`; 옵션이 없으면 기존 목록을 재확인). live list가 행을 반환하면 `live_list`로 교체하고, 아니면 후보를 quote host에서 재확인합니다. 확인 비율이 90% 미만이거나 403/429/challenge이면 파일을 바꾸지 않습니다. `KOSPI prior daily history` workflow가 일봉 수집 전에 `--candidates-csv latest`(최근 3거래일 CSV 중 기존 `candidates_as_of`보다 새로운 것, 없으면 기존 목록 재확인)를 `continue-on-error`로 실행하고 변경 시 함께 커밋합니다. stale 판정은 재확인 시각(`verified_at`)이 아니라 후보 기준일(`candidates_as_of`)로 하며, 재확인은 `candidate_source`·`collected_at`·`candidates_as_of`를 바꾸지 않습니다.
- 네트워크 dry-run(파일 쓰기 없음): `npm run naver:dry-run` — universe와 앞 3종목의 quote·일봉을 실제로 요청해 행 수와 상태만 출력합니다.

- Actions forecast는 scheduler keeper가 08:20 KST에 dispatch하지만, 수동 `run-all now`는 reusable runner에서 실제 실행 시각을 UTC ISO-8601로 생성해 사용합니다. 오늘 거래일의 수동 전체 실행은 시각과 관계없이 `update-results`/`analysis`/`forecast`를 호출하고, KST 09:00 이후에만 `open-settlement`, 15:30 이후에만 `close-settlement`를 추가 호출합니다. 수동 run-all은 실행 시작시각과 별도로 collection invocation timestamp를 기록하고, 각 Naver 요청의 실제 수집시각을 source metadata에 기록합니다. 주말·공휴일·미래 날짜는 수집을 건너뛰며 과거 거래일은 기존 정책을 유지합니다. 모든 stage는 같은 crawl runner에서 quote freshness를 검증합니다.
- source별 timeout(기본 8초), 전체 deadline(기본 120초), 순차 요청 간 최소 간격(기본 250ms), 최대 1회 bounded retry를 적용합니다. 403/429/challenge는 재시도하지 않습니다.
- deadline 초과·중복·필수 필드 결측·오래된 파일은 `partial`/`degraded`/`no_data`로 기록하고 정상 순위로 표시하지 않습니다. 이전 snapshot을 당일 결과처럼 재사용하지 않습니다.
- `meta.source`에는 source id, run id, `source_date`, fetched/retrieved 시각, source 상태, raw/유효 행 수, partial 여부와 요청·재시도·경과·예상 소요시간 metrics를 기록하고, snapshot top-level `asOfDate`는 실제 원본 날짜를 가리킵니다. stale/unsupported 결과도 이 날짜를 숨기지 않습니다.
- Naver quote는 공식 API가 아니며 응답 지연·필드 변경·차단 가능성이 있습니다. 따라서 `localTradedAt`와 fetch time의 max age를 확인하고, 없는 예측값·실제가를 생성하지 않습니다.

정책이 확인된 단일 공개 JSON endpoint를 연결하려면 `KOSPI_PROVIDER=public-json`과 아래 설정을 모두 명시해야 합니다. 하나라도 빠지면 adapter는 네트워크 요청 없이 `degraded`를 반환합니다.

- `KOSPI_PUBLIC_SOURCE_NAME`
- `KOSPI_PUBLIC_SOURCE_URL` — HTTPS 단일 JSON endpoint
- `KOSPI_PUBLIC_SOURCE_LICENSE_STATUS=confirmed`
- `KOSPI_PUBLIC_SOURCE_LICENSE_URL` — HTTPS 이용약관/라이선스 URL
- `KOSPI_PUBLIC_SOURCE_ALLOWED_HOSTS` — endpoint hostname의 명시적 allowlist

adapter는 단일 HTTPS JSON endpoint만 사용하고, redirect를 거부하며, `application/json`이 아닌 응답을 거부합니다. source timeout·overall deadline·429/5xx bounded backoff를 적용하고 응답에는 `asOfDate`와 검증된 `rows`가 있어야 합니다. 성공 시 `meta.source`에 출처명·URL·라이선스 상태·라이선스 URL·수집시각·run id·metrics를 기록합니다.

실제 API 키는 코드·fixture·snapshot에 넣지 않습니다. 향후 provider가 인증을 요구할 경우에만 GitHub Actions Secret `KOSPI_PROVIDER_API_KEY`를 사용하며, 현재 `public-json` adapter는 키를 사용하지 않습니다.

운영 단계 저장은 `node scripts/update-results.mjs --mode <stage> --run-date YYYY-MM-DD`로 수행합니다. 기본 단계 시각은 KST 07:00, 08:00, 08:20, 09:00, 15:30으로 고정되어 동일 입력 재실행 시 JSON 내용이 달라지지 않습니다. 09:00은 `actual_open`만, 15:30은 `actual_close`/`session_return`/`actual_volume`을 이전 단계에 병합하며 expected 필드는 보존합니다. `--dry-run`은 파일을 쓰지 않습니다.

### Baseline replay 모드

2026-10-22·23 baseline replay는 전일 종가 기준 입력 계약, 예상값, 실제값, 오차 열을 검증하기 위한 합성 시뮬레이션입니다. 당시 08:20 입력 스냅샷이나 실제 시장값을 복원하지 않으며, 두 파일 모두 `mode=replay`, `provider.id=replay_baseline`, `meta.replay_type=replay_baseline`, `meta.isDemo=true`를 유지합니다.

브라우저에서 다음 주소로 확인할 수 있습니다.

- `https://chansday.github.io/?mode=replay&date=2026-10-22`
- `https://chansday.github.io/?mode=replay&date=2026-10-23`

로컬 검증 명령은 다음과 같습니다.

~~~bash
npm run replay:dry-run -- --date 2026-10-22
npm run replay:dry-run -- --date 2026-10-23
~~~

### 오늘 전용 backfill 테스트

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

### Historical-test 단계 누적 검증

실제 공개 일봉 기반 historical-test를 운영 latest와 분리한 상태로 07:00·08:00·08:20·09:00·15:30 파일에 기록하려면 다음 명령을 사용합니다.

```text
npm run historical-test:pipeline
npm run historical-test:verify
```

파일은 `data/runs/historical-test/YYYY-MM-DD/{0700,0800,0820,0900,1530}.json`에 생성되며, 순서 변경 검증과 결과 보고서는 `docs/HISTORICAL_STAGE_VERIFICATION.md`에 기록합니다. 모든 파일은 `test_only=true`, `historical_test=true`이며 `data/latest-snapshot.json`을 갱신하지 않습니다.

각 historical-test snapshot에는 화면이 평가 결과를 평면 필드 추측 없이 사용할 수 있도록 top-level `evaluation` 계약도 포함됩니다. `evaluation.target`은 `expected_return`(예측), `session_return`(실제), `error`(오차)의 정규화된 필드 매핑과 `session_return - expected_return` 공식을 선언합니다. 현재 historical 입력에는 expected close가 없어 모든 단계가 `pending`이며, 두 값이 모두 존재하는 별도 snapshot만 `evaluated`가 됩니다. `sample_count`, `evaluated_sample_count`, `missing_sample_count`, `evaluation_range`, MAE/RMSE/평균 오차 집계 및 `test_only=true`, `dataset=historical_test`를 함께 기록합니다.

원본 JSON의 `expected_open`, `expected_close`, `expected_return` 값은 저장 정밀도를 그대로 보존합니다. 화면 표시가 필요할 때만 `evaluation.display_policy`의 `maximum_fraction_digits=0`, `rounding=half_up` 정책을 사용해 소수점 없는 표시값을 만들며, 이 정책은 저장값·실제값·오차 계산을 변경하지 않습니다.

이 평가 메타데이터는 `data/historical-test/`와 `data/runs/historical-test/`에만 생성됩니다. 운영 `data/latest-snapshot.json`에는 historical-test 평가를 병합하지 않으며, historical-test fallback도 원본 `evaluation`을 보존하면서 `meta.historical_fallback`으로만 표시합니다. `providers/provider-adapter.js`는 historical-test snapshot에 test-only 평가 계약이 없거나 표본수가 행 수와 다르면 로드를 거부합니다.

### 합성 fixture 모드

data/fixtures/2026-10-22.json과 data/fixtures/2026-10-23.json은 UI·스키마·정산 흐름을 확인하기 위한 합성 fixture입니다. 두 파일 모두 provider.id=fixture, mode=fixture, meta.isDemo=true를 명시하고, FIXTURE / SYNTHETIC ONLY 라벨과 fixture_synthetic 품질을 사용합니다. 값은 실제 종목·가격·수익률이 아니며, 실제 08:20 KST 입력 스냅샷이 없으므로 역사적 예측을 사후 재구성한 자료도 아닙니다.

운영 cron은 fixture를 사용하지 않습니다. fixture 확인은 로컬 dry-run으로만 수행합니다.

~~~
node scripts/update-results.mjs --provider fixture --fixture-date 2026-10-22 --mode forecast --dry-run
npm run pipeline:dry-run -- --provider fixture --fixture-date 2026-10-23
~~~

브라우저에서는 ?mode=fixture&date=2026-10-22 또는 ?mode=fixture&date=2026-10-23을 사용합니다. 화면에는 FIXTURE / SYNTHETIC ONLY와 SYN 접두사가 표시됩니다.

## GitHub Actions 버튼과 실행 시각

stage workflow에는 더 이상 schedule cron이 없습니다. 2026-10-28 실측에서 GitHub schedule 이벤트가 장전 단계는 약 3시간(07:00→10:00, 08:20→11:23), 10-27 마감 정산은 약 6시간(15:30→21:34) 늦게 시작해 장전 단계가 실패했기 때문입니다. 대신 `KOSPI scheduler keeper`([`.github/workflows/scheduler-keeper.yml`](.github/workflows/scheduler-keeper.yml))가 KST 정시까지 기다렸다가 각 stage를 `workflow_dispatch`로 시작합니다. `GITHUB_TOKEN`으로 보낸 `workflow_dispatch`는 새 run을 만드는 GitHub 예외를 이용하며 PAT·secret·외부 서비스는 쓰지 않습니다.

| 버튼 / workflow | keeper dispatch (KST, 거래일) | 마지막 시작 허용 | stage / provider |
| --- | --- | --- | --- |
| `KOSPI prior daily history` | 06:10 (실패 시 07:10 1회 재시도) | 07:45 | 일봉 선행 수집 |
| `KOSPI update-results` | 07:00 | 08:50 | `update-results` / `naver-crawl` |
| `KOSPI analysis` | 08:00 | 08:50 | `analysis` / `naver-crawl` |
| `KOSPI forecast` | 08:20 | 08:50 | `forecast` / `naver-crawl` |
| `KOSPI open-settlement` | 09:00 | 23:00 (늦어도 실행) | `open-settlement` / `naver-crawl` |
| `KOSPI close-settlement` | 15:30 | 23:00 (늦어도 실행) | `close-settlement` / `naver-crawl` |
| `KOSPI run all now` → **Run workflow** | 수동 | — | 5개 stage 순차 실행 / live 또는 historical crawl |

### Scheduler keeper

- 계획 규칙은 [`scripts/scheduler-plan.mjs`](scripts/scheduler-plan.mjs)(순수 함수, 단위 테스트), 실행 loop와 Actions API 호출은 [`scripts/scheduler-keeper.mjs`](scripts/scheduler-keeper.mjs)에 있습니다. `npm run scheduler:plan -- --now 2026-10-29T05:30:00+09:00 [--started ...] [--runs runs.json]`로 네트워크 없이 계획을 확인할 수 있습니다.
- 주말·KRX 휴장일(`data/krx-market-holidays.json`)에는 API 호출 없이 즉시 종료합니다. 달력 커버리지 밖이면 실패로 끝납니다.
- 시작 보장: keeper cron은 KST 00:07·01:37·03:07·04:37·05:27(월–금)에 있어 수 시간 지연돼도 06:10 전에 하나가 시작되도록 했고, 07:37·10:07·13:07·14:47 cron은 keeper가 중간에 죽었을 때 남은 stage를 이어받습니다. concurrency group `kospi-scheduler-keeper`(cancel-in-progress: false)로 keeper는 한 번에 하나만 실행됩니다. 대기 중인 keeper가 새 keeper로 교체돼 취소되는 것은 정상입니다.
- 순차 실행: stage workflow들은 concurrency group `kospi-signal-board-pipeline`(실행 1 + 대기 1, 새 대기 run이 기존 대기 run을 취소)을 공유하므로, keeper는 오늘의 stage run이 하나라도 queued/실행 중이면 다음 stage를 dispatch하지 않고 30초마다 다시 확인합니다. 07:10 일봉 재시도와 07:00 update-results가 겹칠 때도 같은 규칙입니다. 늦게 시작해 순차 처리 중 마지막 시작 허용 시각(장전 08:50)을 넘기면 그 stage는 `missed`입니다. 45분 넘게 끝나지 않는 run은 더 이상 다음 stage를 막지 않습니다.
- 달력 커버리지 종료 30일 전부터 keeper step summary와 로그에 경고를 남깁니다. 종료 후에는 기존대로 실패합니다.
- 중복 방지: dispatch 전에 Actions API에서 해당 stage workflow의 오늘(KST) `workflow_dispatch`/`schedule` run을 조회합니다. queued·실행 중·성공·실패 run이 있으면 다시 시작하지 않습니다. 취소된 run만 최대 3회까지 다시 시작합니다(stage 공용 concurrency 대기열에서 교체·취소된 경우). 일봉 수집만 실패 후 07:10에 1회 재시도합니다.
- 지난 stage: 장전 stage(일봉·update-results·analysis·forecast)는 마지막 시작 허용 시각이 지나면 `missed`로 건너뜁니다. 장후 실행은 단계 판정상 의미가 없기 때문입니다. 정산 stage는 관측 가격만 기록하므로 같은 KST 날짜 23:00까지는 늦게라도 실행합니다.
- runner 6시간 한도: job `timeout-minutes: 340`, keeper는 시작 후 325분이 되면 남은 stage가 있을 때 자신을 `workflow_dispatch`로 다시 호출(relay)하고 종료합니다. 마지막 stage(15:30) dispatch 후에는 종료합니다.
- 권한은 `actions: write`, `contents: read`뿐입니다. checkout은 `scripts/`와 휴장일 달력만 sparse로 받습니다.
- 정시 의미: dispatch된 stage도 reusable runner가 runner 시작 시각을 `run-started-at`으로 캡처하고 그 KST 날짜·시각으로 거래일과 stage를 판정합니다. keeper는 경계 시각 3초 뒤에 dispatch하므로 09:00·15:30 경계 전에 시작하지 않습니다.
- runner 사용량: 거래일에는 첫 keeper 시작(가장 이르면 00:07)부터 15:30까지 대부분 sleep으로 약 9.5~15.5시간(570~925분), 그 외 stage job은 각 수 분입니다. 휴장일·주말은 keeper 1회당 1분 미만입니다. 공개 저장소의 표준 GitHub-hosted runner 기준입니다.

Actions에는 기능별 workflow와 입력 없는 `KOSPI run now` workflow가 표시됩니다. `KOSPI run all now`와 reusable stage runner는 runner 첫 실행 step에서 실제 UTC timestamp를 생성해 `GITHUB_ENV`와 `GITHUB_OUTPUT`에 기록하고, 같은 유효한 ISO timestamp를 stage command의 run-start와 source-attempt 기준으로 전달합니다. 따라서 `github.run_started_at`의 빈 값이나 고정 schedule 시각을 stage 판정에 사용하지 않습니다. `run all now`는 오늘 거래일에 실제 run-start 시각과 관계없이 `forecast`까지 실행하고, 09:00 이후 `open-settlement`, 15:30 이후 `close-settlement`를 추가합니다. `run now`는 reusable runner가 캡처한 실제 run start를 KST로 변환해 단일 `auto_stage`를 선택합니다. 수동 실행도 파일에 저장된 날짜나 고정 `fixture_date`를 사용하지 않으며, `naver-crawl`은 계좌·API 키·Secret 없이 실행됩니다. `run now`의 실제 stage 실패는 job을 실패시키고, `run all now`의 아직 시간이 되지 않은 `pending`은 summary에 남기는 정상 `partial` 결과입니다. 필수 step이 실패·skip되거나 stage/overall status가 비어 있거나 알 수 없으면 최종 gate가 실패합니다.

### KOSPI run all now / 전체 순서 실행

특정 거래일의 run-all 계획을 실행하려면 Actions에서 **`KOSPI run all now` → `Run workflow`**를 선택하고 `run_date` 하나만 `YYYY-MM-DD`로 입력합니다. provider나 stage를 선택하는 입력은 없습니다. 계획 순서는 `update-results → analysis → forecast → open-settlement → close-settlement`로 고정되지만, 실제 명령은 실제 run-start KST 시각에 `planned/eligible`인 단계만 호출합니다. 실행하지 않은 단계는 `pending`과 이유를 summary에 남깁니다. 모든 실제 실행 단계는 같은 `run_id`, `run_date`, run-start timestamp를 사용하며, 마지막 eligible 실행 stage 파일만 `data/latest-snapshot.json`과 consistency check로 비교합니다. concurrency 잠금으로 다른 KOSPI 수집과의 data race를 막고, 단계 파일과 `data/latest-snapshot.json`은 마지막에 한 번만 commit합니다. 기존 `KOSPI run now`는 계속 현재 시각에 맞는 단일 `auto_stage` 실행용입니다.

- 현재일: 실제 run-start KST와 관계없이 `update-results`/`analysis`/`forecast`를 호출하며, 09:00 이상이면 `open-settlement`, 15:30 이상이면 `close-settlement`를 각각 추가합니다. 아직 이른 정산 단계는 명령을 호출하지 않고 `pending`으로 기록합니다. 따라서 08:30 KST는 앞의 세 stage만, 12:09 KST는 앞의 네 stage만, 15:30 이후는 다섯 stage 모두 호출합니다.
- 과거일: 공개 historical daily crawl에서 입력 날짜와 직전 거래일의 실제 값을 확인합니다. 당시 pre-open quote/order-book history가 없으면 `forecast`는 `no_data`/`unsupported`이며 합성·재구성하지 않습니다. 실제 historical open/close가 있으면 `open-settlement`와 `close-settlement`에 반영합니다.
- 미래일: `blocked`로 종료하고 snapshot을 만들지 않습니다. 주말·KRX 휴장일: `market_closed` 사유를 포함한 `blocked` 결과로 종료하고 수집·commit하지 않습니다.

Summary에는 각 stage의 `planned`, `pending`, `skipped`, 실제 호출 여부와 이유, 최종 `ready`/`partial`/`degraded`/`blocked`가 표시됩니다. 아직 시간이 되지 않은 `pending` 때문에 `partial`이 되는 것은 정상 종료이며, 실제 호출 stage에서 `blocked`/`degraded`가 발생하거나 미래·휴장일 preflight가 차단되면 실패합니다. `no_data`를 성공으로 숨기지 않으며 fixture/demo/replay/이전 snapshot은 이 workflow의 실제 데이터 대체용으로 사용하지 않습니다. 자세한 입력 계약은 [`.github/workflows/run-all-now.yml`](.github/workflows/run-all-now.yml)과 [`scripts/run-all.mjs`](scripts/run-all.mjs)에 있습니다.

### Which button should I press? / 어떤 버튼을 누르나요?

현재 `main`의 Actions에는 stage별 workflow와 입력이 없는 `KOSPI run now`가 각각 등록되어 있습니다. 장 시작 전인지, 장중인지, 장 마감 후인지와 관계없이 지금 실행하려면 **`KOSPI run now` → `Run workflow`**를 누르십시오. 입력값은 없습니다. 이 workflow는 [`.github/workflows/run-now.yml`](.github/workflows/run-now.yml)에서 `auto_stage: true`와 `provider: naver-crawl`을 설정하고, [공용 runner](.github/workflows/_run-stage.yml)를 호출합니다.

`run now`의 자동 stage는 버튼을 누른 GitHub Actions run의 시작 시각을 KST로 변환해 결정합니다. keeper의 08:20/09:00/15:30 dispatch 시각은 정기 실행 시각일 뿐, 수동 `run now`를 막는 cutoff가 아닙니다.

| 버튼을 누른 KST 시각 | 자동 선택 stage | 결과 의미 |
| --- | --- | --- |
| 09:00 전 | `forecast` | 현재 날짜의 신선한 장전 `openPriceRaw` 기반 예상값 |
| 09:00 이상, 15:30 미만 | `open-settlement` | 실제 시가와 장중 실제 수익률 |
| 15:30 이상 | `close-settlement` | 실제 시가·종가·거래량과 세션 수익률 |

따라서 장전 결과만 다시 확인하려면 `KOSPI forecast`, 현재 장중 시가를 반영하려면 `KOSPI open-settlement`, 마감 결과를 반영하려면 `KOSPI close-settlement`를 직접 선택할 수도 있습니다. 현재 시각에 맞는 단계를 자동으로 고르려면 항상 `KOSPI run now`를 선택하십시오. 주말·KRX 휴장일에는 시간대와 무관하게 market guard가 수집을 건너뜁니다.

| 목적 | 한국어 안내 | English instruction |
| --- | --- | --- |
| 전일 EOD 결과 | `KOSPI update-results` → **Run workflow** | Choose `KOSPI update-results` → **Run workflow** |
| 당일 기초 분석 | `KOSPI analysis` → **Run workflow** | Choose `KOSPI analysis` → **Run workflow** |
| 장전 forecast 상태 | `KOSPI forecast` → **Run workflow** | Choose `KOSPI forecast` → **Run workflow** |
| 09:00 시가 정산 | `KOSPI open-settlement` → **Run workflow** | Choose `KOSPI open-settlement` → **Run workflow** |
| 15:30 종가 정산 | `KOSPI close-settlement` → **Run workflow** | Choose `KOSPI close-settlement` → **Run workflow** |
| 현재 시각 기준 자동 실행 | `KOSPI run now` → **Run workflow** | Choose `KOSPI run now` → **Run workflow** |

버튼을 누른 뒤 입력값은 비워 두면 됩니다. 기능별 정기 실행은 scheduler keeper가 dispatch하며, 같은 날 수동으로 먼저 실행한 stage는 keeper가 다시 시작하지 않습니다. `run now`는 실행 시각 기준 stage를 자동 선택해 같은 reusable stage runner를 호출합니다. `validation.yml`은 `push` 전용 검증 workflow이며 snapshot을 수집하거나 commit하지 않습니다.

### 한국 거래일·공휴일 guard

cron의 요일 표현만으로는 한국 공휴일·대체휴일·임시공휴일을 판별할 수 없으므로, workflow는 runner에서 캡처한 실제 시작 시각과 checkout/setup 직후 [`scripts/market-session-guard.mjs`](scripts/market-session-guard.mjs)를 사용합니다. guard는 runner-captured run-start의 한국시간 날짜를 [`data/krx-market-holidays.json`](data/krx-market-holidays.json)의 한국거래소(KRX) 휴장일 계약과 대조합니다. 주말·휴장일이면 `should_run=false`로 수집을 차단하고 검증·stage 실행·commit을 모두 건너뛰므로 `data/latest-snapshot.json`과 `data/runs`를 쓰지 않습니다. 공용 stage runner는 이 경우 휴장일 건너뜀으로 정상 종료하며, stage 계산의 성공을 의미하지 않습니다. `workflow_dispatch`도 같은 guard를 통과해야 하므로 수동 실행으로 휴장일 데이터를 만들 수 없습니다.

캘린더는 연도별 체크인 JSON으로 관리합니다. `KOSPI annual market calendar update`는 매년 12월 31일 12:00 KST에 KRX 공식 휴장일 조회에서 다음 연도 목록을 받아 형식·연말 휴장일을 확인한 뒤 기존 연도를 보존하며 저장합니다. Actions에서 수동 실행도 가능하며 항상 현재 KST 기준 다음 연도를 조회합니다. 수동 실행은 기본적으로 dry run이며 실제로 갱신하려면 `dry_run`을 해제합니다. 응답이 불완전하거나 기존 휴장일이 누락되면 저장하지 않고 실패합니다. KRX 공개 일정은 연중 변경될 수 있으므로 임시휴장이나 대체휴일 변경은 별도 확인이 필요하며, 이 연간 작업은 연중 변경을 자동 감지하지 않습니다. 커버리지 밖의 평일은 `calendar_coverage_missing` 오류로 수집을 차단합니다.

각 cron stage는 해당 stage 파일과 현재 `run_date`의 선행 stage 파일만 입력으로 사용합니다. 현재 run의 선행 파일이 없으면 `data/latest-snapshot.json`을 이전 거래일 데이터로 간주해 fallback하지 않고 빈 `no_data`/차단 상태를 기록합니다. 특히 `open-settlement`와 `close-settlement`는 현재 run date와 일치하지 않는 비어 있지 않은 데이터 행을 보존하지 않습니다. 이 규칙은 stage 지연·재실행·독립 실행에서 stale 행이 `partial` snapshot으로 노출되는 것을 막습니다.

`node scripts/market-session-guard.mjs --date YYYY-MM-DD`로 특정 날짜 판정을 확인할 수 있습니다. 캘린더 파일의 `source.retrievedAt`, `source.url`, `coverage`와 각 휴장 사유는 갱신 감사에 사용합니다.

## 로컬 실행과 검증

정적 JSON을 브라우저에서 읽으므로 파일을 직접 열지 말고 HTTP 서버를 사용합니다.
backfill smoke test는 http://localhost:4173/?mode=backfill-test&date=2026-10-22 및 date=2026-10-23을 사용합니다.

```bash
python -m http.server 4173
```

`http://localhost:4173/`는 기본 `NO DATA` 화면이고 `http://localhost:4173/?mode=demo`는 숫자 없는 UI demo입니다.

```bash
npm test
npm run check
npm run pipeline:dry-run
git diff --check
```

실행 runner를 직접 확인할 때는 다음처럼 실제 snapshot을 바꾸지 않는 dry-run을 사용합니다.

```bash
node scripts/update-results.mjs --mode update-results --dry-run
node scripts/update-results.mjs --mode analysis --dry-run
node scripts/update-results.mjs --mode forecast --dry-run
node scripts/update-results.mjs --mode close-settlement --dry-run
```

## GitHub Pages와 수동 운영

저장소의 **Settings → Pages**에서 `Deploy from a branch`, branch `main`, folder `/ (root)`를 선택하면 루트 `index.html`이 제공됩니다.

1. Actions에서 목적에 맞는 기능 workflow를 선택하고 **Run workflow**를 누릅니다. 입력은 없습니다. 예를 들어 장전 상태를 확인하려면 `KOSPI forecast`, 09:00 정산을 확인하려면 `KOSPI open-settlement`, 15:30 정산을 확인하려면 `KOSPI close-settlement`를 선택합니다. GitHub CLI도 입력 없이 실행합니다.

   `gh workflow run forecast.yml --ref main`

2. provider 상태, `meta.source.source_date`/`retrieved_at`, top-level `asOfDate`, `data/latest-snapshot.json`의 단계 상태와 job summary를 확인합니다. summary의 `reference time (run start)`은 해당 수동/스케줄 실행의 기준시각입니다.
3. `forecast`/`open-settlement`/`close-settlement`은 Naver 공개 crawl의 실제 quote와 `localTradedAt` freshness를 함께 확인합니다. 시장 기준과 종목 분류가 확인되기 전에는 신선한 quote도 operational `partial`이며 신규 운영 snapshot commit을 차단합니다. 이는 라이선스를 `confirmed`로 표시하지 않으면서 무설정 Actions 실행을 허용하기 위한 정책입니다.
4. `fixture`/`demo`는 UI·계약 확인용 로컬 dry-run에서만 사용하고 운영 데이터로 해석하지 않습니다. 기능 workflow는 provider 선택을 노출하지 않습니다.
5. 문제가 있으면 해당 기능 workflow의 summary와 `data/latest-snapshot.json`의 stage 상태를 확인합니다. provider를 바꾸거나 `none`으로 우회하는 설정은 workflow에 포함하지 않습니다.

## 라이선스·위험 고지

이 저장소는 데이터 공급자의 라이선스를 대신하지 않습니다. 데이터 수집·저장·재배포 가능 여부는 원출처 약관과 관련 법규를 따라야 합니다. 이 사이트의 예상·실제 비교·오차는 투자 조언이 아니며 미래 수익, 정확도 또는 손실 회피를 보장하지 않습니다. 자세한 상태 전이와 보안 경계는 [`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md)를 참고하세요.


### 일봉 기준가 실험

정시 forecast 및 run-all은 `providers/daily-baseline-experiment.js`를 호출하고, 결과를 운영 snapshot과 별도인 `data/experiments/YYYY-MM-DD-{before-open,during-market}.json`에 최초 기록만 저장합니다. 화면의 독립 실험 영역에서 날짜와 종목을 선택합니다. 현재 거래일 장전 또는 장중에 실제로 수집한 과거 일봉 세 개를 사용하며, 가장 최근 일봉의 종가를 **예상시가가 아닌 추정 기준가**로 둡니다. 예상 종가는 기준가에 세 일봉의 종가/시가 수익률 평균을 적용한 실험값입니다. 필요한 거래일 파일이 HTTP 404면 최대 한 거래일만 건너뛰고 `stale`과 누락 날짜를 기록합니다. 기타 오류·차단, 두 거래일 결측, 장 마감 후, 과거 대상일, 수집 중 시장 단계 변경은 실패로 처리합니다. 실험 행에는 `expected_open`, `actual_open`, `actual_close`, `error` 필드를 저장하지 않습니다.

최근 실험 시도 상태는 별도 `data/experiments/YYYY-MM-DD-status.json`에 저장하며 재시도 때 갱신합니다. 상태 기록이 없으면 미실행 또는 기록 누락으로 표시하고, robots 차단·데이터 부족·수집 실패는 구분합니다. 기존 예측은 덮어쓰지 않으며 운영 snapshot과 실험의 성공 여부는 별도로 보고합니다. 상태 저장 실패도 workflow 실패로 표시합니다.

예측 파일 저장 후 상태 저장이 실패하면 같은 checkout의 재시도에서 기존 예측을 검증하고 미추적 상태일 때만 게시 후보로 선택합니다. 추적 중인 예측은 변경하지 않습니다. 파일 생성은 같은 디렉터리의 임시 파일과 원자적 링크 생성으로 충돌 시 기존 파일을 보존하며, 링크를 지원하지 않는 파일시스템은 실패합니다. 상태 파일의 게시 자체가 실패하거나 checkout이 사라지면 웹 화면에 실패를 알릴 수 없으므로 Actions 로그 확인과 재실행이 필요합니다.

## 예상 시가 출처

운영 행의 `expected_open_source`는 장전 호가 기록(`preopen_quote`), 장전 계산(`preopen_history`), 또는 장중·장후 사후 계산(`retrospective_history`)을 구분합니다. 장전 기록을 우선 보존하며 장중 현재가와 실제 시가는 예상 시가로 사용하지 않습니다. 장전 기록이 없으면 직전 3거래일 공개 일봉의 시가와 종가로 기존 사후 모델의 평균 시가 갭(±5% 제한)을 전일 종가에 적용합니다. 이력의 날짜와 수집 시각을 저장하고 화면에 표시합니다. 사후 계산은 장전에 실제 기록된 예측이 아닙니다. 필요한 이력이 없거나 출처 접근이 거부되면 해당 예상 시가는 데이터 없음이며, 원인과 상태는 source metadata와 메시지에 기록됩니다. 공개 일봉의 발행 시각·수정 여부·권리는 확인되지 않았습니다. 예상 수익률 계산식은 기존 그대로 유지합니다.

동일 run-all 실행에서 앞 단계가 수집한 장전 기록은 현재 단계의 실제 수집 시작 시각까지 인정하며, run-start 이후 기록은 동일 run ID일 때만 이어받습니다. 차단·오류 재실행은 이미 존재하는 최신 snapshot과 단계 파일을 덮어쓰지 않고 실패 상태와 원인을 실행 결과에 남깁니다.

### 예상값 근거 필드

`prior_close`는 polling quote의 종가에서 부호 있는 전일 대비(`compareToPreviousClosePriceRaw`, 하락 시 음수)를 뺀 정규시장 기준가이며 `prior_close_source=naver_polling_close_minus_change`로 표시합니다. 방향 코드(`compareToPreviousPrice.code`)와 부호가 맞지 않거나 값이 없으면 null입니다(이전에는 하락 종목에서 현재가가 저장되던 결함이 있었습니다). Naver 일봉 chart의 종가는 정규시장 종가와 다를 수 있어(예: 2026-10-26 005930 chart 213,500 vs 공개 CSV 213,000) `prior_close`로 쓰지 않고, 일봉 모델이 실제로 쓴 값은 `expected_open_basis.inputs.prior_close`에만 남깁니다. 기준가에서 시가가 형성되는 종목은 `prior_close == actual_open`이 정상입니다.

운영 행은 예상값과 함께 실제 계산에 쓴 입력만 저장합니다([`providers/forecast-basis.js`](providers/forecast-basis.js)). 새 수치를 만들지 않으며, 행 계약([`providers/provider-adapter.js`](providers/provider-adapter.js))은 저장된 입력으로 값을 다시 계산해 일치하지 않으면 행을 거부합니다.

- `expected_open_basis` (`expected_open_source`와 함께만 존재)
  - `naver_preopen_quote_open_v1`: 장전 quote의 시가(`open_price`), `quote_at`, `market_status=PREOPEN`. 계산식 없음.
  - `prior_3_sessions_open_gap_mean_capped_5pct`: 직전 거래일 종가(`prior_close_date`, `prior_close`), 두 시가 갭(`gaps[]`: 날짜·시가·앞 날짜·앞 종가·비율), `mean_gap`, ±5% 제한 후 `applied_gap`, `cap`. 예상 시가 = `prior_close × (1 + applied_gap)` (소수 둘째 자리 반올림).
- `expected_close_basis` (일봉 기반 예상 시가에만): `prior_3_sessions_gap_and_session_mean_capped_5pct`(장 마감 후 사후 평가와 같은 모델). 세 거래일 장중 수익률(`session_returns[]`: 날짜·시가·종가·비율), `mean_session_return`, ±5% 제한 후 `applied_session_return`. 예상 종가 = `expected_open × (1 + applied_session_return)`. 장전 quote 시가에는 종가 모델이 없어 `expected_close`는 null입니다.
- 예상 시가·근거·예상 종가·종가 근거는 한 묶음으로 09:00 open-settlement와 15:30 close-settlement 병합에서 보존되며, 다른 run의 값과 섞이지 않습니다. 장전 근거가 없는 장중 현재가 기준값은 기존대로 제거되고, 그 값에서 파생된 종가 근거도 함께 제거됩니다.
- 장 마감 후 사후 평가 파일(`data/runs/YYYY-MM-DD/retrospective-*.json`)의 행에도 같은 두 근거 필드가 기록됩니다.
- 기존 `data/runs` 파일은 다시 쓰지 않으므로 이전 날짜에는 근거 필드가 없습니다.
