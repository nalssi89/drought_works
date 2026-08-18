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
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

test("keeps production metadata and removes starter artifacts", async () => {
  const [layout, page, packageJson] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /generateMetadata/);
  assert.match(layout, /\/og\.png/);
  assert.match(page, /loadDashboard/);
  assert.match(await readFile(new URL("../app/lib/precipitation.ts", import.meta.url), "utf8"), /KMA_PROXY_URL/);
  assert.match(packageJson, /"name": "kma-regional-precip-dashboard"/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});
