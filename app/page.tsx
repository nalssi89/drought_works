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
  const observationTime = intraday ? (parseObservationTime(first(params.time)) ?? maximumObservationTime) : null;
  const result = await loadDashboard(requestedDate, period, observationTime);

  if (result.kind !== "ok") {
    const date = requestedDate ?? "";
    return (
      <main className="site-shell">
        <header className="site-header"><div><p className="eyebrow">기상청 공식 일자료</p><h1>권역별 누적강수 현황</h1></div></header>
        {date ? <Controls date={date} period={period} intraday={intraday} observationTime={observationTime ?? `${date}T18:00`} maximumObservationTime={maximumObservationTime} /> : null}
        <section className="error-panel" role="alert"><h2>자료를 표시할 수 없습니다</h2><p>{result.kind === "missing" ? `${result.requestedDate} 기준 공식 자료가 없습니다.` : result.message}</p><a href={`/?period=${period}`}>최신 완료일로 돌아가기</a></section>
      </main>
    );
  }

  const { data } = result;
  return (
    <main className="site-shell">
      <AutoRefresh />
      <header className="site-header">
        <div>
          <p className="eyebrow">{data.mode === "intraday" ? "기상청 시간자료 기반 추정" : "기상청 공식 일자료"}</p>
          <h1>권역별 누적강수 현황</h1>
        </div>
        <div className="freshness"><strong>{data.mode === "intraday" ? "당일 관측 반영" : "정상 제공"}</strong><span>기준 {data.observationTime ? data.observationTime.replace("T", " ") : `${data.effectiveDate.replaceAll("-", ".")}.`}</span><span>5분 자동 재조회</span></div>
      </header>
      <Controls date={data.effectiveDate} period={data.period} intraday={data.mode === "intraday"} observationTime={data.observationTime ?? `${data.effectiveDate}T18:00`} maximumObservationTime={maximumObservationTime} />
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
      <footer><span>자료: <a href="https://hydro.kma.go.kr/index.do">기상청 수문기상 가뭄정보 시스템</a>{data.mode === "intraday" ? " · 기상청 APIHub 시간자료/지상 평년값" : ""}</span><span>{data.mode === "intraday" ? "당일 값은 공식 시간관측을 사용한 참고용 추정치입니다." : "공식 일자료는 통상 14시 이후 갱신됩니다."}</span></footer>
    </main>
  );
}

function first(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}
