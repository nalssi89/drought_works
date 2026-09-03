import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { STATION_CODES } from "./dashboard-fixtures.mjs";

async function render(pathname) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the official six-month regional dashboard", { concurrency: false }, async () => {
  const response = await renderWithOfficialFixture("/?date=2026-08-17&period=6m");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>권역별 누적강수 현황<\/title>/);
  assert.match(html, /2026년 02월 18일 ~ 2026년 08월 17일/);
  assert.match(html, />181\.0</);
  assert.match(html, />362\.0</);
  assert.match(html, />50\.0</);
  assert.match(html, /66개 대표지점 상세 보기/);
  assert.match(html, /부산/);
  assert.match(html, /울산/);
  assert.match(html, /창원/);
  const stationTable = html.slice(html.indexOf("66개 대표지점 상세 보기"));
  const sokcho = stationTable.indexOf('<td>90</td><th scope="row">속초</th>');
  const daegwallyeong = stationTable.indexOf('<td>100</td><th scope="row">대관령</th>');
  assert.ok(sokcho >= 0 && sokcho < daegwallyeong, "90 속초가 상세 표 첫 부분에 표시되어야 합니다.");
  assert.match(html, /향후 강수/);
  assert.doesNotMatch(html, /임의기간|codex-preview|SkeletonPreview|react-loading-skeleton/);
});

test("server-renders year-to-date from January 1 and places it after the rolling year", { concurrency: false }, async () => {
  const response = await renderWithOfficialFixture("/?date=2026-08-17&period=ty");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /2026년 01월 01일 ~ 2026년 08월 17일/);
  const periods = html.slice(html.indexOf('<nav class="periods"'), html.indexOf("</nav>", html.indexOf('<nav class="periods"')));
  const rollingYear = periods.indexOf("period=12m");
  const yearToDate = periods.indexOf("period=ty");
  const future = periods.indexOf("period=future");
  assert.ok(rollingYear >= 0 && rollingYear < yearToDate && yearToDate < future);
});

test("default dashboard does not remain on August 31 when the September 1 midnight rollover is available", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const previousEnvironment = {
    cacheUrl: process.env.KMA_CACHE_URL,
    proxyKey: process.env.KMA_PROXY_ANON_KEY,
  };
  const aggregate = (code) => ({ code, normal: 100, precipitation: 50, ratio: 50, rank: null });
  const cached = {
    schemaVersion: 2,
    period: "1m",
    effectiveDate: "2026-09-01",
    mode: "rollover",
    observationTime: "2026-09-02T00:00",
    stations: STATION_CODES.map((code) => ({ code, name: String(code), normal: 100, precipitation: 50, ratio: 50 })),
    regions: Array.from({ length: 12 }, (_, index) => aggregate(String(index + 1).padStart(2, "0"))),
    admins: Array.from({ length: 4 }, (_, index) => aggregate(String(index + 1).padStart(2, "0"))),
    fetchedAt: "2026-09-02T00:00:02.000Z",
    source: "hourly",
  };
  let cacheRequests = 0;

  process.env.KMA_CACHE_URL = "https://cache.example/latest";
  process.env.KMA_PROXY_ANON_KEY = "test-key";
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.hostname, "cache.example");
    assert.equal(url.searchParams.get("period"), "1m");
    assert.equal(url.searchParams.get("mode"), "completed");
    cacheRequests += 1;
    return Response.json(cached);
  };

  try {
    const response = await render("/?period=1m");
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /value="2026-09-01"/);
    assert.match(html, /2026년 08월 02일 ~ 2026년 09월 01일/);
    assert.match(html, /시간자료 완료값/);
    assert.match(html, /매일 01:20부터 공식 일자료를 확인해 최초 확인 시 한 번 교체/);
    assert.equal(cacheRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("KMA_CACHE_URL", previousEnvironment.cacheUrl);
    restoreEnvironment("KMA_PROXY_ANON_KEY", previousEnvironment.proxyKey);
  }
});

