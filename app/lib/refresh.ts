const HOUR_MS = 60 * 60_000;
const REFRESH_MINUTE = 10;
const REFRESH_SECOND = 45;

export function millisecondsUntilNextHourlyRefresh(now = new Date()): number {
  const next = new Date(now.valueOf());
  next.setUTCMinutes(REFRESH_MINUTE, REFRESH_SECOND, 0);
  if (next.valueOf() <= now.valueOf()) next.setTime(next.valueOf() + HOUR_MS);
  return next.valueOf() - now.valueOf();
}
