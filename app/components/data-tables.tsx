import type { Aggregate, DashboardData } from "../lib/precipitation";

const REGION_LABELS = [
  "서울·인천\n경기도", "전체", "영서", "영동", "충청북도", "대전·세종\n충청남도", "전북특별\n자치도", "광주·전라남도", "대구·경상북도", "부산·울산\n경상남도", "제주특별\n자치도", "전국",
] as const;
const ADMIN_LABELS = ["중부\n(서울·경기, 강원 전체, 충북, 충남)", "남부\n(전북, 전남, 경북, 경남)", "제주특별자치도", "전국"] as const;
const NUMBER_FORMATTER = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function RegionTable({ data }: Readonly<{ data: DashboardData }>) {
  const denominator = Number(data.effectiveDate.slice(0, 4)) - 1972;
  return (
    <div className="table-scroll region-table-scroll">
      <table className="region-matrix">
        <colgroup><col className="metric-column" /><col span={12} className="region-column" /></colgroup>
        <thead>
          <tr><th rowSpan={2} scope="col">구분</th><th rowSpan={2} scope="col">서울·인천<br />경기도</th><th colSpan={3} scope="colgroup">강원특별자치도</th>{REGION_LABELS.slice(4).map((label) => <th rowSpan={2} scope="col" key={label}>{lines(label)}</th>)}</tr>
          <tr><th scope="col">전체</th><th scope="col">영서</th><th scope="col">영동</th></tr>
        </thead>
        <tbody>
          <MetricRow label="강수량 (mm)" cells={data.regions.map((row) => ({ key: row.code, value: format(row.precipitation) }))} />
          <MetricRow label="평년값 (mm)" cells={data.regions.map((row) => ({ key: row.code, value: format(row.normal) }))} />
          <MetricRow bold label="평년비 (%)" cells={data.regions.map((row) => ({ key: row.code, value: format(row.ratio) }))} />
          <MetricRow label="강수부족량 (mm)" cells={data.regions.map((row) => ({ key: row.code, value: shortage(row) }))} />
          <MetricRow label="최저순위 (73년이후)" cells={data.regions.map((row) => ({ key: row.code, value: row.rank === null ? "—" : `${row.rank}/${denominator}` }))} />
        </tbody>
      </table>
    </div>
  );
}

export function AdminTable({ data }: Readonly<{ data: DashboardData }>) {
  const denominator = Number(data.effectiveDate.slice(0, 4)) - 1972;
  return (
    <div className="table-scroll admin-table-scroll">
      <table className="admin-matrix">
        <colgroup><col className="metric-column" /><col span={4} /></colgroup>
        <thead><tr><th scope="col">구분</th>{ADMIN_LABELS.map((label) => <th scope="col" key={label}>{lines(label)}</th>)}</tr></thead>
        <tbody>
          <MetricRow label="강수량 (mm)" cells={data.admins.map((row) => ({ key: row.code, value: format(row.precipitation) }))} />
          <MetricRow label="평년값 (mm)" cells={data.admins.map((row) => ({ key: row.code, value: format(row.normal) }))} />
          <MetricRow bold label="평년비 (%)" cells={data.admins.map((row) => ({ key: row.code, value: format(row.ratio) }))} />
          <MetricRow label="강수부족량 (mm)" cells={data.admins.map((row) => ({ key: row.code, value: shortage(row) }))} />
          <MetricRow label="최저순위 (73년이후)" cells={data.admins.map((row) => ({ key: row.code, value: row.rank === null ? "—" : `${row.rank}/${denominator}` }))} />
        </tbody>
      </table>
    </div>
  );
}

export function StationTable({ data }: Readonly<{ data: DashboardData }>) {
  return (
    <details className="station-details">
      <summary>66개 대표지점 상세 보기</summary>
      <div className="table-scroll">
        <table className="station-table">
          <thead><tr><th scope="col">지점번호</th><th scope="col">지점명</th><th scope="col">강수량 (mm)</th><th scope="col">평년값 (mm)</th><th scope="col">평년비 (%)</th></tr></thead>
          <tbody>{data.stations.map((station) => <tr key={station.code}><td>{station.code}</td><th scope="row">{station.name}</th><td>{format(station.precipitation)}</td><td>{format(station.normal)}</td><td className="ratio-value">{format(station.ratio)}</td></tr>)}</tbody>
        </table>
      </div>
    </details>
  );
}

function MetricRow({ bold = false, cells, label }: Readonly<{ bold?: boolean; cells: readonly Readonly<{ key: string; value: string }>[]; label: string }>) {
  return <tr className={bold ? "ratio-row" : undefined}><th scope="row">{label}</th>{cells.map((cell) => <td key={`${label}-${cell.key}`}>{cell.value}</td>)}</tr>;
}

function shortage(row: Aggregate): string {
  const value = row.normal - row.precipitation;
  return value > 0 ? format(value) : "";
}

function format(value: number): string {
  return NUMBER_FORMATTER.format(value);
}

function lines(label: string) {
  const [first, second] = label.split("\n");
  return second ? <>{first}<br />{second}</> : first;
}
