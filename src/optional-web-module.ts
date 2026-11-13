import { stat } from "node:fs/promises";

/** Only absence of the configured entrypoint is optional. Never swallow an
 * existing module's syntax error, missing dependency or security/activation
 * error, and never substitute another module or change operator settings. */
export async function missingModule(file: string | URL): Promise<boolean> {
  try { await stat(file); return false; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return true;
    throw error;
  }
}
/** The general plugin list has no gateway IDs. Limit optional treatment to
 * the documented Web entrypoints; all other missing plugins remain errors. */
export function webModuleEntrypoint(file: string): boolean {
  return /(?:^|[/\\])(?:webui|dashboard-api)[/\\]index\.mjs$/.test(file);
}
