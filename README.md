# CHANSDAY KOSPI Signal Board

정적 GitHub Pages 프론트엔드로 KOSPI 사전예측 랭킹을 기록하고, 장마감 뒤 실제 결과와 오차를 비교하는 공개 관찰판입니다.

평일 운영 provider 기본값은 계좌·API 키가 필요 없는 `public-csv`입니다. 공개 일별 CSV는 장전 호가·예상체결가를 제공하지 않으므로 08:20 forecast 단계에서는 전일 정보만 이용한 `public_baseline_no_preopen_quote`를 계산하고, 고정밀 호가 기반 예측으로 표시하지 않습니다. 기본 화면의 최신 스냅샷에는 별도 `historical_test` / `TEST ONLY` 표시로 2026-10-22·23의 실제 공개 과거 일봉과 사후 계산 baseline을 연결했습니다. 당시 08:20 예측 스냅샷이나 예측 성과를 복원한 것은 아닙니다.

## 범위와 운영 원칙

+ 종목 범위는 운영 provider에서 KOSPI 정규시장 보통주를 기본으로 합니다. 이번 historical-test는 공개 원본에 security type이 없어 `mrktCtg=KOSPI` 전체 913행을 그대로 저장했으며, 이 예외를 화면과 메타데이터에 명시합니다.
- 가격 기준은 provider가 확인한 KOSPI 정규장 공식 시작가·종가이며 통화는 KRW, 시간대는 `Asia/Seoul`입니다. 조정주가·호가·추정값을 자동으로 섞지 않습니다.
- `expected_open`, `expected_return`은 09:00 시작가 목표를 위한 장전 기록이고 `actual_open`, `actual_return`, `error`는 09:00 시가 정산 필드입니다. `actual_close`는 15:30 종가 정산용이며, 시작가 테스트에서는 `expected_close`를 `null`로 둡니다. 모든 필드는 JSON Schema로 숫자 또는 `null`을 검증합니다.
- 예상은 정보 기록과 비교를 위한 값이며 정확도·수익·투자 결과를 보장하지 않습니다.
- 자동매매, 주문, 브로커 연동, 거래 실행 기능은 구현하지 않습니다.
- 실제 출처의 약관·재배포 권한이 확인되지 않으면 연결하지 않습니다. HTML 크롤링이나 우회 요청을 하지 않습니다.
- `?mode=demo`는 UI/스키마 확인 전용이며 금융 실측값이나 예측 성과를 의미하지 않습니다.

## 구조

?mode=backfill-test는 2026-10-26 오늘만 사용하는 TEST ONLY / BACKFILL 화면이며 운영 데이터와 분리되어 있습니다.

```text
.
├─ index.html
├─ styles.css
├─ app.js
├─ data/latest-snapshot.json
├─ data/runs/YYYY-MM-DD/{0700,0800,0820,0900,1530}.json
├─ schema/market-snapshot.schema.json
├─ providers/provider-adapter.js
├─ providers/demo-provider.js
├─ providers/fixture-provider.js
├─ providers/public-json-provider.js
├─ providers/public-csv-provider.js
├─ data/fixtures/2026-10-22.json
├─ data/fixtures/2026-10-23.json
├─ data/backfill-test/2026-10-22.json
├─ data/backfill-test/2026-10-23.json
├─ data/historical-test/2026-10-22.json
├─ data/historical-test/2026-10-23.json
├─ scripts/update-results.mjs
├─ scripts/collect-historical-test.mjs
├─ scripts/workflow-dry-run.mjs
├─ scripts/replay-dry-run.mjs
├─ scripts/backfill-test-dry-run.mjs
├─ tests/snapshot.test.mjs
├─ docs/SYSTEM_DESIGN.md
├─ docs/COLLECTION_AUDIT.md
└─ .github/workflows/kospi-pipeline.yml
```

## 현재 데이터 출처 상태

운영 provider 기본값은 `public-csv`이며, 평일 Actions가 명시적 allowlist의 bulk CSV만 수집합니다. `KOSPI_PROVIDER=none`으로 끄거나, 공개 원천이 늦거나 품질 검사를 통과하지 못하면 `no_data`/`partial`/`degraded` 상태로 기록합니다. 아래 historical-test 스냅샷만 별도 TEST ONLY 화면으로 실제 과거 파일을 표시합니다.

`data/historical-test/*.json`은 운영 run과 분리된 검증용 과거 스냅샷입니다. `data/latest-snapshot.json`은 화면이 읽는 최신 운영 run의 복사본이며, canonical 입력은 `data/runs/YYYY-MM-DD/*.json`에 단계별로 보존합니다. historical-test 수집기는 latest 운영 복사본을 갱신하지 않습니다.

