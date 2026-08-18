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
