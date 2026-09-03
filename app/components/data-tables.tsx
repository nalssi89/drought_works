import type { Aggregate, DashboardData, Station } from "../lib/precipitation";
import { groupStationsByRegion, ratioCellClass } from "../lib/station-presentation";

type DashboardTableData = Pick<DashboardData, "effectiveDate" | "regions" | "admins" | "stations" | "mode">;

const REGION_LABELS = [
  "서울·인천\n경기도", "전체", "영서", "영동", "충청북도", "대전·세종\n충청남도", "전북특별\n자치도", "광주·전라남도", "대구·경상북도", "부산·울산\n경상남도", "제주특별\n자치도", "전국",
] as const;
const ADMIN_LABELS = ["중부\n(서울·경기, 강원 전체, 충북, 충남)", "남부\n(전북, 전남, 경북, 경남)", "제주특별자치도", "전국"] as const;
const NUMBER_FORMATTER = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function RegionTable({ data }: Readonly<{ data: DashboardTableData }>) {
  return (
    <div className="table-scroll region-table-scroll">
      <table className="region-matrix">
        <colgroup><col className="metric-column" /><col span={12} className="region-column" /></colgroup>
        <thead>
          <tr><th rowSpan={2} scope="col">구분</th><th rowSpan={2} scope="col">서울·인천<br />경기도</th><th colSpan={3} scope="colgroup">강원특별자치도</th>{REGION_LABELS.slice(4).map((label) => <th rowSpan={2} scope="col" key={label}>{lines(label)}</th>)}</tr>
          <tr><th scope="col">전체</th><th scope="col">영서</th><th scope="col">영동</th></tr>
        </thead>
        <tbody>
          {data.mode === "future"
            ? <ScenarioRows rows={data.regions} />
            : <>
              <MetricRow label="강수량 (mm)" cells={data.regions.map((row) => cell(row.code, format(row.precipitation)))} />
              <MetricRow label="평년값 (mm)" cells={data.regions.map((row) => cell(row.code, format(row.normal)))} />
              <MetricRow bold label="평년비 (%)" cells={data.regions.map((row) => cell(row.code, format(row.ratio), ratioCellClass(row.ratio)))} />
              <MetricRow label="강수부족량 (mm)" cells={data.regions.map((row) => cell(row.code, shortage(row)))} />
            </>}
        </tbody>
      </table>
    </div>
  );
}

export function AdminTable({ data }: Readonly<{ data: DashboardTableData }>) {
  return (
    <div className="table-scroll admin-table-scroll">
      <table className="admin-matrix">
        <colgroup><col className="metric-column" /><col span={4} /></colgroup>
        <thead><tr><th scope="col">구분</th>{ADMIN_LABELS.map((label) => <th scope="col" key={label}>{lines(label)}</th>)}</tr></thead>
        <tbody>
          {data.mode === "future"
            ? <ScenarioRows rows={data.admins} />
            : <>
              <MetricRow label="강수량 (mm)" cells={data.admins.map((row) => cell(row.code, format(row.precipitation)))} />
              <MetricRow label="평년값 (mm)" cells={data.admins.map((row) => cell(row.code, format(row.normal)))} />
              <MetricRow bold label="평년비 (%)" cells={data.admins.map((row) => cell(row.code, format(row.ratio), ratioCellClass(row.ratio)))} />
              <MetricRow label="강수부족량 (mm)" cells={data.admins.map((row) => cell(row.code, shortage(row)))} />
            </>}
        </tbody>
      </table>
    </div>
  );
}

export function StationTable({ data }: Readonly<{ data: DashboardTableData }>) {
  const groups = groupStationsByRegion(data.stations);
  const scenario = data.mode === "future";
  const columnCount = scenario ? 13 : 5;
  return (
    <details className="station-details">
      <summary>66개 대표지점 상세 보기 (권역별)</summary>
      <div className="table-scroll">
        <table className={scenario ? "station-table scenario-station-table" : "station-table"} aria-label="권역별 66개 대표지점 누적강수 상세">
          <thead>{scenario ? (
            <tr>
              <th scope="col">지점번호</th><th scope="col">지점명</th><th scope="col">기준 강수량</th><th scope="col">가정강수 반영량</th><th scope="col">미래 산출 강수량</th><th scope="col">강수량 증감</th><th scope="col">기준 평년값</th><th scope="col">미래 산출 평년값</th><th scope="col">평년값 증감</th><th scope="col">기준 평년비</th><th scope="col">미래 산출 평년비</th><th scope="col">평년비 증감 (%p)</th><th scope="col">강수부족량</th>
            </tr>
          ) : (
            <tr><th scope="col">지점번호</th><th scope="col">지점명</th><th scope="col">강수량 (mm)</th><th scope="col">평년값 (mm)</th><th scope="col">평년비 (%)</th></tr>
          )}</thead>
          {groups.map((group) => (
            <tbody className="station-region-group" key={group.key}>
              <tr className="station-region-row">
                <th colSpan={columnCount} scope="rowgroup">
                  <span className="station-region-heading"><span>{group.label}</span><span className="station-region-count">{group.stations.length}개 지점</span></span>
                </th>
              </tr>
              {group.stations.map((station) => scenario
                ? <ScenarioStationRow station={station} key={station.code} />
                : <tr key={station.code}>
                  <td>{station.code}</td><th scope="row">{station.name}</th><td>{format(station.precipitation)}</td><td>{format(station.normal)}</td><td className={ratioCellClass(station.ratio)}>{format(station.ratio)}</td>
                </tr>)}
            </tbody>
          ))}
        </table>
      </div>
    </details>
  );
}