- 출처: [한국주식데이터 일별 시세 파일](https://aikstockdata.com/data/public/daily/quotes_20261023.csv), 원천 표기: 금융위원회 공공데이터포털·한국거래소
- 라이선스: [aiksd-public-1.1](https://aikstockdata.com/licenses/aiksd-public-1.1.txt), 출처표시·비영리 이용 조건 및 공공누리 제4유형 조건을 준수해야 합니다.
- 수집일: 2026-10-26 (스냅샷의 `meta.source.retrieved_at`에 ISO 시각 기록)
- 실제 날짜/파일: 2026-10-22 → `quotes_20261022.csv`, 2026-10-23 → `quotes_20261023.csv`
- 범위: 각 원본 CSV의 `mrktCtg=KOSPI` 행 전체, 날짜별 913행. 원본 전체는 날짜별 2,778행입니다. 이 공개 파일은 security type을 제공하지 않으므로 KOSPI 행에는 우선주가 포함될 수 있으며, 빈 행을 만들거나 미수집 값을 숫자로 채우지 않았습니다. ETF 행은 원본에 없습니다.
- 저장한 실제 필드: `actual_open` = `mkp`, `actual_close` = `clpr`, `actual_volume` = `trqu`; 모두 날짜별 913행에서 결측 없이 검증했습니다.

### Historical-test / TEST ONLY

기본 화면은 최신 운영 스냅샷을 표시하며, 공급자가 없거나 수집이 차단되면 `no_data`/`degraded` 상태를 유지합니다. historical-test 날짜별 화면은 다음 주소로 별도 확인할 수 있습니다.

- `https://chansday.github.io/?mode=historical-test&date=2026-10-22`
- `https://chansday.github.io/?mode=historical-test&date=2026-10-23`

화면의 `EXPECTED` 열은 실제 예측값이 아니라 사후 계산한 임시 baseline이고, `ACTUAL` 열은 공개 일봉의 실제 시가·종가·거래량입니다. `HISTORICAL-TEST / TEST ONLY` 라벨, 출처 URL, 수집일, 범위, 행 수를 화면에 함께 표시합니다.

historical baseline은 직전 5개 거래일의 공개 일별 종가만 사용합니다. `prior_close`는 화면에서 보이지 않는 기준값으로, 계산 재현과 감사에만 저장합니다. `features`에는 전일 수익률, 최근 3개 수익률 평균(momentum), 최근 4개 수익률의 모집단 표준편차(volatility)를 함께 저장합니다.

```text
forecast input through 2026-10-22:
  returns         = each prior close / previous close - 1
  momentum        = mean(last 3 daily returns)
  volatility      = population standard deviation(last 4 daily returns)
  expected_return = clamp(round(0.60 × momentum - 0.10 × volatility, 2), -5%, +5%)
  expected_open   = round(prior_close × (1 + expected_return / 100), 2)
  expected_close  = null (this test targets the 09:00 open)
  actual_return   = round((actual_open / prior_close - 1) × 100, 2)
  error           = actual_return - expected_return
```

2026-10-22 forecast는 `10-15, 10-16, 10-19, 10-20, 10-21`, 2026-10-23 forecast는 `10-16, 10-19, 10-20, 10-21, 10-22` 공개 daily CSV를 사용합니다. 대상 날짜의 actual 값은 forecast 입력에 사용하지 않습니다. `expected_return`은 더 이상 0% 고정이 아니지만, 이 값은 장전 호가·예상체결가·호가잔량을 사용하지 않은 설명 가능한 사후 baseline입니다. 당시 08:20에 실제로 게시된 예측이 아니고 과거 운영 성과나 수익을 보장하지 않습니다. `confidence`는 pre-open quote 부재 정책에 따라 `null`입니다.

원본을 다시 수집하고 두 스냅샷을 재생성하는 명령은 다음과 같습니다. 실제 API 키·주문·자동매매는 필요하지 않습니다.

```bash
npm run historical-test:collect
```

이 경로는 평일 운영 cron, `KOSPI_PROVIDER`, `public-csv` 운영 수집, 기존 합성 fixture/replay/backfill 파일과 분리되어 있습니다.

### 공개 bulk 수집 전략과 08:20 cutoff

운영 수집은 종목별 페이지를 순차 크롤링하지 않습니다. 기본 경로는 공개된 날짜별 전체 CSV 한 파일을 가져와 KOSPI 행을 일괄 파싱하는 방식입니다. 로그인·CAPTCHA·robots 차단·redirect·HTML 페이지를 우회하지 않으며, 명시적 allowlist인 `aikstockdata.com` 외 호스트는 거부합니다.

- Actions forecast job은 08:20 KST에 시작하고, 수집기는 08:29:00 KST hard cutoff를 적용합니다. cutoff 이후 도착한 결과는 당일 값으로 재사용하지 않습니다. 09:00 단계는 별도의 `open-settlement` 계약으로 실제 시작가를 정산합니다.
- source별 timeout(기본 8초), stage별 overall deadline(기본 20초), 최대 동시 요청 2개, 429/5xx에 대한 최대 2회 지수 backoff를 적용합니다.
- deadline 초과·중복·필수 필드 결측·오래된 파일은 `partial`/`degraded`/`no_data`로 기록하고 정상 순위로 표시하지 않습니다. 이전 snapshot을 당일 결과처럼 재사용하지 않습니다.
- `meta.source`에는 source id, run id, fetched/retrieved 시각, source 상태, raw/유효 행 수, partial 여부와 요청·재시도·경과·예상 소요시간 metrics를 기록합니다.
- 전체 CSV는 빠르고 호출량이 작지만 장전 호가·예상체결가·체결강도·분봉을 제공하지 않습니다. 따라서 데이터 범위를 늘리는 것보다 정확도·시간 경계를 지키는 것을 우선하며, 없는 예측값은 생성하지 않습니다.

정책이 확인된 단일 공개 JSON endpoint를 연결하려면 `KOSPI_PROVIDER=public-json`과 아래 설정을 모두 명시해야 합니다. 하나라도 빠지면 adapter는 네트워크 요청 없이 `degraded`를 반환합니다.

- `KOSPI_PUBLIC_SOURCE_NAME`
- `KOSPI_PUBLIC_SOURCE_URL` — HTTPS 단일 JSON endpoint
- `KOSPI_PUBLIC_SOURCE_LICENSE_STATUS=confirmed`
- `KOSPI_PUBLIC_SOURCE_LICENSE_URL` — HTTPS 이용약관/라이선스 URL
- `KOSPI_PUBLIC_SOURCE_ALLOWED_HOSTS` — endpoint hostname의 명시적 allowlist

adapter는 단일 HTTPS JSON endpoint만 사용하고, redirect를 거부하며, `application/json`이 아닌 응답을 거부합니다. source timeout·overall deadline·429/5xx bounded backoff를 적용하고 응답에는 `asOfDate`와 검증된 `rows`가 있어야 합니다. 성공 시 `meta.source`에 출처명·URL·라이선스 상태·라이선스 URL·수집시각·run id·metrics를 기록합니다.

실제 API 키는 코드·fixture·snapshot에 넣지 않습니다. 향후 provider가 인증을 요구할 경우에만 GitHub Actions Secret `KOSPI_PROVIDER_API_KEY`를 사용하며, 현재 `public-json` adapter는 키를 사용하지 않습니다.

운영 단계 저장은 `node scripts/update-results.mjs --mode <stage> --run-date YYYY-MM-DD`로 수행합니다. 기본 단계 시각은 KST 07:00, 08:00, 08:20, 09:00, 15:30으로 고정되어 동일 입력 재실행 시 JSON 내용이 달라지지 않습니다. 09:00은 `actual_open`/`actual_return`만, 15:30은 `actual_close`/`actual_volume`만 이전 단계에 병합하며 expected 필드는 보존합니다. `--dry-run`은 파일을 쓰지 않습니다.

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

2026-10-26의 backfill 테스트는 운영 data/latest-snapshot.json, 실제 provider 설정, 평일 Actions cron과 엄격히 분리되어 있습니다. 다음 주소는 기존 합성 replay의 expected_open/close/return 및 actual_open/close/return/error 숫자 흐름을 테스트 입력으로 채운 화면을 엽니다.

- https://chansday.github.io/?mode=backfill-test&date=2026-10-22
- https://chansday.github.io/?mode=backfill-test&date=2026-10-23

스냅샷은 mode=backfill_test, provider.id=backfill-test, meta.isDemo=true, meta.backfill=true를 사용하며 화면에 TEST ONLY / BACKFILL 라벨을 표시합니다. 08:20 KST 실제 원천 스냅샷이 없으므로 과거 08:20 예측을 재구성하지 않았고, 미래 데이터 누수를 막기 위해 날짜를 두 테스트 날짜로만 제한합니다. 숫자는 실제 금융 데이터·실적·예측 성과가 아닙니다.

두 날짜를 실제 파일에 쓰지 않는 dry-run으로 확인합니다.

~~~bash
npm run backfill:dry-run -- --date 2026-10-22
npm run backfill:dry-run -- --date 2026-10-23
~~~

이 경로는 2026-10-26 테스트 전용입니다. 2026-10-27부터 운영 모드는 backfill/replay가 아니라 설정된 실제 provider를 사용해야 하며, 실제 provider가 없거나 출처·라이선스가 확인되지 않으면 기존 정책대로 no_data/degraded를 유지합니다. backfill 테스트는 cron에 연결되지 않습니다.

### 합성 fixture 모드

data/fixtures/2026-10-22.json과 data/fixtures/2026-10-23.json은 UI·스키마·정산 흐름을 확인하기 위한 합성 fixture입니다. 두 파일 모두 provider.id=fixture, mode=fixture, meta.isDemo=true를 명시하고, FIXTURE / SYNTHETIC ONLY 라벨과 fixture_synthetic 품질을 사용합니다. 값은 실제 종목·가격·수익률이 아니며, 실제 08:20 KST 입력 스냅샷이 없으므로 역사적 예측을 사후 재구성한 자료도 아닙니다.

운영 cron은 fixture를 사용하지 않습니다. Actions의 workflow_dispatch에서 provider=fixture와 fixture_date=2026-10-22 또는 2026-10-23을 선택하거나, 로컬에서 다음처럼 스냅샷을 쓰지 않는 dry-run을 실행할 수 있습니다.

~~~
node scripts/update-results.mjs --provider fixture --fixture-date 2026-10-22 --mode forecast --dry-run
npm run pipeline:dry-run -- --provider fixture --fixture-date 2026-10-23
~~~

브라우저에서는 ?mode=fixture&date=2026-10-22 또는 ?mode=fixture&date=2026-10-23을 사용합니다. 화면에는 FIXTURE / SYNTHETIC ONLY와 SYN 접두사가 표시됩니다.

## GitHub Actions 실행 시각

GitHub Actions cron은 **UTC 기준**입니다. 한국 표준시(KST)는 UTC+9이고 서머타임이 없으므로 다음처럼 고정 변환합니다.

| UTC cron | KST 실행 | 단계 |
| --- | --- | --- |
| `0 22 * * 0-4` | 월–금 07:00 | 전일 결과 업데이트 |
| `0 23 * * 0-4` | 월–금 08:00 | 당일 기초 분석 |
| `20 23 * * 0-4` | 월–금 08:20 | 08:29 cutoff 전 공개 bulk 수집·장전 상태 기록 |
| `0 0 * * 1-5` | 월–금 09:00 | 실제 시작가 정산 |
| `30 6 * * 1-5` | 월–금 15:30 | 장마감 실제 정산 |

UTC 날짜가 KST보다 하루 빠른 오전 단계가 있으므로 `0 22 * * 0-4`는 KST 월요일 07:00에 UTC 일요일 22:00으로 실행됩니다. 09:00 시가와 15:30 종가 단계는 공개 일별 CSV가 장중에 제공되지 않으면 `no_data`로 남으며, 이전 snapshot을 재사용하지 않습니다.

Actions의 `workflow_dispatch`에서는 `all`, `update-results`, `analysis`, `forecast`, `close-settlement` 중 하나와 provider(`none`, `fixture`, `demo`, `public-json`, `public-csv`)를 선택할 수 있습니다. 기본 workflow와 평일 cron은 `public-csv`를 사용하며 fixture를 자동 선택하지 않습니다. `public-csv`는 계좌·API 키·Secret 없이 실행됩니다.

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

1. Actions에서 `KOSPI signal board pipeline`을 수동 실행합니다.
2. provider 상태, 출처 메타데이터, `data/latest-snapshot.json`의 단계 상태를 확인합니다.
3. 실제 숫자가 포함되는 경우 원출처·라이선스·수집시각·정규시장 기준을 수동 검토합니다.
4. 문제가 있으면 `KOSPI_PROVIDER=none`으로 되돌리고 `no_data` 상태를 유지합니다.

## 라이선스·위험 고지

이 저장소는 데이터 공급자의 라이선스를 대신하지 않습니다. 데이터 수집·저장·재배포 가능 여부는 원출처 약관과 관련 법규를 따라야 합니다. 이 사이트의 예상·실제 비교·오차는 투자 조언이 아니며 미래 수익, 정확도 또는 손실 회피를 보장하지 않습니다. 자세한 상태 전이와 보안 경계는 [`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md)를 참고하세요.
