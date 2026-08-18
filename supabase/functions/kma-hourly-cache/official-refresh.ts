export class OfficialDataUnavailableError extends Error {
  constructor() {
    super("official daily base is unavailable");
    this.name = "OfficialDataUnavailableError";
  }
}

export async function refreshOfficial(update: () => Promise<void>): Promise<"updated" | "deferred"> {
  try {
    await update();
    return "updated";
  } catch (error) {
    if (error instanceof OfficialDataUnavailableError) return "deferred";
    throw error;
  }
}
