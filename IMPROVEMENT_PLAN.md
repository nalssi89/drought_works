# 개선 계획

이 문서는 `drought_works` 권역별 누적강수 대시보드의 코드 검토 결과와 후속 작업 우선순위를 정리한 문서입니다.

## 현재 검증 상태

- `npm test`: 통과 (단위 테스트 16개, 렌더링 테스트 2개, 빌드 포함)
- `npm run lint`: 통과
- `npx tsc --noEmit`: 통과
- 단, 렌더링 테스트가 외부 기상청 응답에 의존하고 `tsconfig.json`이 Supabase Edge Function을 제외하므로 운영 코드 전체를 검증하지는 않습니다.

## 2026-08-20 적용 현황

- P0 1~3: 당일 추정 경계일, 캐시 신선도·fallback, Edge Secret·cron 인증·lease·최신 관측시각 우선 기록을 적용했습니다.
- P1 4~7: 날짜·관측시각 보존, strict 입력검증, 완료일 탐색 fallback, live 최신 화면 한정 자동갱신을 적용했습니다.
- P2 8~9 및 12~17: 지점·권역 계약검증, 정시 timestamp 파싱, Deno CI 검사, Node 버전 고정, Freshness·임계값 셀·origin allowlist·prefetch 설정을 적용했습니다.
- P2 10: 앱과 Edge Function의 계산 상수는 현재 별도 런타임 경계에 있어 완전한 코드 공유 대신 동일한 대표지점·권역 계약검증과 경계 회귀검사로 보호했습니다.
- P2 11: 단위·계약 fixture 검사는 추가했지만 서버 렌더링 검사는 아직 KMA 외부 응답을 사용합니다. CI에서는 외부 의존 렌더링 검사를 제외하고, 결정론적 fixture 분리는 후속 과제로 남겼습니다.
- 이 환경에는 Deno·Supabase CLI·PostgreSQL 클라이언트가 없어 Edge `deno check`와 migration 실DB 적용은 로컬에서 실행하지 못했습니다. `.github/workflows/quality.yml`에 Deno 검사와 앱 필수검사를 추가했습니다.

## P0 — 데이터 정확성 및 운영 안전성

### 1. 당일 추정 누적기간의 시작일 경계 오류

**위치**

- `app/lib/precipitation.ts:255-262`
- `supabase/functions/kma-hourly-cache/index.ts:152-159, 213-221`

**문제**

예를 들어 기준일이 8월 18일이고 6개월 누적을 조회하면 공식 전일 자료의 범위는 2월 18일~8월 17일입니다. 당일 추정 범위는 2월 19일~8월 18일이어야 합니다.

현재 구현은 시작일인 2월 19일의 강수를 제거하고 8월 18일을 더합니다. 따라서 2월 18일은 남고 2월 19일이 빠져 강수량과 평년값의 기간이 달라집니다. 평년값 쪽은 이미 `removedDate`를 사용하고 있어 두 계산의 경계가 불일치합니다.

**개선 방향**

- 강수량에서도 `startDate`가 아닌 `removedDate = startDate - 1일`의 RN_DAY를 제거합니다.
- 앱과 Edge Function에 동일한 경계 계산을 적용합니다.
- 시작일·제거일·종료일의 값이 서로 다른 회귀 테스트를 추가합니다.

### 2. 캐시가 오래되어도 최신 자료처럼 표시되는 문제

**위치**

- `app/lib/precipitation.ts:151-205`
- `app/page.tsx:37-53`

**문제**

`fetchedAt` 형식만 검증하고 나이를 검사하지 않습니다. 예약 갱신이 실패해도 `NOW` 화면이 오래된 값을 정상 자료처럼 보여줄 수 있으며, `fetchedAt`은 화면에 표시되지 않습니다.

**개선 방향**

- 공식·당일 모드별 최대 캐시 수명을 정의합니다.
- `fetchedAt`, 공식 기준일, 관측시각을 화면에 표시합니다.
- 오래된 캐시는 `stale` 상태로 표시하고, 가능하면 실시간 조회로 fallback합니다.
- 자동 갱신 후에도 같은 stale payload가 반복 표시되지 않는지 테스트합니다.

### 3. Supabase 갱신 엔드포인트 인증 및 동시 실행 제어

**위치**

- `supabase/functions/kma-hourly-cache/index.ts:228-273`
- `supabase/functions/kma-hourly-cache/deno.json`

**문제**

`x-kma-auth` 헤더는 길이만 확인하고 호출자가 전달한 값을 KMA 요청 인증키로 사용합니다. 또한 동시에 실행된 오래된 요청이 최신 캐시를 덮어쓸 수 있습니다.

**개선 방향**

- KMA API 키는 Edge Function 환경변수에 보관하고 요청 본문/헤더로 받지 않습니다.
- 별도의 cron secret 또는 서비스 전용 JWT를 검증합니다.
- rate limit과 DB lease/advisory lock을 적용합니다.
- `observation_time`이 더 최신인 경우에만 조건부 upsert합니다.
- 실행 ID, 시작/완료 시각, 실패 원인을 기록합니다.

