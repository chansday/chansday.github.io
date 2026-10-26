# 데이터 수집 가능성 점검 보고서

작성 기준: 원격 `main`과 동기화한 현재 제품 소스

## 결론

현재 실제로 수집·저장된 것은 `historical-test`의 공개 일별 파일 기반 KOSPI 행입니다. 운영 provider는 `none`이므로 평일 Actions가 실행되어도 실시간·장전 숫자를 만들지 않고 `no_data` 또는 `degraded` 상태를 기록합니다.

검증용 일별 스냅샷은 2026-10-22·23 각각 913행이며, 실제 관측 필드는 시가(`mkp`), 종가(`clpr`), 거래량(`trqu`)입니다. 이 데이터는 당시 08:30 스냅샷이 아니므로 과거 예측 성과로 사용하지 않습니다.

## 수집 가능성 매트릭스

| 영역 | 현재 수집됨 | 코드상 계약만 존재 | 아직 계약도 없음 | 판정 |
|---|---|---|---|---|
| 날짜·시간 | historical-test 수집시각 | KST 시장 timezone, 07:00/08:00/08:30/16:00 stage | 휴장일 캘린더·실행시각 증적 | 부분 |
| 종목 마스터 | historical-test의 코드·명칭 | ranking row의 symbol/name | 보통주 여부, 신규상장·상장폐지·거래정지 | 부분 |
| 전일/당일 가격·거래 | historical-test 실제 시가·종가·거래량 | expected/actual/error 필드 | 운영 일봉·분봉 provider | 테스트만 가능 |
| 장전 | 없음 | 없음 | 예상체결가, 10단계 호가, 잔량, 스프레드, 체결강도 | 미연결 |
| 시장·수급 | 없음 | 없음 | KOSPI200, 선물/베이시스, 환율, 업종, 외국인/기관/프로그램 | 미연결 |
| 품질 | URL·라이선스·수집시각, 중복/날짜/수치 검사 | JSON Schema, source metadata, no_data/degraded | stale threshold, 결측률 telemetry, rate-limit/retry metrics | 부분 |
| 저장·파이프라인 | latest snapshot과 단계 상태 | 4단계 상태·공개 JSON 스키마 | raw immutable archive, run ledger, alerting | 부분 |

## 시간 계약

GitHub Actions cron은 UTC이며 KST(+9)로 변환됩니다.

| KST | 단계 | 현재 상태 |
|---|---|---|
| 평일 07:00 | 전일 결과 정산 | workflow 계약만 있음; provider 미연결 |
| 평일 08:00 | 기초 분석 | workflow 계약만 있음; provider 미연결 |
| 평일 08:30 | 장전 예측 | workflow 계약만 있음; 장전 데이터 미연결 |
| 평일 09:00 | 실제 시가 | 별도 수집 계약 없음 |
| 평일 15:30 | 종가 | 별도 수집 계약 없음 |
| 평일 16:00 | 종가 정산 | workflow 계약만 있음; provider 미연결 |

예약 실행 자체는 GitHub Actions 부하에 따라 지연될 수 있으므로, 운영 시작 후 실행시각을 snapshot metadata와 Actions run으로 확인해야 합니다.

## 품질 게이트

`npm run collection:audit`는 현재 저장된 historical-test 스냅샷에 대해 다음을 검사합니다.

- 대상 날짜와 기준 입력일의 불일치 여부
- source URL의 HTTPS, 라이선스 확인, 수집시각
- 원본 행 수와 저장 행 수
- 종목코드 중복
- 시가·종가·거래량의 유효 범위
- `actual_return`과 `error` 재계산 일치성
- rank 연속성
- 4개 pipeline stage 상태

라이브 공급자가 없는 항목은 성공으로 위장하지 않습니다. 해당 값은 null이며 파이프라인은 `no_data`/`degraded`로 남겨야 합니다.

## 실행 결과 해석

```bash
npm run collection:audit
```

`pass: true`는 저장된 테스트 스냅샷의 내부 정합성만 의미합니다. 공급자 연결 성공, 실시간 호가 수집, 예측 정확도, 수익을 의미하지 않습니다.

## 다음 운영 전 필수 조건

1. 보통주·거래상태·휴장일을 제공하는 허가된 종목 마스터 계약
2. 08:00~08:30 예상체결·호가·체결강도 제공 계약
3. KOSPI200·선물/베이시스·환율·업종·수급 데이터 계약
4. rate limit, timeout, retry, stale, 결측률을 기록하는 수집기
5. 원천 raw 스냅샷과 불변 run id 저장
6. 실제 Actions 실행 및 Pages 공개 URL smoke test

