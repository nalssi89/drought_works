import { AutoRefresh } from "./components/auto-refresh";
import { Controls } from "./components/controls";
import { AdminTable, RegionTable, StationTable } from "./components/data-tables";
import { latestObservationTime, loadDashboard, parseDate, parseObservationTime, periodSchema } from "./lib/precipitation";

type PageProps = Readonly<{ searchParams: Promise<Record<string, string | readonly string[] | undefined>> }>;

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: PageProps) {
  const params = await searchParams;
  const dateValue = first(params.date);
  const requestedDate = parseDate(dateValue);
  const periodResult = periodSchema.safeParse(first(params.period));
  const period = periodResult.success ? periodResult.data : "6m";
  const intraday = first(params.intraday) === "1";
  const maximumObservationTime = latestObservationTime();
  const explicitObservationTime = parseObservationTime(first(params.time));
  const observationTime = intraday ? (explicitObservationTime ?? maximumObservationTime) : null;
  const useCachedLatest = !dateValue && (!intraday || !explicitObservationTime);
  const result = await loadDashboard(requestedDate, period, observationTime, useCachedLatest);

  if (result.kind !== "ok") {
    const date = requestedDate ?? "";
    return (
      <main className="site-shell">
        <header className="site-header"><h1>권역별 누적강수 현황</h1></header>
        {date ? <Controls date={date} period={period} intraday={intraday} observationTime={observationTime ?? `${date}T18:00`} maximumObservationTime={maximumObservationTime} liveLatest={false} /> : null}
        <section className="error-panel" role="alert"><h2>자료를 표시할 수 없습니다</h2><p>{result.kind === "missing" ? `${result.requestedDate} 기준 공식 자료가 없습니다.` : result.message}</p><a href={`/?period=${period}`}>최신 완료일로 돌아가기</a></section>
      </main>
    );
  }

  const { data } = result;
  return (
    <main className="site-shell">
      <AutoRefresh />
      <header className="site-header">
        <h1>권역별 누적강수 현황</h1>
      </header>
      <Controls date={data.effectiveDate} period={data.period} intraday={data.mode === "intraday"} observationTime={data.observationTime ?? `${data.effectiveDate}T18:00`} maximumObservationTime={maximumObservationTime} liveLatest={useCachedLatest} />
      {data.mode === "intraday" ? <p className="estimate-notice" role="note"><strong>추정 산출:</strong> 선택 시각의 공식 RN_DAY 일누적을 반영하고, 평년값은 종료일 일평년값의 경과시간 비율({Number(data.observationTime?.slice(11, 13))}/24)을 적용했습니다. 시간 평년값과 순위는 제공되지 않습니다.</p> : null}
      <section className="data-section">
        <div className="section-title">
          <h2>{data.searchPeriod}</h2>
          <div className="thresholds" aria-label="평년비 범례"><span>평년비</span><span>65%</span><span>55%</span><span>45%</span></div>
        </div>
        <RegionTable data={data} />
        <AdminTable data={data} />
        <p className="source-note">전국은 제주특별자치도 4개 지점을 제외한 62개 지점의 평균이며, 1991~2020년 기후평년값을 적용합니다.</p>
        <StationTable data={data} />
      </section>
      <footer><span>자료: <a href="https://hydro.kma.go.kr/index.do">기상청 수문기상 가뭄정보 시스템</a> · 기상청 APIHub ASOS/지상 평년값</span><span>{data.mode === "intraday" ? "당일 값은 01~23시 공식 시간관측을 사용한 참고용 추정치입니다." : "완료 일값은 매일 00:10 ASOS 00시 마감자료로 갱신됩니다."}</span></footer>
    </main>
  );
}

function first(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}
