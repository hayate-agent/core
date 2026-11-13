import { pathToFileURL } from "node:url";
import path from "node:path";
/** Candidate-owned parsers, read-only. No plugin activation, credentials generation,
 * network, model request, runtime startup, task loading or development test gate. */
export function startupQualificationProgram(core: string, home: string): string {
  const config = pathToFileURL(path.join(core, "dist/config.js")).href;
  const validator = pathToFileURL(path.join(core, "dist/validator.js")).href;
  return `const {loadConfig}=await import(${JSON.stringify(config)});\n` +
    `const {ValidatorRegistry}=await import(${JSON.stringify(validator)});\n` +
    `const config=await loadConfig(${JSON.stringify(home)});\n` +
    `const registry=new ValidatorRegistry();\n` +
    `if(config.completionCheck?.provider!==undefined)registry.select(config.completionCheck.provider);\n` +
    `void registry.selected;\n`;
}
