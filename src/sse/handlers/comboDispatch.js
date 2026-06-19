import { handleComboChat, handleFusionChat, handleCoachChat } from "open-sse/services/combo.js";
import { makePersistSample } from "../services/coachHarvest.js";

/**
 * Resolve and run the configured combo strategy. Returns a Response if a strategy
 * handled the request, otherwise null (caller falls through to single-model).
 * makeHandleSingleModel() returns the (body, model, isPanel) => Promise<Response> fn.
 */
export async function dispatchComboStrategy({ modelStr, comboModels, settings, body, makeHandleSingleModel, log }) {
  if (!comboModels) return null;
  const comboStrategies = settings.comboStrategies || {};
  const cfg = comboStrategies[modelStr] || {};
  const comboStrategy = cfg.fallbackStrategy || settings.comboStrategy || "fallback";
  const handleSingleModel = makeHandleSingleModel();

  if (comboStrategy === "fusion") {
    log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
    return handleFusionChat({
      body, models: comboModels, handleSingleModel, log, comboName: modelStr,
      judgeModel: cfg.judgeModel, tuning: cfg.fusionTuning,
    });
  }

  if (comboStrategy === "coach") {
    log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: coach)`);
    return handleCoachChat({
      body, models: comboModels, handleSingleModel, log, comboName: modelStr,
      studentModel: cfg.studentModel, teacherModel: cfg.judgeModel,
      serveMode: cfg.serveMode === "teacher" ? "teacher" : "student",
      tuning: cfg.coachTuning, persistSample: makePersistSample(),
    });
  }

  const comboStickyLimit = settings.comboStickyRoundRobinLimit;
  log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
  return handleComboChat({
    body, models: comboModels, handleSingleModel, log, comboName: modelStr,
    comboStrategy, comboStickyLimit,
  });
}