test("renders a regional future-rainfall scenario with deltas", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const previousEnvironment = {
    proxyUrl: process.env.KMA_PROXY_URL,
    proxyKey: process.env.KMA_PROXY_ANON_KEY,
    apiKey: process.env.KMA_API_AUTH_KEY,
  };
  const normalCodes = new Set(STATION_CODES.map((code) => code === 143 ? 860 : code === 146 ? 864 : code));
  let dailyRangeRequests = 0;
  let normalRangeRequests = 0;

  process.env.KMA_PROXY_URL = "https://proxy.example/official";
  process.env.KMA_PROXY_ANON_KEY = "test-key";
  process.env.KMA_API_AUTH_KEY = "test-key-long-enough";
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.hostname, "proxy.example");
    if (url.searchParams.get("api") === "normal-range") {
      normalRangeRequests += 1;
      return new Response(normalRangeText(url, normalCodes, 2));
    }
    if (url.searchParams.get("api") === "daily") {
      dailyRangeRequests += 1;
      return new Response(dailyRangeText(url, 1));
    }
    throw new TypeError(`Unexpected proxy request: ${url.search}`);
  };

  try {
    const response = await render("/?period=future&base=official&date=2026-08-20&target=2026-09-19&scenarioPeriod=6m&rain_metro=100");
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /향후 강수 시나리오/);
    assert.match(html, /가정강수 반영량/);
    assert.match(html, /미래 산출 강수량/);
    assert.match(html, /강수부족량/);
    assert.match(html, /평년비 증감/);
    assert.match(html, /100\.0/);
    assert.ok(dailyRangeRequests > 1);
    assert.ok(normalRangeRequests >= 3);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("KMA_PROXY_URL", previousEnvironment.proxyUrl);
    restoreEnvironment("KMA_PROXY_ANON_KEY", previousEnvironment.proxyKey);
    restoreEnvironment("KMA_API_AUTH_KEY", previousEnvironment.apiKey);
  }
});

test("explicit intraday hour uses cached data and the server-side APIHub proxy", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const previousEnvironment = {
    cacheUrl: process.env.KMA_CACHE_URL,
    proxyUrl: process.env.KMA_PROXY_URL,
    proxyKey: process.env.KMA_PROXY_ANON_KEY,
    apiKey: process.env.KMA_API_AUTH_KEY,
  };
  const cached = {
    schemaVersion: 2,
    period: "6m",
    effectiveDate: "2026-08-20",
    mode: "official",
    observationTime: null,
    stations: STATION_CODES.map((code) => ({ code, name: String(code), normal: 100, precipitation: 50, ratio: 50 })),
    regions: [],
    admins: [],
    fetchedAt: "2026-08-20T15:40:02.000Z",
    source: "daily",
  };
  const normalCodes = new Set(STATION_CODES.map((code) => code === 143 ? 860 : code === 146 ? 864 : code));
  let unexpectedProxyRequests = 0;
  let proxiedHourlyRequests = 0;
  let proxiedDailyRequests = 0;
  let proxiedNormalRequests = 0;
  let directApiRequests = 0;

  process.env.KMA_CACHE_URL = "https://cache.example/latest";
  process.env.KMA_PROXY_URL = "https://proxy.example/official";
  process.env.KMA_PROXY_ANON_KEY = "test-key";
  process.env.KMA_API_AUTH_KEY = "test-key";
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "cache.example") return Response.json(cached);
    if (url.hostname === "proxy.example") {
      if (url.searchParams.get("api") === "hourly") {
        proxiedHourlyRequests += 1;
        const observation = url.searchParams.get("tm") ?? "";
        assert.equal(observation, "202608210900", "only the selected end hour should use hourly observations");
        const rows = STATION_CODES.map((code) => {
          const fields = Array.from({ length: 17 }, () => "0");
          fields[0] = observation;
          fields[1] = String(code);
          fields[16] = "1";
          return fields.join(" ");
        });
        return new Response(rows.join("\n"));
      }
      if (url.searchParams.get("api") === "daily") {
        proxiedDailyRequests += 1;
        const date = url.searchParams.get("tm1") ?? "";
        assert.equal(date, "20260221", "the removed boundary day should use the official ASOS daily total");
        const rows = STATION_CODES.map((code) => {
          const fields = Array.from({ length: 56 }, () => "0");
          fields[0] = date;
          fields[1] = String(code);
          fields[5] = "1";
          return fields.join(" ");
        });
        return new Response(rows.join("\n"));
      }
      if (url.searchParams.get("api") === "normal") {
        proxiedNormalRequests += 1;
        const rows = [...normalCodes].map((code) => `2021,${code},8,21,0,0,0,1`);
        return new Response(rows.join("\n"));
      }
      unexpectedProxyRequests += 1;
      return Response.json({ error: "unexpected proxy request" }, { status: 400 });
    }
    if (url.hostname === "apihub.kma.go.kr") {
      directApiRequests += 1;
      throw new TypeError("Sites cannot reach APIHub directly");
    }
    throw new TypeError(`Unexpected test request: ${url.origin}${url.pathname}`);
  };

  try {
    const response = await render("/?period=6m&intraday=1&time=2026-08-21T09%3A00");
    const html = await response.text();
    assert.doesNotMatch(html, /2026-08-20 기준 공식 자료가 없습니다/);
    assert.match(html, /2026년 02월 22일 00시 ~ 2026년 08월 21일 09시/);
    assert.equal(unexpectedProxyRequests, 0, "only APIHub routes should be requested");
    assert.equal(proxiedHourlyRequests, 1, "only the selected end hour should use hourly observations");
    assert.equal(proxiedDailyRequests, 1, "the removed boundary day should use ASOS daily observations");
    assert.equal(proxiedNormalRequests, 2, "both boundary normals should use the Supabase server proxy");
    assert.equal(directApiRequests, 0, "the Sites worker should not call APIHub directly");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("KMA_CACHE_URL", previousEnvironment.cacheUrl);
    restoreEnvironment("KMA_PROXY_URL", previousEnvironment.proxyUrl);
    restoreEnvironment("KMA_PROXY_ANON_KEY", previousEnvironment.proxyKey);
    restoreEnvironment("KMA_API_AUTH_KEY", previousEnvironment.apiKey);
  }
});

