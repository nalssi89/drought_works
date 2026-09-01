import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  refreshIntradayWithOfficialRetry,
  safeRefreshErrorMessage,
} from "../supabase/functions/kma-hourly-cache/official-refresh.ts";

test("accepts completed Hydro aggregates without waiting for ASOS daily confirmation", () => {
  // Given: the published Hydro refresh and raw-daily fallback are separate paths.
  const source = readFileSync(
    new URL("../supabase/functions/kma-hourly-cache/index.ts", import.meta.url),
    "utf8",
  );
  const publishedStart = source.indexOf("async function updateOfficial(");
  const fallbackStart = source.indexOf("async function updateOfficialFromDaily(");
  assert.ok(publishedStart >= 0 && fallbackStart > publishedStart);

  // When: the published refresh implementation is isolated.
  const publishedRefresh = source.slice(publishedStart, fallbackStart);

  // Then: only the fallback may depend on raw ASOS daily confirmation.
  assert.doesNotMatch(publishedRefresh, /\bconfirmedDailyRain\(/);
});

test("continues the current-day intraday refresh when official daily data is deferred", () => {
  // Given: the non-midnight rollover branch and its final intraday update.
  const source = readFileSync(
    new URL("../supabase/functions/kma-hourly-cache/index.ts", import.meta.url),
    "utf8",
  );
  const rolloverStart = source.indexOf("const expectedBaseDate");
  const responseStart = source.indexOf('return Response.json({ status: "updated", mode: "intraday"', rolloverStart);
  assert.ok(rolloverStart >= 0 && responseStart > rolloverStart);

  // When: the official-refresh guard is isolated.
  const rolloverGuard = source.slice(rolloverStart, responseStart);

  // Then: a deferred official refresh cannot return before the intraday fallback runs.
  assert.doesNotMatch(rolloverGuard, /return Response\.json\(\{\s*status: "deferred"/);
  assert.match(rolloverGuard, /refreshIntradayWithOfficialRetry/);
});

test("finishes the intraday refresh before an official retry that fails", async () => {
  // Given: the upstream official refresh fails while current-day hourly data is available.
  const officialError = new TypeError("official upstream failed");
  const callOrder: string[] = [];

  // When: the hourly refresh and official retry run independently.
  const result = await refreshIntradayWithOfficialRetry(
    async () => {
      callOrder.push("official");
      throw officialError;
    },
    async () => {
      callOrder.push("intraday");
      return "2026-09-02T08:00";
    },
  );

  // Then: hourly data advances and the official failure remains observable.
  assert.deepEqual(callOrder, ["intraday", "official"]);
  assert.equal(result.observationTime, "2026-09-02T08:00");
  assert.equal(result.official.status, "rejected");
  if (result.official.status === "rejected") assert.equal(result.official.reason, officialError);
});

test("redacts the KMA auth key from refresh failure details", () => {
  // Given: an HTTP client error contains a credential-bearing request URL.
  const error = new TypeError("GET https://example.test/data?stn=0&authKey=sensitive-value timed out");

  // When: the error is prepared for an operator log.
  const message = safeRefreshErrorMessage(error);

  // Then: the failure stays diagnostic without retaining the credential.
  assert.equal(message, "GET https://example.test/data?stn=0&authKey=[redacted] timed out");
});
