import { saveCoachingSample } from "@/lib/db/repos/coachingSamplesRepo.js";
import * as log from "../utils/logger.js";

// Returns a best-effort persister for the coach engine. Never throws.
export function makePersistSample() {
  return async (record) => {
    try {
      await saveCoachingSample(record);
    } catch (e) {
      log.warn("COACH", "persistSample failed", { error: e?.message || String(e) });
    }
  };
}
