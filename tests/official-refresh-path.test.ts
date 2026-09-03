import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { safeRefreshErrorMessage } from "../supabase/functions/kma-hourly-cache/official-refresh.ts";

test("derives scheduled official precipitation only from RN_DSUM daily data", () => {
  const source = readFileSync(
    new URL("../supabase/functions/kma-hourly-cache/index.ts", import.meta.url),
    "utf8",
  );
  const refreshStart = source.indexOf("async function updateOfficialFromDaily(");
  const confirmationStart = source.indexOf("async function confirmedDailyRain(");
  assert.ok(refreshStart >= 0 && confirmationStart > refreshStart);
  const refresh = source.slice(refreshStart, confirmationStart);

  assert.match(refresh, /confirmedDailyRain/);
  assert.match(refresh, /source: "daily"/);
  assert.doesNotMatch(source, /analysisAccData|HYDRO_URL|officialData\(/);
});

test("contains no legacy hydrological aggregation source", () => {
  const sources = [
    "../app/lib/precipitation.ts",
    "../app/lib/range-data.ts",
    "../supabase/functions/kma-precip-proxy/index.ts",
    "../supabase/functions/kma-hourly-cache/index.ts",
    "../supabase/functions/kma-hourly-cache/daily-rollover.ts",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

  for (const source of sources) {
    assert.doesNotMatch(source, /hydro\.kma|analysisAccData|ext\/prec|"hydro"/i);
  }
});

test("uses sts_rn RN_DSUM for every official daily rainfall request", () => {
  const cacheSource = readFileSync(
    new URL("../supabase/functions/kma-hourly-cache/index.ts", import.meta.url),
    "utf8",
  );
  const appSource = readFileSync(new URL("../app/lib/api-hub.ts", import.meta.url), "utf8");
  const proxySource = readFileSync(
    new URL("../supabase/functions/kma-precip-proxy/index.ts", import.meta.url),
    "utf8",
  );

  for (const source of [cacheSource, appSource, proxySource]) {
    assert.match(source, /sts_rn\.php/);
    assert.doesNotMatch(source, /kma_sfcdd\.php/);
  }
});

test("promotes RN_DSUM without a third precipitation source", () => {
  const source = readFileSync(
    new URL("../supabase/functions/kma-hourly-cache/index.ts", import.meta.url),
    "utf8",
  );
  const handlerStart = source.indexOf("if (forceOfficial)");
  const handlerEnd = source.indexOf("if (hour === 0)", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const officialBranch = source.slice(handlerStart, handlerEnd);

  assert.match(officialBranch, /incrementalReady[\s\S]*updateOfficialFromDaily/);
  assert.match(officialBranch, /rebuildOfficialFromDaily/);
  assert.doesNotMatch(officialBranch, /updateOfficial\(/);
  assert.match(officialBranch, /payload\.source === "daily"/);
});

test("uses the midnight hourly run to complete the previous day instead of promoting official data", () => {
  const source = readFileSync(
    new URL("../supabase/functions/kma-hourly-cache/index.ts", import.meta.url),
    "utf8",
  );
  const handlerStart = source.indexOf("const forceOfficial");
  const handlerEnd = source.indexOf("} catch (error)", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);

  assert.match(handler, /if \(forceOfficial\) \{[\s\S]*refreshOfficial\(/);
  assert.match(
    handler,
    /if \(hour === 0\) \{[\s\S]*ensureRolloverBases\(supabase, addDays\(scheduledDate, -1\), authKey\)/,
  );
  assert.match(handler, /mode: "rollover"/);
});

test("ordinary hourly runs update intraday data without retrying official promotion", () => {
  const source = readFileSync(
    new URL("../supabase/functions/kma-hourly-cache/index.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /refreshIntradayWithOfficialRetry/);
  assert.match(source, /const observationTime = await updateIntraday\(supabase, scheduledDate, authKey\)/);
});

test("schedules hourly rollover at minute 10 and retries daily promotion from 01:20 KST", () => {
  const directory = new URL("../supabase/migrations/", import.meta.url);
  const migrationName = readdirSync(directory)
    .find((name) => name.endsWith("_poll_daily_rainfall_from_0120_kst.sql"));
  assert.ok(migrationName);
  const sql = readFileSync(new URL(migrationName, directory), "utf8");

  assert.match(sql, /cron\.schedule\(\s*'refresh-kma-daily-cache',\s*'20 0-14,16-23 \* \* \*'/);
  assert.match(sql, /kma-hourly-cache\?refresh=official/);
  assert.match(sql, /payload->>'effectiveDate'/);
  assert.match(sql, /payload->>'source' = 'daily'/);
  assert.match(sql, /\) < 5/);
});

test("redacts the KMA auth key from refresh failure details", () => {
  // Given: an HTTP client error contains a credential-bearing request URL.
  const error = new TypeError("GET https://example.test/data?stn=0&authKey=sensitive-value timed out");

  // When: the error is prepared for an operator log.
  const message = safeRefreshErrorMessage(error);

  // Then: the failure stays diagnostic without retaining the credential.
  assert.equal(message, "GET https://example.test/data?stn=0&authKey=[redacted] timed out");
});
