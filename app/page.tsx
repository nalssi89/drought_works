import { AutoRefresh } from "./components/auto-refresh";
import { Controls } from "./components/controls";
import { AdminTable, RegionTable, StationTable } from "./components/data-tables";
import { FutureControls } from "./components/future-controls";
import { loadFutureDashboard } from "./lib/future-dashboard";
import {
  FUTURE_PERIOD,
  parseRainfallByRegion,
  type FutureBaseMode,
  type RainfallByRegion,
} from "./lib/future-scenario";
import {
  latestObservationTime,
  loadDashboard,
  parseDate,
  parseObservationTime,
  periodSchema,
  type DashboardData,
  type Period,
} from "./lib/precipitation";

type PageProps = Readonly<{ searchParams: Promise<Record<string, string | readonly string[] | undefined>> }>;

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: PageProps) {
  const params = await searchParams;
  const maximumObservationTime = latestObservationTime();
  if (first(params.period) === FUTURE_PERIOD) {
    return renderFuturePage(params, maximumObservationTime);
  }

  const dateValue = first(params.date);
  const requestedDate = parseDate(dateValue);
  const periodResult = periodSchema.safeParse(first(params.period));
  const period: Period = periodResult.success ? periodResult.data : "6m";
  const intraday = first(params.intraday) === "1";
  const explicitObservationTime = parseObservationTime(first(params.time));
  const observationTime = intraday ? (explicitObservationTime ?? maximumObservationTime) : null;
  const useCachedLatest = !dateValue && (!intraday || !explicitObservationTime);
  const result = await loadDashboard(requestedDate, period, observationTime, useCachedLatest);

  if (result.kind !== "ok") {
    return renderError(result.kind === "missing" ? `${result.requestedDate} 기준 공식 자료가 없습니다.` : result.message, `/?period=${period}`);
  }

  const { data } = result;
  return (
    <main className="site-shell">
      <AutoRefresh />
      <header className="site-header"><h1>권역별 누적강수 현황</h1></header>
      <Controls date={data.effectiveDate} period={data.period} intraday={data.mode === "intraday"} observationTime={data.observationTime ?? `${data.effectiveDate}T18:00`} maximumObservationTime={maximumObservationTime} liveLatest={useCachedLatest} />
      {data.mode === "intraday" ? <p className="estimate-notice" role="note"><strong>추정 산출:</strong> 선택 시각의 공식 RN_DAY 일누적을 반영하고, 평년값은 종료일 하루의 일평년값 전체를 적용해 시간과 관계없이 동일합니다. 최저순위는 직전 완료된 공식 일자료 기준입니다.</p> : null}
      {data.mode === "rollover" ? <p className="estimate-notice" role="note"><strong>잠정 완료자료:</strong> {displayDate(data.effectiveDate)} 공식 일자료에 미확정 값(-9.0)이 남아 있어, {displayDate(data.observationTime?.slice(0, 10) ?? data.effectiveDate)} 00시까지 수집된 공식 시간자료로 산출했습니다. 공식 일자료 확정 시 자동 교체됩니다.</p> : null}
      <DashboardTables data={data} />
      <footer><span>자료: <a href="https://hydro.kma.go.kr/index.do">기상청 수문기상 가뭄정보 시스템</a> · 기상청 APIHub ASOS/지상 평년값</span><span>{data.mode === "intraday" ? "당일 값은 01~23시 공식 시간관측을 사용한 참고용 추정치입니다." : data.mode === "rollover" ? "익일 00시 시간자료 기반 잠정 완료값이며 확정 일자료 확인 시 자동 교체됩니다." : "완료 일값은 매일 00:40 ASOS 00시 마감자료로 갱신됩니다."}</span></footer>
    </main>
  );
}

