# Historical-test stage verification

검증 목적은 2026-10-22·23의 사후 공개 일봉 스냅샷을 운영 데이터로 승격하지 않고, 07:00·08:00·08:20·09:00·15:30 단계 누적 계약을 실제 파일로 확인하는 것이다. 이 자료는 `test_only=true`, `historical_test=true`로 고정되어 있으며 운영 `data/latest-snapshot.json`을 쓰지 않는다.

## 실행 명령

```text
npm run historical-test:pipeline
npm run historical-test:verify
npm run check
npm test
npm run pipeline:dry-run
npm run replay:dry-run
npm run backfill:dry-run
npm run collection:audit
```

## 실제 생성 파일

```text
data/runs/historical-test/2026-10-22/0700.json
data/runs/historical-test/2026-10-22/0800.json
data/runs/historical-test/2026-10-22/0820.json
data/runs/historical-test/2026-10-22/0900.json
data/runs/historical-test/2026-10-22/1530.json
data/runs/historical-test/2026-10-23/0700.json
data/runs/historical-test/2026-10-23/0800.json
data/runs/historical-test/2026-10-23/0820.json
data/runs/historical-test/2026-10-23/0900.json
data/runs/historical-test/2026-10-23/1530.json
```

순서 변경 검증 파일은 다음 경로에 생성된다.

```text
data/runs/historical-test-verification/2026-10-22/normal/*.json
data/runs/historical-test-verification/2026-10-22/out-of-order/*.json
data/runs/historical-test-verification/2026-10-23/normal/*.json
data/runs/historical-test-verification/2026-10-23/out-of-order/*.json
data/runs/historical-test-verification/verification-report.json
```

순서 변경 시나리오는 `0900 → 0700 → 1530 → 0800 → 0820`이다. 모든 단계에서 `expected_open`, `expected_close`, `expected_return`이 보존되며, 최종 파일에서 다음 공식이 통과한다. 현재 historical 입력은 expected close를 제공하지 않으므로 `expected_close`, `expected_return`, `error`는 null이다.

```text
session_return = round((actual_close / actual_open - 1) × 100, 2)
expected_return = round((expected_close / expected_open - 1) × 100, 2) when both expected prices exist
error = round(session_return - expected_return, 2) when both returns exist
```

## 결과

- 날짜별 913행 생성
- 정상 순서·순서 변경 모두 `expected_*` 보존
- 재실행 가능한 결정적 파일 생성
- `session_return`은 실제 시가에서 실제 종가까지의 장중 수익률로 검증
- `error`는 실제 장중 수익률과 예상 시가→종가 수익률의 차이로 검증
- `data/latest-snapshot.json` 변경 없음
- 운영 기본 로더는 혹시 테스트 snapshot이 들어와도 `no_data`로 차단
- `historical-test` 쿼리에서만 과거 테스트 snapshot 표시

## 한계

이 파일들은 사후 공개 일봉으로 재구성한 테스트 증거다. 당시 08:20에 실시간 생성된 예측이나 실제 장전 호가 데이터가 아니다. 실시간·장전 provider가 연결되지 않은 상태에서 운영 금융값을 만들지 않는다.

## HTTP smoke 증거

최종 commit `2ccdedf` 배포 후 다음 경로를 실제 HTTP GET으로 확인했다. 모두 `200 OK`였다.

```text
https://chansday.github.io/
https://chansday.github.io/?mode=historical-test&date=2026-10-22
https://chansday.github.io/?mode=historical-test&date=2026-10-23
https://chansday.github.io/data/latest-snapshot.json
https://chansday.github.io/data/runs/historical-test/2026-10-22/0700.json
https://chansday.github.io/data/runs/historical-test/2026-10-23/1530.json
https://chansday.github.io/data/runs/historical-test-verification/verification-report.json
```

페이지 기본 snapshot은 `status=no_data`, `rows=[]`이며, 테스트 데이터는 `mode=historical-test` 쿼리 또는 명시적 테스트 파일 경로에서만 접근한다.
