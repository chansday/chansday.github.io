# 데이터 수집 가능성 점검 보고서

작성 기준: `public-csv` 운영 어댑터와 GitHub Actions workflow

## 결론

기본 운영 수집은 계좌·API key 없이 공개된 날짜별 전체 CSV를 GitHub Actions에서 가져옵니다. 종목별 순차 페이지 크롤링은 하지 않습니다. 현재 공개 원천에서 검증할 수 있는 값은 KOSPI 일별 시가·종가·거래량이며, 장전 호가·예상체결가·체결강도·분봉은 제공되지 않으므로 예측값을 생성하지 않습니다.

## 수집 경계

| 영역 | 운영 상태 | 결과 |
|---|---|---|
| 공개 일별 CSV | `public-csv` 기본 활성화 | KOSPI 행 일괄 수집, 시가·종가·거래량 저장 |
| 종목별 HTML/페이지 크롤링 | 금지 | 로그인·CAPTCHA·robots·차단 우회 없음 |
| 장전 예상체결·호가 | 미제공 | forecast는 `no_data`/`degraded`, 숫자 생성 없음 |
| 종목별 수급·체결강도·분봉 | 미제공 | 정상 순위에 포함하지 않음 |
| API key가 필요한 소스 | 선택적 미연결 | Secret 없이는 호출하지 않음 |

## 시간·호출 품질 정책

- forecast workflow는 08:20 KST에 시작하고 08:29:00 KST hard cutoff를 적용합니다.
- source timeout은 기본 8초, stage overall deadline은 기본 20초입니다.
- bulk 날짜 파일 탐색은 최대 동시 요청 2개로 제한합니다. 종목별 순차 호출은 사용하지 않습니다.
- HTTP 429/5xx만 최대 2회 지수 backoff하며, 재시도도 overall deadline 안에서만 허용합니다.
- 08:20 forecast 수집은 08:29 cutoff를 적용하고, 이후 도착한 값·stale 파일·중복·필수 필드 결측이 있는 결과는 `partial`/`degraded`/`no_data`로 기록하고 정상 순위로 표시하지 않습니다. 09:00 `openSettlement`는 별도 단계로 actual_open을 정산합니다.
- 수집 실패 시 이전 snapshot을 당일 값으로 재사용하지 않습니다. `update-results`가 실패하면 rows를 비우고 상태를 남깁니다.

`meta.source`에는 `source_id`, `run_id`, `fetched_at`, `retrieved_at`, source `status`, raw/유효 행 수, `partial`, 요청·완료·실패·재시도·deadline·경과시간·예상 소요시간 metrics가 기록됩니다.

## 현재 연결된 공개 원천

- URL 패턴: `https://aikstockdata.com/data/public/daily/quotes_YYYYMMDD.csv`
- 라이선스 URL: `https://aikstockdata.com/licenses/aiksd-public-1.1.txt`
- 수집 범위: `mrktCtg=KOSPI` 행. 원천에 security type이 없으면 보통주 여부를 추정하지 않습니다.
- 공개 CSV의 지연·라이선스·재배포 조건은 원천 약관을 따라야 하며, 이 저장소가 권리를 대신 보장하지 않습니다.

## 정확도와 시간의 trade-off

전체 CSV bulk 수집은 수백~수천 종목을 짧은 시간과 작은 호출량으로 확인하는 데 유리합니다. 반면 장전 호가·예상체결가가 없는 상태에서 가격을 추정하면 데이터가 아니라 모델 가정이 됩니다. 운영 forecast는 전일 종가를 그대로 쓰는 `public_baseline_no_preopen_quote`를 유지하고, historical-test는 직전 5개 공개 daily close의 `0.60 × 최근 3개 수익률 평균 - 0.10 × 최근 4개 변동성`을 ±5%로 제한한 `public_daily_momentum_volatility_v1` baseline을 사용합니다. 둘 다 실제 08:20 예측 또는 09:00 실시간 정산을 복원한 것이 아닙니다.

`npm run collection:audit`는 저장된 스냅샷의 내부 정합성만 검사하며, 공개 원천의 최신성·라이선스 변경·GitHub Actions 실행 지연을 보장하지 않습니다.
