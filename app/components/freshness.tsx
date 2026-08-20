import type { DashboardData } from "../lib/precipitation";

const SOURCE_LABELS = {
  hydro: "기상청 공식 권역자료",
  daily: "ASOS 공식 일자료",
  intraday: "당일 시간자료 추정",
} as const;

const DATE_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function Freshness({ data }: Readonly<{ data: DashboardData }>) {
  return (
    <div className={data.stale ? "freshness stale" : "freshness"} aria-live="polite">
      <strong>{data.stale ? "자료 확인 필요" : SOURCE_LABELS[data.source]}</strong>
      <span>기준일 {data.effectiveDate}</span>
      <span>조회자료 갱신 {formatDate(data.fetchedAt)}</span>
      {data.stale ? <span>자동 갱신 지연으로 {data.ageMinutes}분 지난 자료입니다.</span> : null}
    </div>
  );
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "시각 확인 불가" : DATE_FORMATTER.format(parsed);
}
