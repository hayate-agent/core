import type { Inbound } from "./types.js";
import type { AssessmentBackend } from "./assessment-backend.js";

export interface CompletionAuthorization {
  task: string;
  expiresAt?: number;
  purpose?: "nightly-closure";
}
export type CompletionDiagnostic = "unavailable" | "inconclusive" | "invalid_response" | "technical";
/** Fixed vocabulary only: never retain exception text, URLs, headers or model data. */
export interface CompletionFailureDetail {
  cause: "timeout" | "provider_error" | "invalid_shape";
  code?: "ECONNRESET" | "ECONNREFUSED" | "ETIMEDOUT" | "ENOTFOUND" | "EAI_AGAIN" | "UND_ERR_CONNECT_TIMEOUT" | "UND_ERR_SOCKET";
  status?: number;
}
/** Copy only the public failure vocabulary; providers cannot publish arbitrary error payloads. */
export function completionFailureDetail(value: unknown): CompletionFailureDetail | undefined {
  try {
    if (!value || typeof value !== "object") return;
    const raw = value as CompletionFailureDetail;
    const { cause, code, status } = raw;
    if (!["timeout", "provider_error", "invalid_shape"].includes(cause)) return;
    const detail: CompletionFailureDetail = { cause };
    if (code && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(code)) detail.code = code;
    if (Number.isInteger(status) && status! >= 400 && status! <= 599) detail.status = status;
    return detail;
  } catch { return; }
}
export type CompletionDiagnosticSink = (diagnostic: CompletionDiagnostic, detail?: CompletionFailureDetail) => void;
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
  /** Optional bounded technical failure projection; never a semantic verdict. */
  reportFailure?: (detail: CompletionFailureDetail) => void;
}
/** Providers return a semantic answer, not host directives. The validator plugin validates it. */
export interface ValidatorProvider {
  apiVersion: 1;
  name: string;
  version: number;
  /** False for non-LLM transports; skip unrelated runtime model qualification. */
  requiresModel?: boolean;
  /** Trusted transport input budget, never a permission to truncate authority. */
  maxPromptBytes?: number;
  assess(request: ValidatorRequest): Promise<unknown>;
}

/** Per-host registry. No implicit network fallback or provider success on errors. */
export class ValidatorRegistry {
  private providers = new Map<string, ValidatorProvider>();
  private selection: string | false | undefined;
  register(provider: ValidatorProvider): void {
    if (!provider || provider.apiVersion !== 1 || typeof provider.name !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(provider.name) ||
        !Number.isSafeInteger(provider.version) || provider.version < 1 || typeof provider.assess !== "function" ||
        (provider.requiresModel !== undefined && typeof provider.requiresModel !== "boolean") ||
        (provider.maxPromptBytes !== undefined && (!Number.isSafeInteger(provider.maxPromptBytes) || provider.maxPromptBytes < 1024 || provider.maxPromptBytes > 56000))) {
      throw Error("Invalid validator provider");
    }
    if (this.providers.has(provider.name)) throw Error("Duplicate validator provider");
    this.providers.set(provider.name, Object.freeze({ ...provider, assess: provider.assess.bind(provider) }));
  }
  /** Selection may precede registration at startup; resolution rejects missing providers. */
  select(name: string | false | undefined): void {
    if (name === undefined) throw Error("completionCheck.provider is required; select a provider or explicitly disable with false");
    if (name !== false && (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(name))) throw Error("Invalid validator selection");
    this.selection = name;
  }
  get current(): ValidatorProvider | undefined {
    if (this.selection === false) return undefined;
    if (this.selection === undefined) throw Error("completionCheck.provider is required; no implicit validator fallback");
    const provider = this.providers.get(this.selection);
    if (!provider) throw Error("Selected completion-check provider is not registered");
    return provider;
  }
  get selected(): string | false {
    if (this.selection === undefined) throw Error("completionCheck.provider is required; no implicit validator fallback");
    return this.selection;
  }
  versions(): Array<{ name: string; version: number; apiVersion: 1 }> {
    return [...this.providers.values()].map(({ name, version, apiVersion }) => ({ name, version, apiVersion }));
  }
}
