# 권역별 누적강수 현황

기상청 수문기상 가뭄정보 시스템의 66개 대표지점 자료를 이용해 1개월·3개월·6개월·1년 누적강수량, 1991~2020년 공식 평년값, 평년비를 조회하는 공개 대시보드입니다.

이 저장소에는 다음 작업물이 함께 들어 있습니다.

- app/: 날짜·기간·권역·66개 대표지점 조회 화면
- supabase/functions/kma-hourly-cache/: KMA 시간자료·일자료를 수집하는 Supabase Edge Function
- supabase/migrations/0001_create_kma_precip_cache.sql: 캐시 테이블 생성 SQL
- templates/가뭄양식.hwpx: 첨부한 가뭄 보고서 기본 양식
- tests/: 누적기간, 당일 시간강수 추정, 공식 일자료 전환, 화면 출력 검증

## 동작 개요

~~~text
KMA APIHub 시간자료·일자료
          │
          ▼
Supabase Edge Function ──▶ kma_precip_cache
          │                    │
          └────── KMA_CACHE_URL ┘
                         │
                         ▼
              공개 홈페이지 서버 런타임
~~~

- 공식값: 다음날 00:30 KST에 전날 ASOS 일자료(RN_DAY)를 반영합니다.
- 당일 추정값: 운영자가 설정한 매시 10분 호출 시 KMA 시간자료를 반영합니다.
- 시간자료 추정값은 당일 관측용이며, 다음날 공식 일자료가 들어오면 공식값으로 교체합니다.
- 평년값은 당일 시각에 따라 변하지 않고, 누적기간의 날짜 경계에 맞춰 공식 평년값을 조회합니다.
- 날짜와 기간을 바꾸면 별도 조회 버튼 없이 화면이 갱신됩니다.

## 요구사항

### 홈페이지

- Git
- Node.js 22.13.0 이상
- npm
- 배포할 서버리스 호스팅 또는 Sites 계정
- 예약 갱신용 Supabase 프로젝트

### KMA·Supabase 자동갱신

- 기상청 APIHub 인증키
- Supabase CLI 또는 Supabase Dashboard
- kma_precip_cache 테이블을 만들 수 있는 권한
- Edge Function을 호출할 예약 실행기
  - Supabase Cron/pg_cron, GitHub Actions, 또는 같은 기능의 서버리스 스케줄러
- Supabase URL, anon key, service-role key

### 한글파일 작성

- Kordoc MCP가 연결된 Codex 환경
- HWPX를 열어볼 한컴오피스 또는 HWPX 호환 뷰어
- 구조 검증을 수행하려면 HWPX 검증 스크립트와 Python 환경

Kordoc MCP는 Git 저장소에 포함되는 npm 패키지가 아닙니다. 따라서 git clone만으로 MCP가 설치되지는 않으며, Kordoc MCP가 연결된 실행환경에서 아래 양식 파일을 사용해야 합니다.

## 홈페이지 실행

~~~bash
git clone https://github.com/nalssi89/drought_works.git
cd drought_works
npm ci
cp .env.example .env.local
npm run dev
~~~

Windows PowerShell에서는 다음처럼 환경 파일을 복사할 수 있습니다.

~~~powershell
Copy-Item .env.example .env.local
~~~

.env.local에 실제 값을 입력합니다.

| 변수 | 용도 | 공개 여부 |
|---|---|---|
| KMA_API_AUTH_KEY | 서버 측 KMA APIHub 직접 조회용 인증키 | 절대 공개하지 않음 |
| KMA_CACHE_URL | Supabase Function의 조회 URL | 공개 가능 |
| KMA_PROXY_ANON_KEY | Supabase anon key | 공개 가능하지만 RLS·Function 설정 필요 |
| KMA_PROXY_URL | 선택적 공식자료 프록시 URL | 공개 가능 |

로컬 확인 명령은 다음과 같습니다.

~~~bash
npm run lint
npm run test:unit
npm run build
node --test tests/rendered-html.test.mjs
~~~