test("keeps production metadata, aligned tables, and removes starter artifacts", async () => {
  const [layout, page, packageJson, styles] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /generateMetadata/);
  assert.match(layout, /\/og\.png/);
  assert.match(page, /loadDashboard/);
  assert.match(page, /loadFutureDashboard/);
  const precipitation = await readFile(new URL("../app/lib/precipitation.ts", import.meta.url), "utf8");
  const apiHub = await readFile(new URL("../app/lib/api-hub.ts", import.meta.url), "utf8");
  assert.match(apiHub, /KMA_PROXY_URL/);
  assert.match(precipitation, /KMA_CACHE_URL/);
  assert.match(packageJson, /"name": "kma-regional-precip-dashboard"/);
  assert.match(styles, /\.region-matrix\s*\{\s*width:\s*100%;\s*min-width:\s*1390px;/);
  assert.match(styles, /\.region-rain-grid/);
  assert.match(styles, /\.scenario-delta/);
  assert.match(styles, /--font-title:\s*32px;/);
  assert.match(styles, /\.site-header h1\s*\{[^}]*font-weight:\s*800;/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});

async function renderWithOfficialFixture(pathname) {
  const originalFetch = globalThis.fetch;
  const previousProxyUrl = process.env.KMA_PROXY_URL;
  const previousProxyKey = process.env.KMA_PROXY_ANON_KEY;
  const previousApiKey = process.env.KMA_API_AUTH_KEY;
  const normalCodes = new Set(STATION_CODES.map((code) => code === 143 ? 860 : code === 146 ? 864 : code));
  process.env.KMA_PROXY_URL = "https://proxy.example/official";
  process.env.KMA_PROXY_ANON_KEY = "test-key";
  process.env.KMA_API_AUTH_KEY = "test-key-long-enough";
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.equal(url.hostname, "proxy.example");
    if (url.searchParams.get("api") === "daily") return new Response(dailyRangeText(url, 1));
    if (url.searchParams.get("api") === "normal-range" || url.searchParams.get("api") === "normal") {
      return new Response(normalRangeText(url, normalCodes, 2));
    }
    throw new TypeError(`Unexpected proxy request: ${url.search}`);
  };
  try {
    const response = await render(pathname);
    const body = await response.text();
    return new Response(body, { status: response.status, headers: response.headers });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("KMA_PROXY_URL", previousProxyUrl);
    restoreEnvironment("KMA_PROXY_ANON_KEY", previousProxyKey);
    restoreEnvironment("KMA_API_AUTH_KEY", previousApiKey);
  }
}

function dailyRangeText(url, rain) {
  const start = url.searchParams.get("tm1") ?? "";
  const end = url.searchParams.get("tm2") ?? "";
  return compactDatesBetween(start, end).flatMap((date) => STATION_CODES.map((code) => {
    const fields = Array.from({ length: 11 }, () => "-999");
    fields[0] = date;
    fields[1] = String(code);
    fields[5] = String(rain);
    return fields.join(" ");
  })).join("\n");
}

function normalRangeText(url, normalCodes, rain) {
  const start = `2021${String(url.searchParams.get("MM1")).padStart(2, "0")}${String(url.searchParams.get("DD1")).padStart(2, "0")}`;
  const end = `2021${String(url.searchParams.get("MM2")).padStart(2, "0")}${String(url.searchParams.get("DD2")).padStart(2, "0")}`;
  return compactDatesBetween(start, end).flatMap((date) => [...normalCodes].map((code) => [
    "2021", code, Number(date.slice(4, 6)), Number(date.slice(6, 8)), 0, 0, 0, rain,
  ].join(","))).join("\n");
}

function compactDatesBetween(start, end) {
  const dates = [];
  const value = new Date(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}T00:00:00Z`);
  while (value.toISOString().slice(0, 10).replaceAll("-", "") <= end) {
    dates.push(value.toISOString().slice(0, 10).replaceAll("-", ""));
    value.setUTCDate(value.getUTCDate() + 1);
  }
  return dates;
}

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
