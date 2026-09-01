import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