async function renderFuturePage(
  params: Record<string, string | readonly string[] | undefined>,
  maximumObservationTime: string,
) {
  const baseMode: FutureBaseMode = first(params.base) === "intraday" ? "intraday" : "official";
  const scenarioPeriodResult = periodSchema.safeParse(first(params.scenarioPeriod));
  const scenarioPeriod: Period = scenarioPeriodResult.success ? scenarioPeriodResult.data : "6m";
  const rainfallByRegion = parseRainfallByRegion((name) => first(params[name]));
  const result = await loadFutureDashboard({
    baseMode,
    requestedBaseDate: parseDate(first(params.date)),
    explicitObservationTime: parseObservationTime(first(params.time)),
    requestedTargetDate: parseDate(first(params.target)),
    scenarioPeriod,
    rainfallByRegion,
  });

  if (result.kind !== "ok") return renderError(result.kind === "missing" ? `${result.requestedDate} 기준 공식 자료가 없습니다.` : result.message, `/?period=${FUTURE_PERIOD}`);
  const { data } = result;
  const baseDate = data.baseEffectiveDate ?? data.effectiveDate;
  const targetDate = data.scenarioTargetDate ?? data.effectiveDate;
  const scenarioRainfall = (data.scenarioRainfall ?? rainfallByRegion) as RainfallByRegion;
  const observationTime = data.observationTime ?? maximumObservationTime;
  const fraction = data.scenarioRainfallFraction ?? 1;

  return (
    <main className="site-shell">
      <AutoRefresh />
      <header className="site-header"><h1>권역별 누적강수 현황</h1></header>
      <FutureControls
        baseMode={data.baseMode ?? baseMode}
        baseDate={baseDate}
        observationTime={observationTime}
        maximumObservationTime={maximumObservationTime}
        targetDate={targetDate}
        scenarioPeriod={data.period}
        rainfallByRegion={scenarioRainfall}
      />
      <p className="scenario-notice" role="note">
        <strong>향후 강수 시나리오:</strong> {data.baseMode === "intraday" ? `${displayDate(baseDate)} ${observationTime.slice(11, 13)}시 이후` : `${displayDate(baseDate)} 다음 날`}부터 {displayDate(targetDate)} 24시까지 입력한 권역별 총강수량이 시간상 균등하게 온다고 가정합니다. 이동기간 밖으로 빠지는 과거 강수와 평년값은 차감하고, 미래 일평년값은 날짜 수만큼 누적합니다. 0 mm는 해당 기간 무강수를 뜻합니다.
        {fraction < 0.999 ? <span> 선택한 산출기간에는 전체 가정강수의 {(fraction * 100).toFixed(1)}%가 포함됩니다.</span> : null}
      </p>
      <FutureNationalSummary data={data} />
      <DashboardTables data={data} />
      <footer><span>기준자료: {data.baseMode === "intraday" ? `${displayDate(baseDate)} ${observationTime.slice(11, 13)}시 당일 관측` : `${displayDate(baseDate)} 완료 일자료`}</span><span>시나리오는 관측·예보가 아니라 입력한 가정강수에 따른 민감도 산출입니다.</span></footer>
    </main>
  );
}

function DashboardTables({ data }: Readonly<{ data: DashboardData }>) {
  return (
    <section className="data-section">
      <div className="section-title">
        <h2>{data.searchPeriod}</h2>
        <div className="thresholds" aria-label="평년비 셀 색상 기준"><span>평년비</span><span>≤65%</span><span>≤55%</span><span>≤45%</span></div>
      </div>
      <RegionTable data={data} />
      <AdminTable data={data} />
      <p className="source-note">전국은 제주특별자치도 4개 지점을 제외한 62개 지점의 평균이며, 1991~2020년 기후평년값을 적용합니다.</p>
      <StationTable data={data} />
    </section>
  );
}

function FutureNationalSummary({ data }: Readonly<{ data: DashboardData }>) {
  const national = data.regions.find((row) => row.code === "12");
  if (!national) return null;
  const basePrecipitation = national.baselinePrecipitation ?? national.precipitation - (national.precipitationDelta ?? 0);
  const baseRatio = national.baselineRatio ?? national.ratio - (national.ratioDelta ?? 0);
  return (
    <section className="scenario-summary" aria-label="전국 시나리오 변화 요약">
      <div><span>전국 강수량</span><strong>{format(basePrecipitation)} → {format(national.precipitation)} mm</strong><small>{formatSigned(national.precipitationDelta)} mm</small></div>
      <div><span>전국 평년비</span><strong>{format(baseRatio)} → {format(national.ratio)}%</strong><small>{formatSigned(national.ratioDelta)}%p</small></div>
      <div><span>가정강수 반영</span><strong>{format(national.scenarioPrecipitation ?? 0)} mm</strong><small>전국 62개 지점 평균</small></div>
    </section>
  );
}

function renderError(message: string, href: string) {
  return (
    <main className="site-shell">
      <header className="site-header"><h1>권역별 누적강수 현황</h1></header>
      <section className="error-panel" role="alert"><h2>자료를 표시할 수 없습니다</h2><p>{message}</p><a href={href}>조회 조건으로 돌아가기</a></section>
    </main>
  );
}

function first(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function displayDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}년 ${month}월 ${day}일`;
}

function format(value: number): string {
  return new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

function formatSigned(value: number | undefined): string {
  const number = value ?? 0;
  if (number > 0) return `+${format(number)}`;
  if (number < 0) return `−${format(Math.abs(number))}`;
  return format(0);
}
