/**
 * Hermes-compatible HTTP API (`hermes_gateway` protocol, as used by AgentOS/Paperclip):
 * POST /v1/runs, GET /v1/runs/{id}, GET /v1/runs/{id}/events (SSE), POST /v1/runs/{id}/stop,
 * GET /v1/models, GET /v1/capabilities, GET /health. Contract: docs/hermes-gateway-protocol.md.
 *
 * A run is one turn in a harness session; it goes through the durable inbox like any channel
 * input and its result comes back through the durable outbox (Channel.send → registry).
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { Address, Channel, DedupPins, Inbound, SendMeta, TurnEvent } from "../types.js";
import { requestHash, type RunEvent, type RunRegistry, TERMINAL } from "./runs.js";
import type { Harness } from "../harness.js";

export const API_CHANNEL = "api";

const THINKING: ReadonlyMap<string, string> = new Map(Object.entries({
  none: "off",
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
}));
const MAX_BODY = 4 * 1024 * 1024;
const MAX_SSE_BUFFER = 1024 * 1024;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

export interface ApiServerOptions {
  /** Bearer key (Hermes API_SERVER_KEY). Required. */
  key: string;
  host?: string;
  port?: number;
  /** Explicit TLS material; omitted preserves the existing HTTP listener. */
  tls?: { key: Buffer; cert: Buffer };
  agent: string;
  runs: RunRegistry;
  /** Session controls the API needs from the harness. */
  cancel: (sessionKey: string, inputId: string) => Promise<"queued" | "running" | false>;
  models: () => Promise<string[]>;
  defaultModel?: () => string | undefined;
  keepaliveMs?: number;
  /** Unsent SSE bytes per connection before a slow client is dropped. */
  maxSseBufferBytes?: number;
  log?: (msg: string) => void;
  /** Passive lifecycle guarantee for already-authorized native service owners.
   * API inference credentials do not gain operator restart authority. */
  lifecycle?: { timeoutSeconds: number; nativeSoftwareUpdates: boolean };
  /** Installed runtime identities, not the updater's available/prepared plan. */
  software?: () => import("../component-versions.js").SoftwareVersions;
  updateAdmission?: Pick<Harness, "acquireUpdateAdmission" | "updateAdmissionStatus" | "releaseUpdateAdmission" | "withForegroundWork"> &
    Partial<Pick<Harness, "prepareUpdateAdmission" | "releaseMaintenanceAdmission">>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class ApiChannel implements Channel {
  readonly name = API_CHANNEL;
  private server?: Server;
  private deliver?: (input: Inbound) => Promise<void>;
  private readonly sockets = new Set<ServerResponse>();
  /** Idempotency keys whose run is being accepted (record + inbox not yet durable). */
  private readonly accepting = new Map<string, Promise<void>>();
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: ApiServerOptions) {
    if (!opts.key) throw new Error("API server requires a key (API_SERVER_KEY)");
    this.log = opts.log ?? ((m) => console.error(`[api] ${m}`));
  }

  /** Bound address (tests use port 0). */
  get address(): AddressInfo | undefined {
    return this.server?.address() as AddressInfo | undefined;
  }

  async start(deliverInbound: (input: Inbound) => Promise<void>, _dedup?: DedupPins): Promise<void> {
    this.deliver = deliverInbound;
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      this.route(req, res).catch((err) => this.fail(res, err));
    };
    this.server = this.opts.tls ? createHttpsServer(this.opts.tls, handler) : createServer(handler);
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.port ?? 8642, this.opts.host ?? "0.0.0.0", () => resolve());
    });
    const a = this.address!;
    this.log(`listening on ${a.address}:${a.port}`);
  }

  async stop(): Promise<void> {
    for (const res of this.sockets) res.end();
    if (!this.server) return;
    const closed = new Promise<void>((resolve) => this.server!.close(() => resolve()));
    // Idle keep-alive and half-sent requests must not hold shutdown open.
    this.server.closeAllConnections();
    await closed;
  }

  /** Result of a run's turn (through the harness outbox: resolves once recorded durably). */
  async send(to: Address, text: string, meta?: SendMeta): Promise<void> {
    if (meta?.maintenance && meta.maintenance.state !== "blocked") return;
    if (meta?.presentation === "progress" && !meta.maintenance && !meta.outcome) {
      this.opts.runs.progress(to.target, text); return;
    }
    await this.opts.runs.finish(to.target, text, meta?.maintenance?.state === "blocked" ? "failed" : meta?.outcome);
  }

  turnEvent(to: Address, event: TurnEvent): void {
    this.opts.runs.started(to.target);
    this.opts.runs.turnEvent(to.target, event);
  }

  async typing(to: Address, on: boolean): Promise<void> {
    if (on) this.opts.runs.started(to.target); // the turn is running
  }

  // ------------------------------------------------------------------ routing

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "GET" && (p === "/health" || p === "/v1/health")) return this.json(res, 200, { status: "ok", platform: "hayate-agent" });
    if (!this.authorized(req)) throw new HttpError(401, "Invalid API key", "invalid_api_key");
    if (p === "/v1/update-admission") {
      const owner = this.opts.updateAdmission;
      if (!owner) throw new HttpError(503, "Update admission unavailable", "update_admission_unavailable");
      if (req.method === "GET") return this.json(res, 200, owner.updateAdmissionStatus());
      if (req.method === "POST") {
        const body = await readJson(req);
        const ttl = body.ttl_ms ?? 60000;
        if (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 300000)
          throw new HttpError(400, "ttl_ms must be an integer from 1000 to 300000", "invalid_request");
        if (body.mode !== undefined && body.mode !== "idle" && body.mode !== "maintenance")
          throw new HttpError(400, "mode must be idle or maintenance", "invalid_request");
        if (body.mode === "maintenance" && (!owner.prepareUpdateAdmission || typeof body.request_id !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.request_id) ||
            (body.timeout_ms !== undefined && (typeof body.timeout_ms !== "number" || !Number.isSafeInteger(body.timeout_ms) || body.timeout_ms < 0 || body.timeout_ms > 120000))))
          throw new HttpError(400, "maintenance requires supported owner, request_id and timeout_ms from 0 to 120000", "invalid_request");
        const result = body.mode === "maintenance"
          ? await owner.prepareUpdateAdmission!(body.request_id as string, ttl, (body.timeout_ms as number | undefined) ?? 60000)
          : owner.acquireUpdateAdmission(ttl);
        return this.json(res, result.status === "admitted" ? 201 : result.status === "unavailable" ? 503 : 409,
          body.mode === "maintenance" && result.status === "admitted" ? { ...result, checkpointed: true } : result);
      }
      if (req.method === "DELETE") {
        const body = await readJson(req);
        if (typeof body.lease_id !== "string" || !body.lease_id) throw new HttpError(400, "lease_id required", "invalid_request");
        const released = owner.releaseMaintenanceAdmission
          ? await owner.releaseMaintenanceAdmission(body.lease_id) : owner.releaseUpdateAdmission(body.lease_id);
        return this.json(res, released ? 200 : 409, owner.updateAdmissionStatus());
      }
    }
    if (req.method === "GET" && p === "/v1/capabilities") return this.json(res, 200, this.capabilities());
    if (req.method === "GET" && p === "/v1/models") return this.json(res, 200, await this.modelList());
    if (req.method === "POST" && p === "/v1/runs") return this.createRun(req, res);
    const m = /^\/v1\/runs\/([^/]+)(\/events|\/stop)?$/.exec(p);
    if (m) {
      const runId = decodeURIComponent(m[1]!);
      if (req.method === "GET" && !m[2]) return this.json(res, 200, this.opts.runs.view(this.run(runId)));
      if (req.method === "GET" && m[2] === "/events") return this.events(req, res, url, runId);
      if (req.method === "POST" && m[2] === "/stop") return this.stopRun(res, runId);
    }
    throw new HttpError(404, `Not found: ${req.method} ${p}`, "not_found");
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7).trim() : "");
    const want = Buffer.from(this.opts.key);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  private capabilities(): Record<string, unknown> {
    return {
      object: "hermes.api_server.capabilities",
      platform: "hayate-agent",
      agent: this.opts.agent,
      ...(this.opts.software ? { software: this.opts.software() } : {}),
      ...(this.opts.lifecycle ? { lifecycle: { restart_timeout_seconds: this.opts.lifecycle.timeoutSeconds } } : {}),
      features: {
        run_submission: true,
        durable_shutdown: !!this.opts.lifecycle,
        native_software_updates: this.opts.lifecycle?.nativeSoftwareUpdates ?? false,
        update_admission: !!this.opts.updateAdmission,
        update_admission_maintenance: !!this.opts.updateAdmission?.prepareUpdateAdmission,
        run_status: true,
        run_events_sse: true,
        run_stop: true,
        execution_routing: true,
        runs_idempotency: { supported: true, durable: true, retention_seconds: 86_400 },
        session_key_header: "X-Hermes-Session-Key",
      },
      endpoints: {
        runs: "/v1/runs",
        update_admission: "/v1/update-admission",
        run_status: "/v1/runs/{run_id}",
        run_events: "/v1/runs/{run_id}/events",
        run_stop: "/v1/runs/{run_id}/stop",
        models: "/v1/models",
      },
    };
  }

  /** "provider/model" refs, plus each model id that is unique across providers (Hermes-style alias). */
  private async modelIds(): Promise<{ refs: string[]; aliases: Map<string, string> }> {
    const refs = new Set(await this.opts.models());
    const def = this.opts.defaultModel?.();
    if (def) refs.add(def);
    const byId = new Map<string, string[]>();
    for (const ref of refs) {
      const id = ref.slice(ref.indexOf("/") + 1);
      if (!refs.has(id)) byId.set(id, [...(byId.get(id) ?? []), ref]);
    }
    const aliases = new Map([...byId].filter(([, r]) => r.length === 1).map(([id, r]) => [id, r[0]!]));
    return { refs: [...refs], aliases };
  }

  private async modelList(): Promise<Record<string, unknown>> {
    const { refs, aliases } = await this.modelIds();
    const ids = new Set([...refs, ...aliases.keys()]);
    return { object: "list", data: [...ids].sort().map((id) => ({ id, object: "model", owned_by: "hayate-agent" })) };
  }

  private run(runId: string) {
    const r = this.opts.runs.get(runId);
    if (!r) throw new HttpError(404, `Run not found: ${runId}`, "run_not_found");
    return r;
  }

  // ------------------------------------------------------------------ runs

  private async createRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (this.opts.updateAdmission) {
      try { return await this.opts.updateAdmission.withForegroundWork(() => this.createRunWithBody(req, res, body)); }
      catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(503, "Run not accepted; retry after update admission", "run_not_accepted");
      }
    }
    return this.createRunWithBody(req, res, body);
  }

  private async createRunWithBody(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const input = typeof body.input === "string" ? body.input : Array.isArray(body.input) ? lastUserText(body.input) : "";
    if (!input.trim()) throw new HttpError(400, "Missing 'input' field", "invalid_request");
    const instructions = typeof body.instructions === "string" ? body.instructions : undefined;
    const requested = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim().replace(/^custom:/, "") : undefined;
    const thinking = reasoning(body);

    const key = header(req, "idempotency-key");
    if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) {
      throw new HttpError(400, "Idempotency-Key must be 1-255 visible ASCII characters", "invalid_idempotency_key");
    }
    const sessionHeader = header(req, "x-hermes-session-key");
    const sessionId = (typeof body.session_id === "string" && body.session_id.trim()) || sessionHeader || undefined;
    const hash = requestHash({ body, session: sessionHeader ?? null });
    if (key) {
      // A concurrent duplicate waits until no acceptance for this key is in flight (re-checked:
      // a failed original may already have been replaced by another waiter's attempt).
      for (let inflight = this.accepting.get(key); inflight; inflight = this.accepting.get(key)) {
        await inflight.catch(() => undefined);
      }
      const prior = this.opts.runs.byIdempotencyKey(key);
      if (prior) {
        if (prior.body_hash !== hash) throw new HttpError(409, "Idempotency-Key was already used with a different request payload", "idempotency_key_conflict");
        return this.json(res, 202, { run_id: prior.run_id, status: prior.status, replayed: true }, { "Idempotency-Replayed": "true" });
      }
    }

    // Only a new run needs the model now (a replay above returns what was accepted then).
    const model = requested ? await this.resolveModel(requested, provider) : undefined;
    if (!requested && provider) {
      // Provider alone: the run uses the default model, whose provider must be the one asked for.
      const def = this.opts.defaultModel?.();
      if (!def || def.slice(0, def.indexOf("/")) !== provider) {
        throw new HttpError(400, `Provider "${provider}" does not serve the default model${def ? ` "${def}"` : ""}; select a model`, "provider_mismatch");
      }
    }
    if (key && (this.accepting.has(key) || this.opts.runs.byIdempotencyKey(key))) {
      // Another request for this key got in while the models were looked up: start over.
      return this.createRunWithBody(req, res, body);
    }
    const record = this.opts.runs.create({ session_key: "", session_id: sessionId, idempotency_key: key, body_hash: hash, model });
    record.session_key = `api:${sessionId ?? record.run_id}`;
    const inbound: Inbound = {
      id: record.input_id,
      sessionKey: record.session_key,
      text: input,
      source: "api",
      replyTo: { channel: API_CHANNEL, target: record.run_id },
      turn: {
        ...(instructions?.trim() ? { instructions } : {}),
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
      },
    };
    // The whole transaction (including cleanup on failure) is what waiting duplicates see.
    let accepted!: Promise<void>;
    accepted = (async () => {
      await Promise.resolve(); // registered in `accepting` before any of this runs
      try {
        await this.opts.runs.save(); // the record exists before the turn can produce a result
        if (!this.deliver) throw new Error("API channel not started");
        await this.deliver(inbound); // durable in the harness inbox
      } catch (err) {
        this.opts.runs.remove(record.run_id);
        // If this write fails too, the record stays on disk; startup reconciliation finds it
        // without an inbox entry, marks it interrupted and releases its idempotency key.
        await this.opts.runs.save().catch((e) => this.log(`cleanup of rejected run failed: ${e instanceof Error ? e.message : e}`));
        throw new HttpError(503, `Run not accepted: ${err instanceof Error ? err.message : err}`, "run_not_accepted");
      } finally {
        if (key && this.accepting.get(key) === accepted) this.accepting.delete(key);
      }
    })();
    if (key) this.accepting.set(key, accepted);
    await accepted;
    this.json(res, 202, { run_id: record.run_id, status: record.status, replayed: false }, sessionHeader ? { "X-Hermes-Session-Key": sessionHeader } : {});
  }

  /** A "provider/model" ref, or an id advertised as alias; `provider` (if given) must match. */
  private async resolveModel(model: string, provider?: string): Promise<string> {
    const { refs, aliases } = await this.modelIds();
    const ref = refs.includes(model)
      ? model
      : provider && refs.includes(`${provider}/${model}`)
        ? `${provider}/${model}`
        : aliases.get(model);
    if (!ref) throw new HttpError(400, `Unknown model "${model}" (see GET /v1/models)`, "model_not_found");
    if (provider && ref.slice(0, ref.indexOf("/")) !== provider) {
      throw new HttpError(400, `Model "${model}" is not served by provider "${provider}"`, "provider_mismatch");
    }
    return ref;
  }

  private async stopRun(res: ServerResponse, runId: string): Promise<void> {
    const r = this.run(runId);
    if (TERMINAL.has(r.status)) throw new HttpError(409, `Run is not active: ${runId} (${r.status})`, "run_not_active");
    const result = await this.opts.cancel(r.session_key, r.input_id);
    if (!result) throw new HttpError(409, `Run is finishing and can no longer be stopped: ${runId}`, "run_not_active");
    this.json(res, 200, { run_id: runId, status: "stopping" });
  }

  private events(req: IncomingMessage, res: ServerResponse, url: URL, runId: string): void {
    this.run(runId);
    const raw = header(req, "last-event-id") ?? url.searchParams.get("last_seq") ?? undefined;
    const parsed = raw === undefined ? -1 : Number.parseInt(raw, 10);
    const lastSeq = Number.isFinite(parsed) ? Math.max(-1, parsed) : -1;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": open\n\n");
    this.sockets.add(res);
    let keepalive: NodeJS.Timeout | undefined;
    let sub: { unsubscribe: () => void } | undefined;
    const end = () => {
      if (keepalive) clearInterval(keepalive);
      sub?.unsubscribe();
      pending.length = 0;
      this.sockets.delete(res);
      if (!res.writableEnded) res.end(": stream closed\n\n");
    };
    // Frames go out with backpressure: written while the socket accepts them, then paused until
    // "drain". Replayed history is bounded by the registry's buffer and always sent; a client
    // whose backlog of *live* frames exceeds the limit is not keeping up and is disconnected
    // (it reconnects with Last-Event-ID). A single large frame never counts as slowness.
    const pending: Array<{ frame: string; live: boolean } | null> = [];
    let liveBytes = 0;
    let waiting = false;
    const pump = () => {
      while (pending.length && !res.writableEnded && !waiting) {
        const next = pending.shift()!;
        if (next === null) return end();
        if (next.live) liveBytes -= next.frame.length;
        if (!res.write(next.frame)) {
          waiting = true;
          res.once("drain", () => {
            waiting = false;
            pump();
          });
        }
      }
    };
    const frame = (e: RunEvent) => `id: ${e.seq}\ndata: ${JSON.stringify({ ...e.data, seq: e.seq })}\n\n`;
    const enqueue = (e: RunEvent | null, live: boolean) => {
      if (res.writableEnded) return;
      if (e === null) pending.push(null);
      else {
        const f = frame(e);
        if (live && waiting && liveBytes + f.length > (this.opts.maxSseBufferBytes ?? MAX_SSE_BUFFER)) {
          this.log(`SSE client for ${runId} too slow, disconnecting`);
          end();
          res.destroy();
          return;
        }
        if (live) liveBytes += f.length;
        pending.push({ frame: f, live });
      }
      pump();
    };
    res.on("close", end); // client went away (req "close" fires once the request is read)
    const s = this.opts.runs.subscribe(runId, lastSeq, (e) => enqueue(e, true));
    sub = s;
    if (s.truncated !== undefined) {
      res.write(`data: ${JSON.stringify({ event: "replay.truncated", run_id: runId, oldest_retained_seq: s.truncated, requested_seq: lastSeq })}\n\n`);
    }
    // Replay goes ahead of anything published meanwhile (subscribe delivers only newer events).
    pending.unshift(...s.replay.map((e) => ({ frame: frame(e), live: false })));
    if (s.closed) pending.push(null);
    pump();
    if (s.closed) return;
    keepalive = setInterval(() => {
      if (res.writableEnded || waiting || pending.length) return;
      if (!res.write(": keepalive\n\n")) {
        waiting = true;
        res.once("drain", () => { waiting = false; pump(); });
      }
    }, this.opts.keepaliveMs ?? 15_000);
    keepalive.unref?.();
  }

  // ------------------------------------------------------------------ helpers

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  private fail(res: ServerResponse, err: unknown): void {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status >= 500) this.log(`request failed: ${message}`);
    if (res.headersSent) {
      res.end();
      return;
    }
    if (status === 413) res.setHeader("Connection", "close"); // the rest of the body is not read
    this.json(res, status, {
      error: { message, type: status === 401 ? "authentication_error" : status >= 500 ? "server_error" : "invalid_request_error", code: err instanceof HttpError ? (err.code ?? null) : null },
    });
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  return s || undefined;
}

function reasoning(body: Record<string, unknown>): string | undefined {
  const opts = body.model_options as { reasoning?: { enabled?: boolean; effort?: string } } | undefined;
  const r = opts?.reasoning;
  if (!r) return undefined;
  if (r.enabled === false) return "off";
  if (!r.effort) return undefined;
  const level = THINKING.get(String(r.effort).toLowerCase());
  if (!level) throw new HttpError(400, `Unsupported reasoning effort "${r.effort}"; supported: ${[...THINKING.keys()].join(", ")}`, "invalid_reasoning_effort");
  return level;
}

/** OpenAI-style message array input: the last user message's text. */
function lastUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text: unknown }).text) : "")).join("");
    }
  }
  return "";
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Not `for await`: leaving that loop early destroys the socket before the 413 can be sent.
  // An oversized body is drained (up to a cap) and the connection closed after the response.
  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
      else if (size > 4 * MAX_BODY) req.destroy();
    });
    req.on("end", () => resolve());
    req.on("error", reject);
    req.on("close", () => (size > MAX_BODY ? resolve() : undefined));
  });
  if (size > MAX_BODY) throw new HttpError(413, "Request body too large", "body_too_large");
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Invalid JSON", "invalid_json");
  }
}
