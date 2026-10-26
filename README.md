# CHANSDAY KOSPI Signal Board

정적 GitHub Pages 프론트엔드로 KOSPI 사전예측 랭킹을 기록하고, 이후 실제 시작가·종가·수익률과 오차를 비교하기 위한 공개 관찰판입니다.

현재 저장소는 실제 금융 데이터 공급자에 연결되어 있지 않습니다. 따라서 기본 화면은 `NO DATA`/`DATA NOT CONNECTED` 상태이며, 예상값과 실제값은 임의로 생성하지 않고 `null` 또는 `—`로 유지합니다.

## 운영 원칙

- 이 사이트는 조회·기록·수동 검토용입니다. 자동매매, 주문, 브로커 연동, 거래 실행 기능을 구현하지 않습니다.
- 실제 데이터가 없을 때 숫자·수익률·정확도를 추정하거나 채우지 않습니다.
- `?mode=demo`는 UI와 스키마 확인 전용입니다. `DEMO-01`과 모든 가격/수익률 `null`은 금융 실측값이나 예측 성과가 아닙니다.
- 예측은 투자 조언이나 성과 보장이 아닙니다. 운영자는 결과를 공개하기 전에 수동으로 로그·스냅샷·라이선스 조건을 확인해야 합니다.
- 실제 공급자 연결 시 해당 공급자의 이용약관, 데이터 라이선스, 재배포·표시 조건을 먼저 확인합니다.

## 구조

```text
.
├─ index.html                         # GitHub Pages 진입점
├─ styles.css                         # 반응형 정적 UI
├─ app.js                             # 스냅샷 렌더러와 DEMO 모드
├─ data/latest-snapshot.json          # 정적 최신 스냅샷
├─ schema/market-snapshot.schema.json # 스냅샷 JSON Schema
├─ providers/provider-adapter.js      # 공급자 계약·검증 유틸리티
├─ providers/demo-provider.js         # 숫자 없는 UI 전용 DEMO 공급자
├─ scripts/update-results.mjs         # provider-aware no-op/blocked runner
├─ tests/snapshot.test.mjs            # 스냅샷·어댑터 계약 테스트
└─ .github/workflows/kospi-pipeline.yml
```

## 로컬 실행

정적 JSON은 브라우저의 `fetch`로 읽으므로 파일을 직접 여는 대신 로컬 HTTP 서버를 사용합니다.

```bash
python -m http.server 4173
```

브라우저에서 `http://localhost:4173/`를 열고, UI 전용 모드는 `http://localhost:4173/?mode=demo`에서 확인합니다.

Node.js 의존성은 없습니다. 검증 명령은 다음과 같습니다.

```bash
npm test
npm run check
npm run pipeline:dry-run
```

실행 스크립트는 기본적으로 `data/latest-snapshot.json`을 갱신합니다. 실제 파일을 바꾸지 않고 공급자 미연결 동작을 확인하려면 `--dry-run`을 사용합니다.

```bash
node scripts/update-results.mjs --mode update-results --dry-run
node scripts/update-results.mjs --mode analysis --dry-run
node scripts/update-results.mjs --mode forecast --dry-run
```

## 데이터 계약과 공급자 연결 지점

`data/latest-snapshot.json`은 정적 저장소이며 계약은 `schema/market-snapshot.schema.json`에 있습니다. 각 랭킹 행은 다음 필드를 가집니다.

| 필드 | 의미 |
| --- | --- |
| `expectedOpen` / `expectedClose` | 사전 예상 시작가·종가 |
| `expectedReturn` | 사전 예상 수익률 |
| `actualOpen` / `actualClose` | 이후 확인한 실제 시작가·종가 |
| `actualReturn` | 실제 수익률 |
| `error` | 예상과 실제의 오차 |

`providers/provider-adapter.js`가 정의한 어댑터는 `fetchPreviousDay`, `runAnalysis`, `generateForecast` 메서드와 문자열 `id`를 제공해야 합니다. 각 메서드는 검증된 `status`, `message`, `rows`를 반환해야 합니다. 현재 등록된 실제 공급자는 없으며, `scripts/update-results.mjs`의 `resolveProvider()`가 연결을 추가할 명시적인 지점입니다.

기본값과 등록되지 않은 provider는 모두 `no_data`/`blocked`로 기록됩니다. provider가 없을 때 실행되는 07:00 업데이트와 08:00 분석도 이 원칙에 따라 상태만 남기고 가격을 생성하지 않습니다.

## GitHub Actions 스케줄

`.github/workflows/kospi-pipeline.yml`은 `workflow_dispatch`와 다음 스케줄을 포함합니다. GitHub Actions의 cron은 **UTC**이므로 KST(UTC+9)로 변환했습니다. 한국은 서머타임을 사용하지 않아 변환이 고정됩니다.

| UTC cron | KST | 역할 |
| --- | --- | --- |
| `0 22 * * 0-4` | 월–금 07:00 | 전일 결과 업데이트 |
| `0 23 * * 0-4` | 월–금 08:00 | 당일 분석 |
| `30 23 * * 0-4` | 월–금 08:30 | 사전 예상 랭킹 |

UTC 날짜가 KST보다 하루 빠르므로, 예를 들어 일요일 22:00 UTC는 월요일 07:00 KST입니다. 수동 실행 시 `all`, `update-results`, `analysis`, `forecast` 중 하나를 선택할 수 있습니다.

provider 연결 전에는 Actions가 스냅샷에 blocked/no-data 상태만 기록합니다. Actions가 커밋하도록 저장소 설정의 workflow token에 Contents write 권한이 필요합니다.

### Actions secrets / variables 이름

실제 값은 저장소나 fixture에 넣지 말고 GitHub Actions 설정에만 등록합니다.

- Variable: `KOSPI_PROVIDER` — 등록된 어댑터 id. 기본값은 `none`.
- Secret: `KOSPI_PROVIDER_API_KEY` — 실제 공급자 인증키.
- Secret: `KOSPI_PROVIDER_BASE_URL` — 실제 공급자 endpoint를 secret으로 관리할 때 사용.

현재 코드에는 이 값을 이용해 외부 API를 호출하는 구현이 없습니다. 실제 연결을 추가할 때는 provider의 라이선스, 응답 스키마, 휴장일, 재시도·레이트리밋, 검증·수동 승인 절차를 함께 구현해야 합니다.

## GitHub Pages 설정

저장소의 **Settings → Pages**에서 배포 소스를 `Deploy from a branch`, branch `main`, folder `/ (root)`로 설정하면 루트의 `index.html`이 정적 사이트로 제공됩니다. Actions workflow는 스냅샷 상태를 갱신하는 용도이며 주문·거래 실행을 하지 않습니다.

## 수동 운영 절차

1. Actions에서 `KOSPI signal board pipeline`을 수동 실행하고 필요한 stage를 선택합니다.
2. 실행 로그에서 provider 상태와 `data/latest-snapshot.json` 변경 내용을 확인합니다.
3. 실제 값이 포함되는 경우 공급자 원문·라이선스·검증 결과를 사람이 확인합니다.
4. Pages에서 표시 상태를 확인하고, 문제가 있으면 provider를 `none`으로 되돌린 뒤 snapshot을 `no_data` 상태로 유지합니다.

## 라이선스·위험 고지

이 저장소는 데이터 공급자의 라이선스를 대신하지 않습니다. 지수·종목 가격·예측 데이터의 수집, 저장, 재배포 가능 여부는 공급자 약관과 관련 법규를 따릅니다. 이 화면의 예상과 비교 결과는 투자 조언이 아니며 미래 수익이나 정확도를 보장하지 않습니다.

