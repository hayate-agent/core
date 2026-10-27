import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AssessmentBackend } from "./assessment-backend.js";
import type { BoundaryAssessment } from "./context-assessment.js";
import type { ToolResultProjector } from "./tool-result-pruning.js";

import { MaintenanceError, maintenanceError } from "./context-maintenance.js";

/** Preserve safe backend failures even when an advisory plugin returns unknown. */
export function diagnosedBoundaryAssessor(backend: AssessmentBackend, model: () => string | undefined,
  create: (backend: AssessmentBackend, model: () => string | undefined) => BoundaryAssessment): BoundaryAssessment {
  return async evidence => {
    let failure: MaintenanceError | undefined;
    const assess = create({ review: async (...args) => {
      const signal = args[3];
      const timedOut = () => { failure = new MaintenanceError("assessment", "timeout"); };
      signal?.addEventListener("abort", timedOut, { once: true });
      try { return await backend.review(...args); }
      catch (err) { failure ??= maintenanceError("assessment", err); throw failure; }
      finally { signal?.removeEventListener("abort", timedOut); }
    } }, model);
    const action = await assess(evidence);
    if (action === "unknown" && failure) throw failure;
    return action;
  };
}

export interface ContextStrategies { assess: BoundaryAssessment; project: ToolResultProjector }
export interface ContextStrategyModule {
  apiVersion: 1;
  create(context: { backend: AssessmentBackend; model: () => string | undefined }): ContextStrategies | Promise<ContextStrategies>;
}
/** Trusted startup-only strategy selection; durable maintenance state stays in host. */
export async function contextStrategies(home: string, module: string | undefined, baseline: ContextStrategyModule,
  context: Parameters<ContextStrategyModule["create"]>[0]): Promise<ContextStrategies> {
  const selected = module ? (await import(pathToFileURL(path.resolve(home, module)).href)).default : baseline;
  if (selected?.apiVersion !== 1 || typeof selected.create !== "function") throw Error("Invalid context strategy module");
  const strategies = await selected.create(context);
  if (!strategies || typeof strategies.assess !== "function" || typeof strategies.project !== "function") throw Error("Invalid context strategies");
  return { assess: strategies.assess.bind(strategies), project: strategies.project.bind(strategies) };
}