전체 검증은 다음 명령으로 실행합니다.

~~~bash
npm test
~~~

## Supabase 자동갱신 구성

1. Supabase 프로젝트를 만들고 CLI를 연결합니다.

   ~~~bash
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push
   ~~~

2. supabase/migrations/0001_create_kma_precip_cache.sql로 kma_precip_cache 테이블을 만듭니다.

3. Edge Function을 배포합니다.

   ~~~bash
   npx supabase functions deploy kma-hourly-cache
   ~~~

4. Supabase Function URL을 KMA_CACHE_URL로 설정합니다.

   ~~~text
   https://<project-ref>.supabase.co/functions/v1/kma-hourly-cache
   ~~~

5. 홈페이지 런타임에 KMA_CACHE_URL과 KMA_PROXY_ANON_KEY를 설정합니다. 실제 KMA 인증키와 service-role key는 .env.local, Supabase Secret, 호스팅 Secret에만 저장합니다.

6. 예약 실행기가 다음 두 종류의 POST를 호출하도록 설정합니다.

   ~~~text
   매시 10분: 10 * * * *
   매일 00:30: 30 0 * * *
   ~~~

   호출 시 Supabase JWT와 KMA 인증키를 헤더로 전달합니다.

   ~~~bash
   curl -X POST \
     "https://<project-ref>.supabase.co/functions/v1/kma-hourly-cache" \
     -H "Authorization: Bearer <supabase-anon-key>" \
     -H "apikey: <supabase-anon-key>" \
     -H "x-kma-auth: <kma-apihub-auth-key>"
   ~~~

예약 실행기와 Secret은 저장소에 커밋하지 않습니다. Function의 GET은 ?period=6m&mode=official 또는 ?period=6m&mode=intraday 형태로 캐시를 조회합니다.

## Kordoc MCP로 한글파일 작성

기본 양식은 templates/가뭄양식.hwpx입니다. 양식의 표·이미지·페이지 구조를 유지하면서 문구와 수치를 바꾸려면 Kordoc MCP의 parse_pages와 patch_document를 사용합니다.

권장 흐름:

1. templates/가뭄양식.hwpx를 Kordoc MCP로 1~2쪽 파싱합니다.
2. 파싱된 마크다운에서 날짜, 누적강수량, 평년값, 평년비, 가뭄지역 표를 수정합니다.
3. patch_document로 새 HWPX 파일을 생성합니다.
4. HWPX 네임스페이스·레이아웃·엄격 검사를 수행합니다.
5. 한컴오피스에서 실제로 열어 표와 이미지가 유지되는지 확인합니다.

개념 예시는 다음과 같습니다.

~~~text
parse_pages(
  file_path="templates/가뭄양식.hwpx",
  pages="1-2"
)

patch_document(
  file_path="templates/가뭄양식.hwpx",
  output_path="output/기상가뭄_현황_YYYYMMDD.hwpx",
  edited_markdown="<parse_pages 결과를 수정한 전체 마크다운>"
)
~~~

Kordoc MCP 호출 방법은 사용하는 Codex/MCP 배포환경에 따라 달라지므로, 인증키나 MCP 연결 설정은 저장소에 기록하지 않습니다. 생성된 파일은 output/ 같은 별도 폴더에 저장하고, 검증을 통과한 최종 양식만 필요할 때 커밋합니다.

## 배포 설정

.openai/hosting.json은 Sites 배포 프로젝트 식별자입니다. 다른 호스팅을 사용할 경우 해당 호스팅에 맞춰 다음을 설정합니다.

- Node.js 22.13.0 이상
- npm ci 후 npm run build
- 서버 런타임 환경변수 KMA_CACHE_URL, KMA_PROXY_ANON_KEY
- 선택적 직접 조회용 KMA_API_AUTH_KEY, KMA_PROXY_URL

기상청 인증키, Supabase service-role key, cron Secret은 절대로 README·소스·GitHub Actions 로그에 남기지 않습니다.
