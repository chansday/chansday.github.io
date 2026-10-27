# 데이터 수집 가능성 점검 보고서

작성 기준: `naver-crawl` 운영 어댑터와 GitHub Actions workflow

## 거래일 guard 및 휴장일 데이터 계약

- workflow는 요일 cron보다 먼저 `scripts/market-session-guard.mjs`를 실행하고, KST 날짜를 `data/krx-market-holidays.json`과 대조합니다.
- 2026년 체크인 목록은 한국거래소(KRX) 휴장일 조회를 출처로 하며, 일반 공휴일뿐 아니라 근로자의 날, 대체휴일, 2026-06-03 임시공휴일, 12월 31일 연말휴장일을 포함합니다.
- 공휴일·주말은 정상 skip이고 collection/commit step을 실행하지 않습니다. 따라서 skip은 기존 snapshot이나 stale 데이터를 덮어쓰지 않습니다.
- 실행 시점에 외부 공휴일 API를 호출하지 않습니다. 매년 KRX 원문을 재확인해 JSON을 갱신해야 하며, `coverage` 밖의 평일이나 손상된 목록은 `calendar_coverage_missing`/contract error로 fail-closed합니다. API·네트워크 실패를 허용하는 fallback은 두지 않습니다.
- 대체·임시공휴일은 계산 규칙으로 추론하지 않고 KRX가 공표한 실제 휴장일을 날짜별로 기록합니다. 정부 발표나 KRX 임시 휴장 공지가 생기면 해당 연도 목록을 수동 갱신해야 합니다.

## Stage 입력과 stale 데이터 차단

- 각 stage는 동일 `run_date`의 자기 stage 파일 또는 바로 앞선 stage 파일만 읽습니다. `meta.run_date`와 `meta.run_stage`가 일치하지 않는 파일은 무시합니다.
- 자동 stage 실행은 `data/latest-snapshot.json`을 독립 입력으로 fallback하지 않습니다. 현재 run의 선행 stage가 없으면 빈 `no_data`/차단 snapshot을 기록합니다.
- `open-settlement`·`close-settlement`는 비어 있지 않은 rows의 `asOfDate`까지 현재 `run_date`와 일치해야 합니다. 이전 거래일 rows를 `partial` 결과로 보존하지 않습니다.
- 이 입력 차단은 거래일 guard 통과 후에도 적용되며, stage 누락·실행 지연·독립 cron 순서 변경이 stale 화면과 commit으로 이어지지 않도록 합니다.

## 결론

기본 운영 수집은 계좌·API key 없이 Naver 공개 market-list JSON과 polling quote endpoint를 GitHub Actions에서 제한된 batch로 가져옵니다. Naver endpoint는 공식 API가 아니며 이용정책/재배포 권한은 확인하지 않습니다. quote의 `openPriceRaw`, `closePriceRaw`, `localTradedAt`, `marketStatus`, `stockName`, `symbolCode`를 사용하고 각 행에 quote 시각과 age를 보존합니다.

## 수집 경계

| 영역 | 운영 상태 | 결과 |
|---|---|---|
| Naver 공개 market-list/quote | `naver-crawl` 기본 활성화 | KOSPI 보통주 universe와 현재 quote 저장 |
| 종목별 HTML/페이지 크롤링 | 금지 | 로그인·CAPTCHA·robots·차단 우회 없음 |
| 장전 예상시가 | `openPriceRaw`가 신선할 때만 제공 | 없으면 전일 종가 합성 없이 `no_data` |
| 종목별 수급·체결강도·분봉 | 미제공 | 정상 순위에 포함하지 않음 |
| API key가 필요한 소스 | 선택적 미연결 | Secret 없이는 호출하지 않음 |

## 시간·호출 품질 정책

- caller run-start를 KST stage 기준으로 사용하고, 실제 fetch time과 `localTradedAt`의 max age를 확인합니다.
- source timeout은 기본 8초, stage overall deadline은 기본 120초, 요청 간 기본 간격은 250ms입니다.
- quote는 최대 100개 batch로 순차 요청하고 bounded retry는 1회입니다. HTTP 403/429/challenge는 재시도하지 않고 즉시 `blocked`로 기록합니다.
- stale·빈 응답·필수 필드 결측이 있는 결과는 `partial`/`degraded`/`no_data`로 기록하고 정상 순위로 표시하지 않습니다. 09:00 이후에는 `openPriceRaw`가 `actual_open`, 장마감 후에는 `closePriceRaw`가 `actual_close`가 됩니다.
- 수집 실패 시 이전 snapshot을 당일 값으로 재사용하지 않습니다. `update-results`가 실패하면 rows를 비우고 상태를 남깁니다.

`meta.source`에는 `source_id`, `run_id`, 원본 거래일 `source_date`, `fetched_at`, `retrieved_at`, source `status`, raw/유효 행 수, `partial`, 요청·완료·실패·재시도·deadline·경과시간·예상 소요시간 metrics가 기록됩니다. snapshot `asOfDate`는 실행일이 아니라 실제 원본 거래일이며, stale 결과도 이 값을 보존합니다.

## 현재 연결된 공개 원천

- quote URL: `https://polling.finance.naver.com/api/realtime/domestic/stock/{codes}`
- universe URL: `https://m.stock.naver.com/api/stocks/marketValue/KOSPI`
- license status: `unconfirmed`; license URL은 거짓으로 만들지 않고 `null`로 저장합니다.
- Naver 공개 웹 크롤링의 지연·차단·필드 변경·이용정책·재배포 조건은 원천 약관을 따라야 하며, 이 저장소가 권리를 대신 보장하지 않습니다.

## 정확도와 시간의 trade-off

전체 CSV bulk 수집은 수백~수천 종목을 짧은 시간과 작은 호출량으로 확인하는 데 유리합니다. 반면 장전 호가·예상체결가가 없는 상태에서 가격을 추정하면 데이터가 아니라 모델 가정이 됩니다. 운영 forecast는 pre-market live forecast가 아니므로 `ready`로 표시하지 않고, historical-test만 직전 5개 공개 daily close의 `0.60 × 최근 3개 수익률 평균 - 0.10 × 최근 4개 변동성`을 ±5%로 제한한 `public_daily_momentum_volatility_v1` baseline을 사용합니다. historical-test도 실제 08:20 예측 또는 09:00 실시간 정산을 복원한 것이 아닙니다.

`npm run collection:audit`는 저장된 스냅샷의 내부 정합성만 검사하며, 공개 원천의 최신성·라이선스 변경·GitHub Actions 실행 지연을 보장하지 않습니다.