> Supabase 프로젝트와 스케줄러를 외부에서 관리한다면 migration·cron 항목은 코드 결함보다 배포 문서화 과제로 분류할 수 있습니다.

## P1 — 기능 및 신뢰성

### 4. 과거 날짜에서 당일 추정 모드로 전환할 때 날짜가 사라짐

**위치**

- `app/components/controls.tsx:56-59`

**문제**

과거 날짜 화면에서 체크박스를 선택하면 `date`를 제외한 `/?period=...&intraday=1`로 이동하여 현재 최신 날짜를 조회합니다.

**개선 방향**

- 체크/해제 시 현재 날짜와 관측시각을 query에 유지합니다.
- 과거 날짜, 최신 날짜, 날짜 변경에 대한 UI 테스트를 추가합니다.

### 5. 관측시각 및 기준일 검증 강화

**위치**

- `app/lib/intraday.ts:41-45`
- `app/lib/precipitation.ts:50-55, 120-123`
- `app/lib/precipitation.ts:74-84`

**문제**

정규식만 통과한 `2026-02-30T12:00` 같은 날짜가 허용됩니다. 미래 날짜, 1973년 이전 날짜, malformed `search_date_db`도 서버에서 명확히 차단되지 않습니다.

**개선 방향**

- 날짜를 strict round-trip 방식으로 검증합니다.
- 지원 범위(1973년 이후 및 현재 KST 기준 최신 관측시각)를 서버에서도 제한합니다.
- 캐시의 `observationTime`과 `effectiveDate`의 관계를 검증합니다.
- 잘못된 입력을 최신 자료로 조용히 대체하지 말고 명시적인 오류 상태를 제공합니다.

### 6. 최신 완료일 탐색의 일시적 오류 대응

**위치**

- `app/lib/precipitation.ts:158-164`

**문제**

7일 역탐색은 `missing` 결과일 때만 계속됩니다. 최신 날짜 요청에서 일시적인 timeout·5xx가 발생하면 이전 완료일을 찾지 않고 바로 실패합니다.

**개선 방향**

- 제한된 횟수 안에서 일시적 오류를 재시도하거나 이전 날짜로 계속 탐색합니다.
- 마지막 오류를 로그에 남기고 사용자에게는 최신 성공 자료 또는 stale 자료 여부를 구분해 표시합니다.

### 7. 자동 갱신 수명주기 및 불필요한 upstream 호출

**위치**

- `app/components/auto-refresh.tsx:10-15`
- `app/page.tsx:37`
- `app/lib/refresh.ts`

**문제**

- 백그라운드 탭에서 갱신 시각이 지나가면 다시 예약되지 않습니다.
- 과거 날짜 화면에서도 매시간 `router.refresh()`가 실행됩니다.
- 당일 추정 조회는 여러 KMA API 요청을 발생시켜 탭이 많을 때 부하가 커질 수 있습니다.
- README의 “5분 간격” 설명과 실제 시간당 갱신 구현이 다릅니다.

**개선 방향**

- 최신 실시간 화면에서만 자동 갱신합니다.
- `visibilitychange`에서 복귀 시 stale 여부를 확인해 갱신합니다.
- 서버측 SWR, in-flight request deduplication, upstream 호출 제한을 적용합니다.
- README·footer·cron의 갱신 주기를 실제 구현과 일치시킵니다.

## P2 — 입력·파서·유지보수

### 8. KMA 응답의 의미 검증 강화

**위치**

- `app/lib/precipitation.ts:20-84, 211-239`
- `supabase/functions/kma-hourly-cache/index.ts:102-119`

**문제**

현재는 주로 배열 개수만 검사합니다. 지점 코드·권역 코드의 실제 집합, 중복, 유한수·음수 값, 응답 기준일과 요청일의 일치 여부가 충분히 검증되지 않습니다. 공식 응답의 rank sentinel 처리도 앱과 Edge Function 간 차이가 있습니다.

**개선 방향**

- 기대하는 66개 지점 코드와 12개/4개 집계 코드를 상수로 검증합니다.
- 중복·누락·음수 sentinel·NaN을 명확히 처리합니다.
- 공식 응답의 `search_date_db`, period, station identity를 검증합니다.
- rank가 없을 때 앱과 Edge Function 모두 `null`로 통일합니다.

### 9. 시간자료 파서 중복 및 timestamp 불일치

**위치**

- `app/lib/intraday.ts:56-76`
- `supabase/functions/kma-hourly-cache/index.ts:69-80`

**문제**

클라이언트 파서는 응답에 있는 모든 12자리 timestamp 행을 읽지만 Edge 파서는 요청 timestamp와 일치하는 행만 읽습니다. 응답에 여러 시각이 들어오면 서로 다른 값을 사용할 수 있습니다.

**개선 방향**

