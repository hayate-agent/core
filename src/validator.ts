import type { Inbound } from "./types.js";
import type { AssessmentBackend } from "./assessment-backend.js";

export interface CompletionAuthorization {
  task: string;
  expiresAt?: number;
  purpose?: "nightly-closure";
}
export type CompletionDiagnostic = "unavailable" | "inconclusive" | "invalid_response" | "technical";
export type CompletionDiagnosticSink = (diagnostic: CompletionDiagnostic) => void;
export type CompletionPrompt = (input: Inbound, reply: string, authorization: CompletionAuthorization, now: () => number) => string;

/** Trusted extension request. All answers are advisory, never execution receipts or authority. */
export interface ValidatorRequest {
  backend: AssessmentBackend;
  input: Inbound;
  reply: string;
  authorization: CompletionAuthorization;
  signal: AbortSignal;
  model?: string;
  now: () => number;
  prompt: CompletionPrompt;
  promptText: string;
}
/** Providers return a semantic answer, not host directives. The validator plugin validates it. */
export interface ValidatorProvider {
  apiVersion: 1;
  name: string;
  version: number;
  assess(request: ValidatorRequest): Promise<unknown>;
}

/** Per-host registry. No implicit network fallback or provider success on errors. */
export class ValidatorRegistry {
  private providers = new Map<string, ValidatorProvider>();
  private selection: string | false = "legacy-llm";
  register(provider: ValidatorProvider): void {
    if (!provider || provider.apiVersion !== 1 || typeof provider.name !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(provider.name) ||
        !Number.isSafeInteger(provider.version) || provider.version < 1 || typeof provider.assess !== "function") {
      throw Error("Invalid validator provider");
    }
    if (this.providers.has(provider.name)) throw Error("Duplicate validator provider");
    this.providers.set(provider.name, Object.freeze({ ...provider, assess: provider.assess.bind(provider) }));
  }
  /** Selection may precede registration at startup. Missing/disabled means unavailable, never fallback. */
  select(name: string | false): void {
    if (name !== false && (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(name))) throw Error("Invalid validator selection");
    this.selection = name;
  }
  get current(): ValidatorProvider | undefined { return this.selection === false ? undefined : this.providers.get(this.selection); }
  get selected(): string | false { return this.selection; }
  versions(): Array<{ name: string; version: number; apiVersion: 1 }> {
    return [...this.providers.values()].map(({ name, version, apiVersion }) => ({ name, version, apiVersion }));
  }
}
