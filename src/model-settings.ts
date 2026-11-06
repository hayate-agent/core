export interface ModelSettings {
  model?: string;
  thinking?: string;
  reviewModel?: string;
  reviewThinking?: string;
}
export type ModelSetting = keyof ModelSettings;
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function validateModelSetting(key: ModelSetting, value: string): void {
  if (key === "model" || key === "reviewModel") {
    if (!/^[^/\s]+\/[^\s]+$/.test(value)) throw new Error("Use provider/model");
  } else if (!thinkingLevels.includes(value)) throw new Error(`Reasoning must be one of: ${thinkingLevels.join(", ")}`);
}
