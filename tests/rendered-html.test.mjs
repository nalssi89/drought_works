import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

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

test("server-renders the official six-month regional dashboard", async () => {
  const response = await render("/?date=2026-08-17&period=6m");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>권역별 누적강수 현황<\/title>/);
  assert.match(html, /2026년 02월 18일 ~ 2026년 08월 17일/);
  assert.match(html, />641\.6</);
  assert.match(html, />1,003\.2</);
  assert.match(html, />82\.3</);
  assert.match(html, /66개 대표지점 상세 보기/);
  assert.match(html, /부산/);
  assert.match(html, /울산/);
  assert.match(html, /창원/);
  const stationTable = html.slice(html.indexOf("66개 대표지점 상세 보기"));
  const sokcho = stationTable.indexOf('<td>90</td><th scope="row">속초</th>');
  const daegwallyeong = stationTable.indexOf('<td>100</td><th scope="row">대관령</th>');
  assert.ok(sokcho >= 0 && sokcho < daegwallyeong, "90 속초가 상세 표 첫 부분에 표시되어야 합니다.");
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

test("server-renders year-to-date from January 1 and places it after the rolling year", async () => {
  const response = await render("/?date=2026-08-17&period=ty");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /2026년 01월 01일 ~ 2026년 08월 17일/);
  const periods = html.slice(html.indexOf('<nav class="periods"'), html.indexOf("</nav>", html.indexOf('<nav class="periods"')));
  const rollingYear = periods.indexOf("period=12m");
  const yearToDate = periods.indexOf("period=ty");
  assert.ok(rollingYear >= 0 && rollingYear < yearToDate);
});

test("explicit intraday hour uses cached data and the server-side APIHub proxy", { concurrency: false }, async () => {
  const stationCodes = [
    108, 112, 119, 201, 202, 203, 101, 114, 211, 212, 95, 100, 105, 216, 90, 127, 131,
    135, 221, 226, 129, 133, 232, 235, 236, 238, 140, 146, 243, 244, 245, 247, 248, 156,
    165, 168, 170, 260, 261, 262, 130, 136, 138, 143, 271, 272, 273, 277, 278, 279, 281,
    152, 155, 159, 162, 192, 284, 285, 288, 289, 294, 295, 184, 185, 188, 189,
  ];
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
    stations: stationCodes.map((code) => ({ code, name: String(code), normal: 100, precipitation: 50, ratio: 50 })),
    regions: [],
    admins: [],
    fetchedAt: "2026-08-20T15:40:02.000Z",
  };
  const normalCodes = new Set(stationCodes.map((code) => code === 143 ? 860 : code === 146 ? 864 : code));
  let hydroProxyRequests = 0;
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
        const rows = stationCodes.map((code) => {
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
        const date = url.searchParams.get("tm") ?? "";
        assert.equal(date, "20260221", "the removed boundary day should use the official ASOS daily total");
        return new Response(stationCodes.map((code) => `${date} ${code} 1`).join("\n"));
      }
      if (url.searchParams.get("api") === "normal") {
        proxiedNormalRequests += 1;
        const rows = [...normalCodes].map((code) => `2021,${code},8,21,0,0,0,1`);
        return new Response(rows.join("\n"));
      }
      hydroProxyRequests += 1;
      return Response.json({ list1: [], list2: [], list_admin: [] });
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
    assert.equal(hydroProxyRequests, 0, "the unavailable Hydro aggregate should not replace a matching official cache");
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
  assert.match(page, /useCachedLatest/);
  const precipitation = await readFile(new URL("../app/lib/precipitation.ts", import.meta.url), "utf8");
  assert.match(precipitation, /KMA_PROXY_URL/);
  assert.match(precipitation, /KMA_CACHE_URL/);
  assert.match(packageJson, /"name": "kma-regional-precip-dashboard"/);
  assert.match(styles, /\.region-matrix\s*\{\s*width:\s*100%;\s*min-width:\s*1390px;/);
  assert.match(styles, /\.section-title h2\s*\{[^}]*word-break:\s*keep-all;/);
  assert.match(styles, /--font-title:\s*32px;/);
  assert.match(styles, /\.site-header h1\s*\{[^}]*font-weight:\s*800;/);
  assert.match(styles, /@media \(max-width:\s*960px\)[\s\S]*?\.thresholds\s*\{\s*align-self:\s*end;\s*\}/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
