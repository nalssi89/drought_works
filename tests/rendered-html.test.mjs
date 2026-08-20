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