- 요청 timestamp를 파서 인자로 전달해 정확히 일치하는 행만 읽습니다.
- 앱과 Edge Function의 파싱 규칙을 공유하거나 동일한 fixture로 검증합니다.
- 필드 수, sentinel, 중복 station에 대한 테스트를 추가합니다.

### 10. 지역 그룹 및 계산 로직 중복

**위치**

- `app/lib/intraday.ts:20-35, 114-150`
- `supabase/functions/kma-hourly-cache/daily-rollover.ts:39-76, 130-190`

**문제**

지점 그룹, 집계, 보정 로직이 앱과 Edge Function에 복제되어 변경 시 결과가 달라질 수 있습니다.

**개선 방향**

- 공통 데이터 정의를 한 곳에서 관리하거나 생성된 상수를 사용합니다.
- 앱 계산 결과와 Edge 계산 결과가 같은지 계약 테스트를 추가합니다.

## P2 — 테스트 및 개발환경

### 11. 외부 API에 의존하는 렌더링 테스트

**위치**

- `tests/rendered-html.test.mjs:16-35`

**문제**

특정 날짜의 실시간 KMA 응답과 정확한 수치를 직접 기대하므로 외부 서버 상태와 데이터 변경에 따라 테스트가 깨집니다.

**개선 방향**

- HTTP fixture/mock으로 렌더링 테스트를 결정론적으로 만듭니다.
- `loadDashboard`, cache freshness, API 오류, intraday 경계 계산을 별도로 테스트합니다.
- Edge Function의 GET/POST/auth/DB 오류/race 조건 테스트를 추가합니다.

### 12. Edge Function이 일반 TypeScript 검사에서 제외됨

**위치**

- `tsconfig.json:24-27`

**문제**

`supabase`가 `exclude`에 있어 `npx tsc --noEmit`이 운영 Edge Function 코드를 검사하지 않습니다.

**개선 방향**

- `deno check` 또는 별도 Deno 설정을 CI에 추가합니다.
- 앱 테스트와 Edge Function 테스트를 분리해 모두 필수 검증으로 만듭니다.

### 13. Node 버전 안내 부족

**위치**

- `package.json:5-13`
- `README.md:15-25`

**문제**

프로젝트는 Node `>=22.13.0`을 요구하지만 Node 18 환경에서는 `--experimental-strip-types`와 빌드가 실패합니다.

**개선 방향**

- `.nvmrc` 또는 `.node-version`을 추가합니다.
- README에 Node 버전 검사와 설치 절차를 명시합니다.
- CI에서 지원 Node 버전을 고정합니다.

## P2 — UI 및 보안 개선

### 14. 자료 신선도와 공식/추정 상태 표시

`DESIGN.md`가 요구하는 기준일·조회시각·자료 제공 상태가 화면에 충분히 표시되지 않습니다. `fetchedAt`, `effectiveDate`, `observationTime`, `source`, `stale` 상태를 헤더 또는 Freshness 컴포넌트로 제공합니다.

### 15. 평년비 범례와 실제 셀 색상 연결

`app/globals.css:70-74`에서는 범례만 색칠되고 평년비 셀은 동일한 스타일입니다. 임계값별 셀 스타일과 텍스트/ARIA 설명을 연결하거나 범례를 제거합니다.

### 16. metadata origin allowlist

`app/layout.tsx:9-20, 40-45`는 전달된 host를 기준으로 OG/Twitter URL을 만듭니다. 배포 환경의 canonical origin allowlist를 사용해 Host header 기반 metadata 오염 가능성을 줄입니다.

### 17. 데이터 조회 링크의 불필요한 prefetch 검토

`app/components/controls.tsx`의 날짜·기간 링크는 동적 서버 조회를 유발할 수 있습니다. 페이지가 무거운 데이터 조회 페이지라면 `prefetch={false}` 또는 명시적 전환 UI를 검토합니다.

## 권장 실행 순서

1. intraday 경계 오류 수정 및 회귀 테스트
2. 날짜/관측시각 strict validation 및 과거 날짜 전환 수정
3. stale cache 표시·TTL·fallback 추가
4. 자동 갱신의 live-only/visibility 처리
5. Edge Function 인증·lock·monotonic upsert 적용
6. KMA 응답 계약 검증 및 파서 통합
7. fixture 기반 테스트·Deno check·Node 버전 고정
8. Supabase migration/cron/RLS 문서화 및 UI 개선

## 완료 기준

- intraday 누적기간의 시작일·종료일 계산이 공식 일자료와 일치한다.
- 잘못된 날짜·미래 관측시각·손상된 cache payload가 사용자에게 정상 자료로 표시되지 않는다.
- 최신 자료의 기준일과 갱신시각이 화면에 보인다.
- 백그라운드 탭 복귀 시 최신 화면이 다시 검증된다.
- 오래된 갱신 요청이 최신 cache를 덮어쓰지 않는다.
- 외부 KMA 장애를 재현하는 fixture 테스트와 Edge Function 검증이 CI에서 실행된다.
- 문서의 Node·갱신주기·배포 절차가 실제 동작과 일치한다.
