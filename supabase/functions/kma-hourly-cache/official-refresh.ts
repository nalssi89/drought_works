export class OfficialDataUnavailableError extends Error {
  constructor() {
    super("official daily base is unavailable");
    this.name = "OfficialDataUnavailableError";
  }
}

export async function refreshOfficial(
  update: () => Promise<void>,
  fallback?: () => Promise<void>,
): Promise<"updated" | "deferred"> {
  try {
    await update();
    return "updated";
  } catch (error) {
    if (!(error instanceof OfficialDataUnavailableError)) throw error;
    if (!fallback) return "deferred";
    try {
      await fallback();
      return "updated";
    } catch (fallbackError) {
      if (fallbackError instanceof OfficialDataUnavailableError) return "deferred";
      throw fallbackError;
    }
  }
}

export function safeRefreshErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "unknown failure";
  return error.message.replaceAll(/([?&]authKey=)[^&\s]+/g, "$1[redacted]");
}

export async function refreshIntradayWithOfficialRetry(
  officialRefresh: () => Promise<"updated" | "deferred">,
  intradayRefresh: () => Promise<string>,
): Promise<Readonly<{
  observationTime: string;
  official: PromiseSettledResult<"updated" | "deferred">;
}>> {
  const [official] = await Promise.allSettled([officialRefresh()]);
  const observationTime = await intradayRefresh();
  return { observationTime, official };
}
