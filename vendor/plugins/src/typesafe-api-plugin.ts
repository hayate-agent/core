import { open } from "node:fs/promises";
import { constants } from "node:fs";
import type { PluginModule } from "./plugins.js";
import { registeredBank, type ChoiceBank } from "./typesafe-question-banks.js";
export type { ChoiceBank } from "./typesafe-question-banks.js";

/** Declared SystemOne choice dialect; server acceptance remains a separate live gate.
 * samples is explicitly sent (local OpenJEV consumer contract). Noul is not a
 * choice/confidence and cannot authorize either consumer. */
export interface TypeSafeAPIConfig {
  endpoint: string;
  model: string;
  bearerTokenFile: string;
  timeoutMs?: number;
}
export interface TypeSafeTransportFailure {
  cause: "timeout" | "provider_error";
  status?: number;
}
export interface TypeSafeAPI {
  choose(bank: ChoiceBank, state: string, signal: AbortSignal, failure?: (detail: TypeSafeTransportFailure) => void): Promise<string | undefined>;
}
export const TYPESAFE_API_SERVICE = "typesafe-api";
// Match the host's bounded completion evidence envelope; the old24KiB
// transport limit silently rejected real 24-56KiB retained assessments.
export const TYPESAFE_STATE_BYTES = 56000;
const RESPONSE_BYTES = 16384;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** Plain-token credential reference, never a token in config, diagnostics or exports.
 * Final component must be an owner-only regular file; parent symlinks (the
 * operator's designated secrets directory) are supported. No environment scan. */
async function credential(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 4096 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw Error();
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw Error();
    const token = buffer.subarray(0, bytesRead).toString("utf8").trim();
    if (!/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) throw Error();
    return token;
  } finally { await handle.close(); }
}

export function createTypeSafeAPI(config: TypeSafeAPIConfig): TypeSafeAPI {
  // Copy trusted config; no later mutation can redirect evidence/credentials.
  if (!record(config) || !exact(config, ["endpoint", "model", "bearerTokenFile", "timeoutMs"])) throw Error("Invalid TypeSafe API configuration");
  const { endpoint, model, bearerTokenFile, timeoutMs = 120000 } = config;
  const url = (() => { try { return new URL(endpoint); } catch { throw Error("Invalid TypeSafe API configuration"); } })();
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/v1/systemone" ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) ||
      (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(model)) || (typeof bearerTokenFile !== "string" || !bearerTokenFile.startsWith("/")) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw Error("Invalid TypeSafe API configuration");
  return { async choose(bank, state, signal, failure) {
    const report = (detail: TypeSafeTransportFailure) => { try { failure?.(detail); } catch { /* diagnostic observers cannot alter transport behavior */ } };
    if (signal.aborted || Buffer.byteLength(state) > TYPESAFE_STATE_BYTES || !state.trim()) return;
    const canonical = registeredBank(bank);
    if (!canonical) return; // Unknown version/size/policy: uncertain, no I/O or fallback.
    bank = canonical;
    const keys = Object.keys(bank.choices);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
    let response: Response | undefined;
    let stopped: (() => void) | undefined;
    const cancelled = new Promise<undefined>(resolve => { stopped = () => resolve(undefined); controller.signal.addEventListener("abort", stopped, { once: true }); });
    try {
      const operation = async () => {
        const token = await credential(bearerTokenFile);
        if (signal.aborted || controller.signal.aborted || state.includes(token)) return;
        response = await fetch(endpoint, { method: "POST", redirect: "error", signal: controller.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ model, state, samples: 1, questions: { [bank.id]: {
            type: "choice", instructions: bank.instructions, criteria: bank.choices,
          } } }) });
        if (!response.ok) { report({ cause: "provider_error", ...(response.status >= 400 && response.status <= 599 ? { status: response.status } : {}) }); return; }
        if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) return;
        const reader = response.body?.getReader();
        if (!reader) return;
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength; if (size > RESPONSE_BYTES) return;
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!record(raw) || !exact(raw, ["model", "answers", "usage"]) ||
            typeof raw.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(raw.model) ||
            !record(raw.answers) || Object.keys(raw.answers).length !== 1 || !Object.hasOwn(raw.answers, bank.id)) return;
        if (raw.usage !== undefined && (!record(raw.usage) || !exact(raw.usage, ["input_tokens", "output_tokens"]) ||
            Object.values(raw.usage).some(v => !Number.isSafeInteger(v) || (v as number) < 0))) return;
        const answer = raw.answers[bank.id];
        if (!record(answer) || !exact(answer, ["type", "choice", "confidence", "probabilities"]) || answer.type !== "choice" ||
            typeof answer.choice !== "string" || !Object.hasOwn(bank.choices, answer.choice) || !unit(answer.confidence) ||
            !record(answer.probabilities) || Object.keys(answer.probabilities).length !== keys.length ||
            keys.some(k => !Object.hasOwn(answer.probabilities as object, k) || !unit((answer.probabilities as Record<string, unknown>)[k])) ||
            Math.abs(Object.values(answer.probabilities).reduce<number>((n, v) => n + (v as number), 0) - 1) > 0.001) return;
        // Public SystemOne contract: response.model is the RESOLVED model name,
        // and may differ from the configured request alias. The request endpoint,
        // model and credential remain fixed; this is not model discovery/fallback.
        // Confidence and probabilities are separate upstream values. A valid low
        // confidence response is uncertainty, never malformed data or permission.
        return answer.confidence < 0.9 ? "unknown" : answer.choice;
      };
      const result = await Promise.race([operation().catch(() => { if (!signal.aborted && !controller.signal.aborted) report({ cause: "provider_error" }); return undefined; }), cancelled]);
      if (timedOut && !signal.aborted) report({ cause: "timeout" });
      return signal.aborted || controller.signal.aborted ? undefined : result;
    } catch { if (!signal.aborted) report({ cause: "provider_error" }); return; }
    finally {
      clearTimeout(timer); controller.abort(); signal.removeEventListener("abort", abort);
      if (stopped) controller.signal.removeEventListener("abort", stopped);
      void response?.body?.cancel().catch(() => {});
    }
  } };
}

export function createTypeSafeAPIPlugin(config: TypeSafeAPIConfig): PluginModule {
  const api = createTypeSafeAPI(config);
  return { apiVersion: 1, activate(host) { host.registerService(TYPESAFE_API_SERVICE, 1, api); } };
}
