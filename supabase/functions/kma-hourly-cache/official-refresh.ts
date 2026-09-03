export class OfficialDataUnavailableError extends Error {
  constructor() {
    super("official daily base is unavailable");
    this.name = "OfficialDataUnavailableError";
  }
}

export async function refreshOfficial(
  update: () => Promise<void>,
): Promise<"updated" | "deferred"> {
  try {
    await update();
    return "updated";
  } catch (error) {
    if (!(error instanceof OfficialDataUnavailableError)) throw error;
    return "deferred";
  }
}

export function safeRefreshErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "unknown failure";
  return error.message.replaceAll(/([?&]authKey=)[^&\s]+/g, "$1[redacted]");
}