function ScenarioRows({ rows }: Readonly<{ rows: readonly Aggregate[] }>) {
  return <>
    <MetricRow label="기준 강수량 (mm)" cells={rows.map((row) => cell(row.code, format(row.baselinePrecipitation ?? baseline(row.precipitation, row.precipitationDelta))))} />
    <MetricRow label="가정강수 반영량 (mm)" cells={rows.map((row) => cell(row.code, format(row.scenarioPrecipitation ?? 0), "scenario-rain-cell"))} />
    <MetricRow bold label="미래 산출 강수량 (mm)" cells={rows.map((row) => cell(row.code, format(row.precipitation)))} />
    <MetricRow label="강수량 증감 (mm)" cells={rows.map((row) => deltaCell(row.code, row.precipitationDelta))} />
    <MetricRow label="기준 평년값 (mm)" cells={rows.map((row) => cell(row.code, format(row.baselineNormal ?? baseline(row.normal, row.normalDelta))))} />
    <MetricRow label="미래 산출 평년값 (mm)" cells={rows.map((row) => cell(row.code, format(row.normal)))} />
    <MetricRow label="평년값 증감 (mm)" cells={rows.map((row) => deltaCell(row.code, row.normalDelta))} />
    <MetricRow bold label="기준 평년비 (%)" cells={rows.map((row) => {
      const value = row.baselineRatio ?? baseline(row.ratio, row.ratioDelta);
      return cell(row.code, format(value), ratioCellClass(value));
    })} />
    <MetricRow bold label="미래 산출 평년비 (%)" cells={rows.map((row) => cell(row.code, format(row.ratio), ratioCellClass(row.ratio)))} />
    <MetricRow label="평년비 증감 (%p)" cells={rows.map((row) => deltaCell(row.code, row.ratioDelta))} />
    <MetricRow label="강수부족량 (mm)" cells={rows.map((row) => cell(row.code, shortage(row)))} />
  </>;
}

function ScenarioStationRow({ station }: Readonly<{ station: Station }>) {
  return <tr>
    <td>{station.code}</td>
    <th scope="row">{station.name}</th>
    <td>{format(station.baselinePrecipitation ?? baseline(station.precipitation, station.precipitationDelta))}</td>
    <td className="scenario-rain-cell">{format(station.scenarioPrecipitation ?? 0)}</td>
    <td className="scenario-result-cell">{format(station.precipitation)}</td>
    <td className={deltaClass(station.precipitationDelta)}>{formatSigned(station.precipitationDelta)}</td>
    <td>{format(station.baselineNormal ?? baseline(station.normal, station.normalDelta))}</td>
    <td>{format(station.normal)}</td>
    <td className={deltaClass(station.normalDelta)}>{formatSigned(station.normalDelta)}</td>
    <td className={ratioCellClass(station.baselineRatio ?? baseline(station.ratio, station.ratioDelta))}>{format(station.baselineRatio ?? baseline(station.ratio, station.ratioDelta))}</td>
    <td className={ratioCellClass(station.ratio)}>{format(station.ratio)}</td>
    <td className={deltaClass(station.ratioDelta)}>{formatSigned(station.ratioDelta)}</td>
    <td>{shortage(station)}</td>
  </tr>;
}

type MetricCell = Readonly<{ key: string; value: string; className?: string }>;

function MetricRow({ bold = false, cells, label }: Readonly<{ bold?: boolean; cells: readonly MetricCell[]; label: string }>) {
  return <tr className={bold ? "ratio-row" : undefined}><th scope="row">{label}</th>{cells.map((item) => <td className={item.className} key={`${label}-${item.key}`}>{item.value}</td>)}</tr>;
}

function cell(key: string, value: string, className?: string): MetricCell {
  return { key, value, className };
}

function deltaCell(key: string, value: number | undefined): MetricCell {
  return cell(key, formatSigned(value), deltaClass(value));
}

function baseline(projected: number, delta: number | undefined): number {
  return projected - (delta ?? 0);
}

function shortage(row: Pick<Aggregate, "normal" | "precipitation">): string {
  const value = row.normal - row.precipitation;
  return value > 0 ? format(value) : "";
}

function format(value: number): string {
  return NUMBER_FORMATTER.format(value);
}

function formatSigned(value: number | undefined): string {
  const number = value ?? 0;
  if (number > 0) return `+${format(number)}`;
  if (number < 0) return `−${format(Math.abs(number))}`;
  return format(0);
}

function deltaClass(value: number | undefined): string {
  const number = value ?? 0;
  return number > 0 ? "scenario-delta delta-positive" : number < 0 ? "scenario-delta delta-negative" : "scenario-delta delta-zero";
}

function lines(label: string) {
  const [first, second] = label.split("\n");
  return second ? <>{first}<br />{second}</> : first;
}
