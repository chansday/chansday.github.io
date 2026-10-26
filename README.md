# CHANSDAY KOSPI Signal Board

정적 GitHub Pages 프론트엔드로 KOSPI 사전예측 랭킹을 기록하고, 장마감 뒤 실제 결과와 오차를 비교하는 공개 관찰판입니다.

현재 기본 설정은 실제 금융 데이터 공급자를 연결하지 않습니다. 따라서 기본 화면과 Actions는 `no_data`/`degraded` 상태를 기록하고, 가격·수익률·오차를 임의로 생성하지 않습니다.

## 범위와 운영 원칙

- 종목 범위는 KOSPI 정규시장 보통주를 기본으로 합니다. KOSDAQ, ETF·ETN, 파생상품 및 우선주는 provider 설정에서 명시적으로 허용하지 않는 한 제외합니다.
- 가격 기준은 provider가 확인한 KOSPI 정규장 공식 시작가·종가이며 통화는 KRW, 시간대는 `Asia/Seoul`입니다. 조정주가·호가·추정값을 자동으로 섞지 않습니다.
- `expected_open`, `expected_close`, `expected_return`은 장전 기록이고 `actual_open`, `actual_close`, `actual_return`, `error`는 이후 정산 필드입니다. 모든 필드는 JSON Schema로 숫자 또는 `null`을 검증합니다.
- 예상은 정보 기록과 비교를 위한 값이며 정확도·수익·투자 결과를 보장하지 않습니다.
- 자동매매, 주문, 브로커 연동, 거래 실행 기능은 구현하지 않습니다.
- 실제 출처의 약관·재배포 권한이 확인되지 않으면 연결하지 않습니다. HTML 크롤링이나 우회 요청을 하지 않습니다.
- `?mode=demo`는 UI/스키마 확인 전용이며 금융 실측값이나 예측 성과를 의미하지 않습니다.

## 구조

```text
.
├─ index.html
├─ styles.css
├─ app.js
├─ data/latest-snapshot.json
├─ schema/market-snapshot.schema.json
├─ providers/provider-adapter.js
├─ providers/demo-provider.js
├─ providers/fixture-provider.js
├─ providers/public-json-provider.js
├─ data/fixtures/2026-10-22.json
├─ data/fixtures/2026-10-23.json
├─ scripts/update-results.mjs
├─ scripts/workflow-dry-run.mjs
├─ tests/snapshot.test.mjs
├─ docs/SYSTEM_DESIGN.md
└─ .github/workflows/kospi-pipeline.yml
```

## 현재 데이터 출처 상태

현재 저장소에는 활성화된 실데이터 출처가 없습니다. 기본 `KOSPI_PROVIDER`는 `none`이며, snapshot의 `meta.source`는 `null`입니다. 따라서 공개 Pages에는 `NO DATA`가 표시됩니다.

정책이 확인된 단일 공개 JSON endpoint를 연결하려면 `KOSPI_PROVIDER=public-json`과 아래 설정을 모두 명시해야 합니다. 하나라도 빠지면 adapter는 네트워크 요청 없이 `degraded`를 반환합니다.

- `KOSPI_PUBLIC_SOURCE_NAME`
- `KOSPI_PUBLIC_SOURCE_URL` — HTTPS 단일 JSON endpoint
- `KOSPI_PUBLIC_SOURCE_LICENSE_STATUS=confirmed`
- `KOSPI_PUBLIC_SOURCE_LICENSE_URL` — HTTPS 이용약관/라이선스 URL
- `KOSPI_PUBLIC_SOURCE_ALLOWED_HOSTS` — endpoint hostname의 명시적 allowlist

adapter는 한 번의 HTTPS JSON 요청만 수행하고, redirect를 거부하며, `application/json`이 아닌 응답을 거부합니다. 응답에는 `asOfDate`와 검증된 `rows`가 있어야 합니다. 성공 시 `meta.source`에 출처명·URL·라이선스 상태·라이선스 URL·수집시각을 기록합니다.

실제 API 키는 코드·fixture·snapshot에 넣지 않습니다. 향후 provider가 인증을 요구할 경우에만 GitHub Actions Secret `KOSPI_PROVIDER_API_KEY`를 사용하며, 현재 `public-json` adapter는 키를 사용하지 않습니다.

### 합성 fixture 모드

data/fixtures/2026-10-22.json과 data/fixtures/2026-10-23.json은 UI·스키마·정산 흐름을 확인하기 위한 합성 fixture입니다. 두 파일 모두 provider.id=fixture, mode=fixture, meta.isDemo=true를 명시하고, FIXTURE / SYNTHETIC ONLY 라벨과 fixture_synthetic 품질을 사용합니다. 값은 실제 종목·가격·수익률이 아니며, 실제 08:30 KST 입력 스냅샷이 없으므로 역사적 예측을 사후 재구성한 자료도 아닙니다.

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
| `30 23 * * 0-4` | 월–금 08:30 | 장전 사전예측 랭킹 |
| `0 7 * * 1-5` | 월–금 16:00 | 장마감 실제 정산 |

UTC 날짜가 KST보다 하루 빠른 오전 단계가 있으므로 `0 22 * * 0-4`는 KST 월요일 07:00에 UTC 일요일 22:00으로 실행됩니다. 장마감 단계는 KOSPI 정규장 종료 후 16:00 KST를 기준으로 하며 휴장일 또는 데이터 부족 시 상태만 기록합니다.

Actions의 `workflow_dispatch`에서는 `all`, `update-results`, `analysis`, `forecast`, `close-settlement` 중 하나와 provider(`none`, `fixture`, `demo`, `public-json`)를 선택할 수 있습니다. fixture를 고르면 두 테스트 날짜 중 하나를 추가로 선택합니다. 기본 workflow와 평일 cron은 기존 provider 설정을 사용하며 fixture를 자동 선택하지 않습니다.

## 로컬 실행과 검증

정적 JSON을 브라우저에서 읽으므로 파일을 직접 열지 말고 HTTP 서버를 사용합니다.

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
