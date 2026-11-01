/**
 * Matrix channel with native Rust SDK Olm/Megolm E2EE.
 * Configured through the same MATRIX_* environment as the Hermes Matrix adapter, so
 * existing AgentOS manifests (MatrixAgent secrets, params) keep working.
 */
import { NativeActivityDelivery } from "./native-activity.js";
import { GatewayProgress, progressMode, type ProgressMode } from "./channels/progress.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { marked } from "marked";
import { writeFileDurable } from "./durable.js";
import { type Address, type Channel, type DedupPins, type Inbound, PermanentDeliveryError, type SendMeta, type TurnEvent } from "./types.js";
import { type MatrixEvent, MatrixSyncRecovery } from "./matrix-sync.js";
import { MatrixCrypto } from "./matrix-crypto.js";

export interface MatrixOptions {
  homeserver: string;
  progress?: ProgressMode;
  nativeActivity?: boolean;
  nativeActivityCoalesceMs?: number;
  statusReactions?: boolean;
  accessToken?: string;
  userId?: string;
  password?: string;
  deviceId?: string;
  /** Enabled by default. Disabled clients still refuse encrypted rooms. */
  e2ee?: boolean;
  cryptoStoreDir?: string;
  displayName?: string;
  allowedUsers: string[];
  allowAllUsers: boolean;
  allowedRooms: string[];
  /** Strict room boundary, including invites, DMs and outbound traffic. Empty denies all. */
  admissionRooms?: string[];
  freeRooms: string[];
  optionalReplyRooms: string[];
  requireMention: boolean;
  autoThread: boolean;
  dmAutoThread: boolean;
  processNotices: boolean;
  /** Effective remote identities allowed to resolve approvals. Empty means nobody remote. */
  approvers: string[];
  homeRoom?: string;
  batchDelayMs: number;
  /** Persisted /sync token so restarts do not replay history. */
  syncStateFile: string;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

const csv = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const truthy = (v: string | undefined, dflt: boolean) => (v === undefined || v === "" ? dflt : /^(1|true|yes|on)$/i.test(v));

/** Hermes-compatible env mapping. Returns undefined when Matrix is not configured. */
export function matrixOptionsFromEnv(env: NodeJS.ProcessEnv, home: string): MatrixOptions | undefined {
  if (!env.MATRIX_HOMESERVER || !(env.MATRIX_ACCESS_TOKEN || (env.MATRIX_USER_ID && env.MATRIX_PASSWORD))) return undefined;
  const delay = env.MATRIX_TEXT_BATCH_DELAY_SECONDS ?? env.HERMES_MATRIX_TEXT_BATCH_DELAY_SECONDS;
  const admissionRooms = env.MATRIX_ADMISSION_ROOMS === undefined ? undefined : csv(env.MATRIX_ADMISSION_ROOMS);
  if (admissionRooms?.some(room => !/^![^\s/:]+:[^\s/]+$/.test(room))) throw Error("Invalid Matrix room admission ID");
  return {
    homeserver: env.MATRIX_HOMESERVER.replace(/\/+$/, ""),
    accessToken: env.MATRIX_ACCESS_TOKEN,
    nativeActivity: truthy(env.MATRIX_NATIVE_ACTIVITY, false),
    nativeActivityCoalesceMs: Number(env.MATRIX_NATIVE_ACTIVITY_COALESCE_MS ?? 1000),
    progress: env.MATRIX_PROGRESS === undefined ? undefined : progressMode(env.MATRIX_PROGRESS),
    statusReactions: env.MATRIX_STATUS_REACTIONS === undefined ? undefined : truthy(env.MATRIX_STATUS_REACTIONS, false),
    userId: env.MATRIX_USER_ID,
    password: env.MATRIX_PASSWORD,
    deviceId: env.MATRIX_DEVICE_ID,
    e2ee: truthy(env.MATRIX_E2EE, true),
    cryptoStoreDir: env.MATRIX_CRYPTO_STORE_DIR || path.join(home, "matrix-crypto"),
    displayName: env.MATRIX_DISPLAY_NAME,
    allowedUsers: csv(env.MATRIX_ALLOWED_USERS),
    allowAllUsers: truthy(env.MATRIX_ALLOW_ALL_USERS, false),
    allowedRooms: csv(env.MATRIX_ALLOWED_ROOMS),
    admissionRooms,
    freeRooms: csv(env.MATRIX_FREE_RESPONSE_ROOMS),
    optionalReplyRooms: csv(env.MATRIX_OPTIONAL_REPLY_ROOMS),
    requireMention: truthy(env.MATRIX_REQUIRE_MENTION, true),
    autoThread: truthy(env.MATRIX_AUTO_THREAD, true),
    dmAutoThread: truthy(env.MATRIX_DM_AUTO_THREAD, false),
    processNotices: truthy(env.MATRIX_PROCESS_NOTICES, false),
    approvers: csv(env.MATRIX_APPROVAL_APPROVERS),
    homeRoom: env.MATRIX_HOME_ROOM || env.MATRIX_HOME_CHANNEL || undefined,
    batchDelayMs: delay ? Math.round(Number(delay) * 1000) : 600,
    syncStateFile: path.join(home, "matrix-sync.json"),
  };
}

const APPROVE = new Set(["✅", "👍", "✔️", "☑️"]);
const DENY = new Set(["❌", "👎", "🚫"]);
const MAX_CHUNK = 12_000;
const MAX_EVENT_ATTEMPTS = 5;
const MAX_BATCH_MS = 10_000;
const MAX_BATCH_PARTS = 20;
const MAX_BATCH_CHARS = 20_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

class MatrixTransportError extends Error {
  constructor(message: string, readonly cause: unknown) {
    super(message);
  }
}

export class MatrixChannel implements Channel {
  readonly name = "matrix";
  private deliver?: (input: Inbound) => Promise<void>;
  private readonly recovery: MatrixSyncRecovery;
  private abort = new AbortController();
  private loop?: Promise<void>;
  private readonly fetch: typeof fetch;
  private readonly log: (m: string) => void;
  private readonly memberCount = new Map<string, { n: number; at: number }>();
  /** Threads the bot takes part in: replies there need no mention. */
  private readonly botThreads = new Set<string>();
  /** Approval prompt event id → approval id. */
  private readonly approvalEvents = new Map<string, string>();
  /** Invites retry independently so one bad room cannot hold the /sync cursor. */
  private readonly pendingInvites = new Map<string, any>();
  private readonly batches = new Map<string, { input: Inbound; timer: NodeJS.Timeout; since: number }>();
  private readonly typingTimers = new Map<string, NodeJS.Timeout>();
  private readonly typingUsers = new Map<string, number>();
  private readonly typingRequests = new Map<string, Promise<void>>();
  private gateway: import("./gateway-settings.js").GatewaySettings = { progress: "off", statusReactions: false };
  configureGateway(settings: import("./gateway-settings.js").GatewaySettings): void {
    this.gateway = { progress: this.o.progress ?? settings.progress, statusReactions: this.o.statusReactions ?? settings.statusReactions };
  }
  readonly editableProgress = true;
  progressEnabled(): boolean { return (this.o.progress ?? this.gateway.progress) !== "off"; }
  private readonly progress = new Map<string, GatewayProgress>();
  private telemetry: Promise<void> = Promise.resolve();
  private telemetryPending = 0;
  userId = "";
  private crypto?: MatrixCrypto;
  /** Encryption is sticky: never trust a subsequent missing state event as downgrade. */
  private readonly encryptedRooms = new Set<string>();
  private readonly pendingEncrypted = new Map<string, { roomId: string; event: MatrixEvent }>();
  private pendingWrite: Promise<void> = Promise.resolve();
  private get pendingCryptoFile(): string { return path.join(this.o.cryptoStoreDir ?? path.join(path.dirname(this.o.syncStateFile), "matrix-crypto"), "pending-events.json"); }

  private async persistPending(): Promise<void> {
    const write = this.pendingWrite.catch(() => undefined).then(() => writeFileDurable(this.pendingCryptoFile, JSON.stringify({ homeserver: this.o.homeserver, userId: this.userId, deviceId: this.o.deviceId, events: [...this.pendingEncrypted.values()], encryptedRooms: [...this.encryptedRooms] })));
    this.pendingWrite = write;
    await write;
  }

  private async roomEncrypted(roomId: string): Promise<boolean> {
    if (this.encryptedRooms.has(roomId)) return true;
    try {
      const state = await this.api("GET", `/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption`);
      if (state.algorithm !== "m.megolm.v1.aes-sha2") throw Error("Unsupported Matrix room encryption algorithm");
      this.encryptedRooms.add(roomId);
      if (this.crypto) await this.persistPending();
      return true;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return false;
      throw err;
    }
  }

  private async retryEncrypted(): Promise<void> {
    if (!this.crypto) return;
    for (const [key, { roomId, event }] of this.pendingEncrypted) {
      let plain: MatrixEvent;
      try { plain = await this.crypto.decrypt(roomId, event); }
      catch { continue; } // keep ciphertext durably until a later key/device update
      await this.onEvent(roomId, plain, true);
      if (!(await this.recovery.settle())) throw Error("decrypted input not accepted");
      this.pendingEncrypted.delete(key);
      await this.persistPending();
    }
  }

  private enqueueTelemetry(work: () => Promise<void>): void {
    if (this.telemetryPending >= 50) return;
    this.telemetryPending++;
    this.telemetry = this.telemetry.then(work).catch(() => undefined).finally(() => { this.telemetryPending--; });
  }

  private progressKey(to: Address, input?: Inbound): string { return JSON.stringify([to.target, to.thread, input?.sessionKey, input?.id]); }

  turnEvent(to: Address, event: TurnEvent, input?: Inbound): void {
    this.progress.get(this.progressKey(to, input))?.event(event);
  }

  async received(to: Address, input: Inbound): Promise<void> {
    this.react(to, input, "received", "📥");
  }

  private readonly reactionStates = new Map<string, string>();
  private react(to: Address, input: Inbound, status: string, emoji: string): void {
    if (!(this.o.statusReactions ?? this.gateway.statusReactions)) return;
    const ids = input.parts?.map((part) => part.id) ?? (input.id ? [input.id] : []);
    for (const id of ids) {
      const stateKey = JSON.stringify([to.target, id]);
      const previous = this.reactionStates.get(stateKey);
      const terminal = ["completed", "failed", "cancelled"];
      const lateCancellation = previous === "completed" && status === "cancelled";
      if (previous && !lateCancellation && (terminal.includes(previous) || (previous === "started" && status === "received"))) continue;
      this.reactionStates.set(stateKey, status);
      if (this.reactionStates.size > 5000) this.reactionStates.delete(this.reactionStates.keys().next().value!);
      const txnFor = (stage: string) => createHash("sha256").update(JSON.stringify([to.target, id, stage])).digest("hex");
      this.enqueueTelemetry(async () => {
        await this.api("PUT", `/rooms/${encodeURIComponent(to.target)}/send/m.reaction/${txnFor(status)}`, {
          "m.relates_to": { rel_type: "m.annotation", event_id: id, key: emoji },
        });
        // Resolve previous reaction IDs through their stable transactions, including after restart.
        const obsolete = status === "started" ? ["received"] : terminal.includes(status) ? ["received", "started", ...(lateCancellation ? ["completed"] : [])] : [];
        for (const stage of obsolete) {
          const old = await this.api("PUT", `/rooms/${encodeURIComponent(to.target)}/send/m.reaction/${txnFor(stage)}`, {
            "m.relates_to": { rel_type: "m.annotation", event_id: id, key: stage === "received" ? "📥" : stage === "completed" ? "✅" : "👀" },
          });
          if (typeof old.event_id === "string") await this.api("PUT", `/rooms/${encodeURIComponent(to.target)}/redact/${encodeURIComponent(old.event_id)}/${txnFor(stage)}.clear`, {});
        }
      });
    }
  }

  async turnStatus(to: Address, input: Inbound, status: "started" | "completed" | "failed" | "cancelled"): Promise<void> {
    const key = this.progressKey(to, input);
    if (status === "started") {
      this.progress.set(key, new GatewayProgress(this.o.nativeActivity ? "off" : (this.o.progress ?? this.gateway.progress), async (text) => { this.enqueueTelemetry(() => this.send(to, text, { presentation: "progress", progressId: input.progressId })); }));
    } else {
      const progress = this.progress.get(key);
      this.progress.delete(key);
      await progress?.finish();
    }
    this.react(to, input, status, { started: "👀", completed: "✅", failed: "❌", cancelled: "⏹️" }[status]);
  }

  private readonly native: NativeActivityDelivery;
  taskActivity(to: Address, event: import("./activity.js").ActivityEvent): void {
    if (this.o.nativeActivity) this.native.event(to, event);
  }
  dispatcherActivity(to: Address, id: string, state: string): void {
    if (this.o.nativeActivity) this.native.metadata(to, id, state);
  }
  async flushNativeActivity(): Promise<void> { await this.native.flush(); }
  constructor(private readonly o: MatrixOptions) {
    this.native = new NativeActivityDelivery(`${o.syncStateFile}.activity.json`, async (to, id, text) => {
      await this.send(to, text, { progressId: id, presentation: "progress" });
    }, Number.isFinite(o.nativeActivityCoalesceMs) ? Math.max(100, Math.min(30000, o.nativeActivityCoalesceMs!)) : 1000);
    this.fetch = o.fetch ?? fetch;
    this.log = o.log ?? ((m) => console.error(`[matrix] ${m}`));
    this.recovery = new MatrixSyncRecovery(o.syncStateFile, this.log);
  }

  get home(): Address | undefined {
    return this.o.homeRoom ? { channel: "matrix", target: this.o.homeRoom } : undefined;
  }

  // ---------------------------------------------------------------- HTTP

  /**
   * Every request is bounded: 30 s plus the long-poll time for /sync. A 401 at runtime renews a
   * password-login session once (single flight) and repeats the request with the new token;
   * a rejected externally supplied MATRIX_ACCESS_TOKEN cannot be renewed and is reported.
   */
  private async api<T = any>(method: string, p: string, body?: unknown, longPollMs = 0): Promise<T> {
    const room = /^\/rooms\/([^/?]+)/.exec(p);
    if (room && !this.roomAdmitted(decodeURIComponent(room[1]!))) throw new PermanentDeliveryError("Matrix room admission denied");
    try {
      return await this.request<T>(method, p, body, longPollMs);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 401) || p === "/login" || !this.started) throw err;
      if (!this.passwordAuth) {
        this.log("MATRIX_ACCESS_TOKEN rejected by the homeserver (401); replace it and restart");
        throw err;
      }
      const used = this.o.accessToken;
      this.renewing ??= this.login().finally(() => (this.renewing = undefined));
      if (this.o.accessToken === used) await this.renewing;
      // Note: transaction ids are token-scoped; a reply retried across a renewal may repeat once.
      return this.request<T>(method, p, body, longPollMs);
    }
  }

  private started = false;
  private renewing?: Promise<void>;
  private get passwordAuth(): boolean {
    return !!this.o.password;
  }

  private async request<T = any>(method: string, p: string, body?: unknown, longPollMs = 0): Promise<T> {
    let res: Response;
    let text: string;
    try {
      res = await this.fetch(`${this.o.homeserver}/_matrix/client/v3${p}`, {
        method,
        headers: { "content-type": "application/json", ...(this.o.accessToken ? { authorization: `Bearer ${this.o.accessToken}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000 + longPollMs)]),
      });
      text = await res.text();
    } catch (err) {
      throw new MatrixTransportError(`${method} ${p.split("?")[0]}: transport failed`, err);
    }
    if (!res.ok) throw new HttpError(res.status, `${method} ${p.split("?")[0]}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  // ---------------------------------------------------------------- lifecycle

  async start(deliver: (input: Inbound) => Promise<void>, dedup?: DedupPins): Promise<void> {
    this.abort = new AbortController();
    this.deliver = deliver;
    this.recovery.onHandOff = (ids) => dedup?.pin(ids);
    this.recovery.onCommitted = (ids) => dedup?.unpin(ids);
    const authenticatedUserId = await this.authenticate();
    this.started = true;
    if (this.o.userId && this.o.userId !== authenticatedUserId) {
      throw new Error(`configured Matrix user ${this.o.userId} does not match authenticated user ${authenticatedUserId}`);
    }
    this.userId = authenticatedUserId;
    if (this.o.e2ee !== false) {
      if (!this.o.deviceId) throw Error("Matrix E2EE requires the authenticated device_id; set MATRIX_DEVICE_ID for a device-bound token");
      this.crypto = await MatrixCrypto.open(this.o.cryptoStoreDir ?? path.join(path.dirname(this.o.syncStateFile), "matrix-crypto"), this.o.homeserver, this.userId, this.o.deviceId, (m, p, b) => this.api(m, p, b));
      try {
        const pending = JSON.parse(await readFile(this.pendingCryptoFile, "utf8"));
        if (pending.homeserver !== this.o.homeserver || pending.userId !== this.userId || pending.deviceId !== this.o.deviceId) throw Error("Matrix pending crypto identity mismatch");
        for (const item of pending.events) if (this.roomAdmitted(item.roomId)) this.pendingEncrypted.set(JSON.stringify([item.roomId, item.event.event_id]), item);
        for (const room of pending.encryptedRooms ?? []) this.encryptedRooms.add(room);
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") { this.crypto.close(); this.crypto = undefined; throw err; } }
    }
    this.recovery.owner = { homeserver: this.o.homeserver, userId: authenticatedUserId };
    const saved = await this.recovery.load();
    if (saved.found) {
      for (const thread of saved.threads) this.botThreads.add(thread);
      this.queueInvites(saved.pendingInvites);
      await this.processInvites();
    } else {
      // First start: skip message history, but accept pending invites.
      const r = await this.api("GET", `/sync?timeout=0&filter=${encodeURIComponent(JSON.stringify(SYNC_FILTER))}`);
      await this.crypto?.sync(this.admittedSync(r));
      for (const [roomId, room] of Object.entries<any>(r.rooms?.join ?? {})) {
        if ([...(room.state?.events ?? []), ...(room.timeline?.events ?? [])].some(e => e.type === "m.room.encryption" || e.type === "m.room.encrypted")) this.encryptedRooms.add(roomId);
      }
      if (this.crypto) await this.persistPending();
      this.queueInvites(r.rooms?.invite);
      await this.processInvites();
      this.recovery.advance(r.next_batch);
      await this.recovery.commit(this.botThreads, this.inviteSnapshot());
    }
    this.log(`connected as ${this.userId}`);
    this.loop = this.run();
  }

  /**
   * Stop syncing; pending batches are handed over so the harness can drain them. The cursor
   * may then advance: anything the harness does not finish is persisted and replayed by it.
   */
  async stop(budgetMs = Infinity): Promise<void> {
    this.native.stop();
    this.abort.abort();
    for (const t of this.typingTimers.values()) clearInterval(t);
    this.typingTimers.clear();
    this.typingUsers.clear();
    const finish = async () => {
      await this.loop?.catch(() => undefined);
      await this.telemetry;
      await this.pendingWrite;
      await this.crypto?.idle();
      this.crypto?.close();
      this.crypto = undefined;
      for (const [key, b] of this.batches) {
        clearTimeout(b.timer);
        this.batches.delete(key);
        this.handOff(b.input);
      }
      // Advance the cursor only if every hand-off was durably accepted.
      if (await this.recovery.settle()) await this.recovery.commit(this.botThreads, this.inviteSnapshot()).catch(() => undefined);
    };
    if (!Number.isFinite(budgetMs)) return finish();
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([finish().then(() => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), Math.max(0, budgetMs))))]);
    clearTimeout(timer);
    if (!done) {
      // Hung hand-off: leave the durable cursor where it is (events are redelivered and deduplicated).
      this.recovery.seal();
      this.log("stop: in-flight input not settled within budget; cursor not advanced");
    }
  }

  /**
   * Access token, or password login. Matrix transaction-id dedup (idempotent outbox retries)
   * is scoped to the access token, so a password login's token is persisted (0600) and reused
   * across restarts; only when the homeserver rejects it is a new login performed.
   */
  private async authenticate(): Promise<string> {
    if (!this.o.accessToken) {
      const saved = await readFile(this.tokenFile, "utf8").then((raw) => JSON.parse(raw), () => undefined);
      // A saved token is only ever sent to the homeserver it was issued by.
      if (saved?.userId === this.o.userId && saved?.homeserver === this.o.homeserver && typeof saved?.accessToken === "string") {
        if (this.o.deviceId && saved.deviceId && this.o.deviceId !== saved.deviceId) throw Error("Matrix saved session device_id mismatch");
        this.o.deviceId ??= saved.deviceId;
        this.o.accessToken = saved.accessToken;
        try {
          return await this.whoami();
        } catch (err) {
          if (!(err instanceof HttpError && err.status === 401)) throw err;
          this.log("saved Matrix session rejected, logging in again");
          this.o.accessToken = undefined;
        }
      }
      await this.login();
    }
    return this.whoami();
  }

  private get tokenFile(): string {
    return path.join(path.dirname(this.o.syncStateFile), "matrix-session.json");
  }

  /** Password login; the new token is persisted (0600) for reuse across restarts. */
  private async login(): Promise<void> {
    const r = await this.request("POST", "/login", {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: this.o.userId },
      password: this.o.password,
      // Stable device so restarts do not pile up login devices.
      device_id: this.o.deviceId ?? `PIHARNESS_${createHash("sha256").update(this.o.userId ?? "").digest("hex").slice(0, 10).toUpperCase()}`,
      initial_device_display_name: "vanillacore-harness",
    });
    if (this.o.deviceId && r.device_id !== this.o.deviceId) throw Error("Matrix login device_id mismatch");
    this.o.deviceId = r.device_id;
    this.o.accessToken = r.access_token;
    await mkdir(path.dirname(this.tokenFile), { recursive: true });
    await writeFileDurable(this.tokenFile, JSON.stringify({ homeserver: this.o.homeserver, userId: this.o.userId, accessToken: r.access_token, deviceId: r.device_id }));
  }

  private async whoami(): Promise<string> {
    const identity = await this.api("GET", "/account/whoami");
    const id = identity.user_id;
    if (typeof id !== "string" || !id) throw new Error("Matrix /account/whoami returned no user_id");
    if (identity.device_id) {
      if (this.o.deviceId && this.o.deviceId !== identity.device_id) throw Error("Matrix authenticated device_id mismatch");
      this.o.deviceId = identity.device_id;
    }
    return id;
  }

  private handOff(input: Inbound): void {
    this.recovery.handOff(input, this.deliver);
  }

  private async run(): Promise<void> {
    let backoff = 1000;
    while (!this.abort.signal.aborted) {
      try {
        await this.syncOnce(30_000);
        backoff = 1000;
      } catch (err) {
        if (this.abort.signal.aborted) return;
        this.log(`sync failed: ${err instanceof Error ? err.message : err}; retry in ${backoff / 1000}s`);
        await this.backoff(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** One /sync round trip. Public for tests. */
  async syncOnce(timeoutMs = 0): Promise<void> {
    // A batch flushed between syncs may have failed: rewind before polling.
    if (!(await this.recovery.settle())) throw new Error("input not accepted, will retry");
    const since = this.recovery.since;
    const q = `timeout=${timeoutMs}&filter=${encodeURIComponent(JSON.stringify(SYNC_FILTER))}${since ? `&since=${encodeURIComponent(since)}` : ""}`;
    const r = await this.api("GET", `/sync?${q}`, undefined, timeoutMs);
    await this.crypto?.sync(this.admittedSync(r));
    await this.retryEncrypted();
    this.queueInvites(r.rooms?.invite);
    for (const [roomId, room] of Object.entries<any>(r.rooms?.join ?? {})) {
      if (!this.roomAdmitted(roomId)) continue;
      for (const state of [...(room.state?.events ?? []), ...(room.timeline?.events ?? [])]) {
        if (state.type === "m.room.encryption") {
          if (state.content?.algorithm !== "m.megolm.v1.aes-sha2") throw Error("Unsupported Matrix room encryption algorithm");
          this.encryptedRooms.add(roomId);
        }
      }
      if (this.crypto) await this.persistPending();
      const members = room.summary?.["m.joined_member_count"];
      if (typeof members === "number") this.memberCount.set(roomId, { n: members, at: Date.now() });
      const timeline: MatrixEvent[] = room.timeline?.events ?? [];
      // A limited timeline has a gap: fetch the skipped events before acknowledging.
      if (room.timeline?.limited && room.timeline.prev_batch && since) {
        timeline.unshift(
          ...(await this.recovery.backfill(roomId, room.timeline.prev_batch, since, () => this.abort.signal.aborted, (p) => this.api("GET", p))),
        );
      }
      for (const ev of timeline) {
        try {
          await this.onEvent(roomId, ev);
          this.recovery.clearFailure(ev.event_id);
        } catch (err) {
          // Transient failures (e.g. homeserver hiccup) retry the whole sync from the durable
          // cursor; already accepted events are deduped by the harness. A poison event is
          // skipped after a few attempts so it cannot block the room forever.
          // Transient (network, timeout, 5xx, 429) retries forever with backoff. Anything else
          // is retried a few times, then parked in the dead-letter file (never silently lost).
          const transient = ev.type === "m.room.encrypted" || err instanceof MatrixTransportError || (err instanceof HttpError && (err.status >= 500 || err.status === 429));
          const n = this.recovery.failure(ev.event_id);
          this.log(`event ${ev.event_id} failed (${n}${transient ? "" : `/${MAX_EVENT_ATTEMPTS}`}): ${err instanceof Error ? err.message : err}`);
          if (transient || n < MAX_EVENT_ATTEMPTS) {
            await this.recovery.settle();
            this.recovery.rewind();
            throw new Error("event processing failed, will retry");
          }
          this.recovery.clearFailure(ev.event_id);
          await this.recovery.deadLetter(roomId, ev, err);
        }
      }
    }
    // Durable acknowledgement: advance the cursor only when every message of this sync
    // has been accepted by the harness (persisted inbox). Otherwise the next /sync
    // redelivers them; the harness drops duplicates by event id.
    if (!(await this.recovery.settle())) throw new Error("input not accepted, will retry");
    this.recovery.advance(r.next_batch);
    await this.processInvites();
    // Batch timers may have handed off during the awaits above: settle again, then commit
    // synchronously-checked (no await between the batch check and taking the snapshot).
    if (!(await this.recovery.settle())) throw new Error("input not accepted, will retry");
    if (!this.batches.size && this.recovery.idle()) await this.recovery.commit(this.botThreads, this.inviteSnapshot());
  }

  private async backoff(ms: number): Promise<void> {
    if (this.abort.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.abort.signal.addEventListener("abort", done, { once: true });
    });
  }

  // ---------------------------------------------------------------- inbound

  private roomAdmitted(roomId: string): boolean {
    return this.o.admissionRooms === undefined || this.o.admissionRooms.includes(roomId);
  }

  private admittedSync(response: any): any {
    if (this.o.admissionRooms === undefined) return response;
    return { ...response, rooms: { ...response.rooms, join: Object.fromEntries(Object.entries(response.rooms?.join ?? {}).filter(([room]) => this.roomAdmitted(room))) } };
  }

  private allowed(user: string): boolean {
    return this.o.allowAllUsers || this.o.allowedUsers.includes(user);
  }

  private queueInvites(rooms: Record<string, any> | undefined): void {
    for (const [roomId, room] of Object.entries(rooms ?? {})) this.pendingInvites.set(roomId, room);
  }

  private inviteSnapshot(): Record<string, unknown> {
    return Object.fromEntries(this.pendingInvites);
  }

  private async processInvites(): Promise<void> {
    for (const [roomId, room] of [...this.pendingInvites]) {
      try {
        await this.onInvite(roomId, room);
        this.pendingInvites.delete(roomId);
      } catch (err) {
        const transient = err instanceof MatrixTransportError || (err instanceof HttpError && (err.status >= 500 || err.status === 429));
        this.log(`invite ${roomId} failed${transient ? "; will retry" : "; parked"}: ${err instanceof Error ? err.message : err}`);
        if (!transient) {
          const inviter = (room.invite_state?.events ?? []).find((event: any) => event.type === "m.room.member" && event.state_key === this.userId)?.sender ?? "";
          try {
            await this.recovery.deadLetter(roomId, { type: "m.room.invite", event_id: `invite:${roomId}`, sender: inviter, content: room }, err);
            this.pendingInvites.delete(roomId);
          } catch (deadLetterErr) {
            // Keep it in the durable pending-invite checkpoint until parking succeeds.
            this.log(`invite ${roomId} dead letter failed: ${deadLetterErr instanceof Error ? deadLetterErr.message : deadLetterErr}`);
          }
        }
      }
    }
  }

  private async onInvite(roomId: string, room: any): Promise<void> {
    if (!this.roomAdmitted(roomId)) return;
    const inviter = (room.invite_state?.events ?? []).find((e: any) => e.type === "m.room.member" && e.state_key === this.userId)?.sender;
    if (!inviter || !this.allowed(inviter)) return;
    await this.api("POST", `/rooms/${encodeURIComponent(roomId)}/join`, {});
    this.log(`joined ${roomId} (invited by ${inviter})`);
  }

  private async isDm(roomId: string): Promise<boolean> {
    let c = this.memberCount.get(roomId);
    if (!c || Date.now() - c.at > 300_000) {
      const r = await this.api("GET", `/rooms/${encodeURIComponent(roomId)}/joined_members`);
      c = { n: Object.keys(r.joined ?? {}).length, at: Date.now() };
      this.memberCount.set(roomId, c);
    }
    return c.n <= 2;
  }

  /** Mention check on the message's own content (reply-fallback quotes already removed). */
  private mentions(content: Record<string, any>, body: string): boolean {
    if (content["m.mentions"]?.user_ids?.includes(this.userId)) return true;
    if (body.includes(this.userId)) return true;
    const html = String(content.formatted_body ?? "").replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, "");
    if (html.includes(`matrix.to/#/${this.userId}`) || html.includes(`matrix.to/#/${encodeURIComponent(this.userId)}`)) return true;
    const name = this.o.displayName;
    return !!name && new RegExp(`(^|[^\\w])@?${escapeRe(name)}([^\\w]|$)`, "i").test(body);
  }

  private stripMention(body: string): string {
    let out = body.split(this.userId).join("");
    if (this.o.displayName) out = out.replace(new RegExp(`^\\s*@?${escapeRe(this.o.displayName)}\\s*[:,]?`, "i"), "");
    return out.replace(/^\s*[:,]\s*/, "").trim();
  }

  private async onEvent(roomId: string, ev: MatrixEvent, decrypted = false): Promise<void> {
    if (!this.roomAdmitted(roomId)) return;
    if (ev.sender === this.userId) return;
    if (ev.type === "m.room.encrypted") {
      if (!this.crypto) throw Error("Matrix E2EE is unavailable; refusing encrypted event");
      this.encryptedRooms.add(roomId);
      this.pendingEncrypted.set(JSON.stringify([roomId, ev.event_id]), { roomId, event: ev });
      await this.persistPending();
      await this.retryEncrypted();
      return;
    }
    // Plain reactions remain Matrix-standard; plain text cannot inject prompts/commands
    // into a room whose encryption is known (including rooms discovered after restart).
    if (!decrypted && ev.type === "m.room.message" && await this.roomEncrypted(roomId)) return;
    if (ev.type === "m.reaction") return this.onReaction(roomId, ev);
    if (ev.type !== "m.room.message") return;
    const c = ev.content;
    const rel = c["m.relates_to"] ?? {};
    if (rel.rel_type === "m.replace") return; // edits
    if (c.msgtype === "m.notice" && !this.o.processNotices) return;
    if (c.msgtype !== "m.text" && c.msgtype !== "m.notice" && c.msgtype !== "m.emote") return; // media later
    let body = String(c.body ?? "");
    // Reply fallback quote (also on thread replies): never part of the prompt or mention check.
    if (rel["m.in_reply_to"]) body = body.replace(/^(>.*\n)+\n?/, "");
    const mentioned = this.mentions(c, body);
    if (mentioned) body = this.stripMention(body);
    // Classified after normalization: "Agent: /pause" is the command /pause.
    const isCommand = body.trimStart().startsWith("/");
    // Approvers may always resolve approvals, without general conversational access.
    const approvalCmd = /^\s*\/(approve|deny)(\s|$)/.test(body) && this.o.approvers.includes(ev.sender);
    if (!this.allowed(ev.sender) && !approvalCmd) return;
    const dm = await this.isDm(roomId);
    const explicitThread: string | undefined = rel.rel_type === "m.thread" ? rel.event_id : undefined;
    let thread = explicitThread;
    let replyOptional = false;

    if (!dm) {
      if (this.o.allowedRooms.length && !this.o.allowedRooms.includes(roomId)) return;
      const free = this.o.freeRooms.includes(roomId);
      const inBotThread = !!thread && this.botThreads.has(thread);
      if (this.o.requireMention && !free && !inBotThread && !mentioned && !isCommand) return;
      if (!isCommand && this.o.optionalReplyRooms.includes(roomId)) replyOptional = true;
      else if (free && !isCommand && !mentioned && !inBotThread) replyOptional = true;
      if (!thread && this.o.autoThread && !replyOptional) thread = ev.event_id;
    } else if (!thread && this.o.dmAutoThread) {
      thread = ev.event_id;
    }
    void this.api("POST", `/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(ev.event_id)}`, {}).catch(() => undefined);

    const text = isCommand || dm ? body : `[${ev.sender}] ${body}`;
    const input: Inbound = {
      id: ev.event_id,
      sessionKey: `matrix:${roomId}${thread ? `:${thread}` : ""}`,
      text,
      source: "channel",
      sender: ev.sender,
      replyTo: { channel: "matrix", target: roomId, thread },
      replyOptional: replyOptional || undefined,
    };
    if (decrypted || isCommand || this.o.batchDelayMs <= 0) return this.handOff(input);
    // Keyed before auto-threading: rapid top-level messages merge into the first one's thread.
    this.batch(`${roomId}|${explicitThread ?? ""}|${ev.sender}`, input);
  }

  /** Merge rapid consecutive messages of one sender into one turn (Hermes text batching). */
  private batch(key: string, input: Inbound): void {
    const prev = this.batches.get(key);
    // Bounded: a sender typing faster than the debounce still gets handed off (and the sync
    // checkpoint advances) after MAX_BATCH_MS / MAX_BATCH_PARTS / MAX_BATCH_CHARS.
    if (prev && (Date.now() - prev.since >= MAX_BATCH_MS || (prev.input.parts?.length ?? 1) >= MAX_BATCH_PARTS || prev.input.text.length >= MAX_BATCH_CHARS)) {
      clearTimeout(prev.timer);
      this.batches.delete(key);
      this.handOff(prev.input);
      return this.batch(key, input);
    }
    if (prev) {
      const before = prev.input.parts ?? [{ id: prev.input.id!, text: prev.input.text }];
      // Redelivery after a cursor rewind while the batch is still buffered: keep each event once.
      if (before.some((p) => p.id === input.id)) return;
      clearTimeout(prev.timer);
      const extra = input.text.replace(/^\[[^\]]+\] /, "");
      const parts = [...before, { id: input.id!, text: extra }];
      input = { ...prev.input, parts, text: parts.map((p) => p.text).join("\n"), replyOptional: prev.input.replyOptional && input.replyOptional };
    }
    const timer = setTimeout(() => {
      this.batches.delete(key);
      this.handOff(input);
    }, this.o.batchDelayMs);
    this.batches.set(key, { input, timer, since: prev?.since ?? Date.now() });
  }

  private onReaction(roomId: string, ev: MatrixEvent): void {
    const rel = ev.content["m.relates_to"] ?? {};
    const approvalId = this.approvalEvents.get(rel.event_id);
    if (!approvalId) return;
    if (!this.o.approvers.includes(ev.sender)) {
      this.log(`ignoring approval reaction from ${ev.sender} (not an approver)`);
      return;
    }
    const key = String(rel.key ?? "").replace(/\ufe0f/g, "");
    const verb = [...APPROVE].some((k) => k.replace(/\ufe0f/g, "") === key) ? "approve" : [...DENY].some((k) => k.replace(/\ufe0f/g, "") === key) ? "deny" : undefined;
    if (!verb) return;
    // Keep the mapping: a failed hand-off is redelivered; the harness dedupes by event id
    // and answers "nothing pending" for already resolved approvals.
    this.handOff({ id: ev.event_id, sessionKey: `matrix:${roomId}`, text: `/${verb} ${approvalId}`, source: "channel", sender: ev.sender, replyTo: { channel: "matrix", target: roomId } });
  }

  // ---------------------------------------------------------------- outbound

  private async sendRoom(roomId: string, type: string, txn: string, content: Record<string, any>): Promise<any> {
    if (type === "m.room.message" && await this.roomEncrypted(roomId)) {
      if (!this.crypto) throw Error("Matrix E2EE is unavailable; refusing plaintext downgrade");
      const joined = await this.api("GET", `/rooms/${encodeURIComponent(roomId)}/joined_members`);
      if (!joined.joined || typeof joined.joined !== "object" || !Object.hasOwn(joined.joined, this.userId)) throw Error("Matrix encrypted room membership unavailable");
      content = await this.crypto.encrypt(roomId, type, content, Object.keys(joined.joined));
      type = "m.room.encrypted";
    }
    return this.api("PUT", `/rooms/${encodeURIComponent(roomId)}/send/${type}/${txn}`, content);
  }

  async send(to: Address, text: string, meta?: SendMeta): Promise<void> {
    if (meta?.progressId) {
      if (meta.presentation !== "progress") await this.telemetry;
      try { await this.sendEditable(to, text, meta); }
      catch (err) {
        if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429 && err.status !== 401) throw new PermanentDeliveryError(err.message);
        throw err;
      }
      return;
    }
    // Same reply → same transaction ids, so a retry after a lost response is deduplicated
    // by the homeserver and already-sent chunks of a multi-part reply are not posted twice.
    const parts = fitChunks(text, MAX_CHUNK, (chunk) => renderContent(chunk, meta));
    for (const [n, chunk] of parts.entries()) {
      const content = renderContent(chunk, meta);
      if (to.thread) content["m.relates_to"] = { rel_type: "m.thread", event_id: to.thread, is_falling_back: true, "m.in_reply_to": { event_id: to.thread } };
      const r = await this.sendRoom(to.target, "m.room.message", encodeURIComponent(meta?.deliveryId ? `${meta.deliveryId}.${n}` : randomUUID()), content).catch((err) => {
        // 4xx other than 429 (and 401: token may be renewed) cannot succeed by retrying.
        if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429 && err.status !== 401) {
          throw new PermanentDeliveryError(err.message);
        }
        throw err;
      });
      // Only threads the bot actually answered in skip the mention requirement.
      if (to.thread) this.botThreads.add(to.thread);
      if (meta?.approvalId && r.event_id) {
        this.approvalEvents.set(r.event_id, meta.approvalId);
        if (this.approvalEvents.size > 500) this.approvalEvents.delete(this.approvalEvents.keys().next().value!);
      }
    }
  }

  private async sendEditable(to: Address, text: string, meta: SendMeta): Promise<void> {
    const logical = createHash("sha256").update(JSON.stringify([to.target, to.thread, meta.progressId])).digest("hex");
    const relation = to.thread ? { "m.relates_to": { rel_type: "m.thread", event_id: to.thread, is_falling_back: true, "m.in_reply_to": { event_id: to.thread } } } : {};
    // Reusing this transaction resolves the native reference even after restart or a lost response.
    const seed = await this.sendRoom(to.target, "m.room.message", `${logical}.seed`, {
      ...renderContent(meta.progressId?.startsWith("native:") ? text : "⏳ Wird bearbeitet …", { presentation: "progress" }), ...relation,
    });
    if (typeof seed.event_id !== "string") throw Error("Matrix progress reference missing");
    if (meta.presentation !== "progress") {
      try {
        const original = await this.api("GET", `/rooms/${encodeURIComponent(to.target)}/event/${encodeURIComponent(seed.event_id)}`);
        if (original.unsigned?.redacted_because || (original.type !== "m.room.encrypted" && original.content && !original.content.msgtype)) {
          await this.send(to, text, { ...meta, progressId: undefined });
          return;
        }
      } catch (err) {
        if (!(err instanceof HttpError && [403, 404].includes(err.status))) throw err;
        await this.send(to, text, { ...meta, progressId: undefined });
        return;
      }
    }
    const renderEdit = (chunk: string) => {
      const content = renderContent(chunk, meta);
      return { ...content, body: `* ${chunk}`, "m.new_content": { ...content, ...relation }, "m.relates_to": { rel_type: "m.replace", event_id: seed.event_id } };
    };
    const parts = fitChunks(text || (meta.outcome === "cancelled" ? "⏹️ Abgebrochen." : meta.outcome === "failed" ? "❌ Fehlgeschlagen." : "✅ Bearbeitung abgeschlossen."), MAX_CHUNK, renderEdit);
    const txn = meta.deliveryId ?? randomUUID();
    try {
      await this.sendRoom(to.target, "m.room.message", `${logical}.${encodeURIComponent(txn)}.edit`, renderEdit(parts[0]!));
    } catch (err) {
      if (!(err instanceof HttpError && [403, 404].includes(err.status))) throw err;
      await this.send(to, text, { ...meta, progressId: undefined });
      return;
    }
    if (to.thread) this.botThreads.add(to.thread);
    // Long final answers keep the first chunk in place; remaining chunks use normal durable IDs.
    if (parts.length > 1) await this.send(to, parts.slice(1).join("\n"), { ...meta, progressId: undefined, deliveryId: `${logical}.${txn}.tail` });
  }

  /** Serialize room updates: a slow stop must never overtake the next start. */
  private putTyping(to: Address): Promise<void> {
    const previous = this.typingRequests.get(to.target) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const on = (this.typingUsers.get(to.target) ?? 0) > 0;
      await this.api("PUT", `/rooms/${encodeURIComponent(to.target)}/typing/${encodeURIComponent(this.userId)}`,
        on ? { typing: true, timeout: 30_000 } : { typing: false });
    });
    this.typingRequests.set(to.target, next);
    void next.finally(() => {
      if (this.typingRequests.get(to.target) === next) this.typingRequests.delete(to.target);
    }).catch(() => undefined);
    return next;
  }

  /** Typing indicator; refreshed every 10s for long turns. */
  async typing(to: Address, on: boolean): Promise<void> {
    const users = this.typingUsers.get(to.target) ?? 0;
    if (on) this.typingUsers.set(to.target, users + 1);
    else if (users > 1) { this.typingUsers.set(to.target, users - 1); return; }
    else this.typingUsers.delete(to.target);
    if (on && users > 0) return;
    clearInterval(this.typingTimers.get(to.target));
    this.typingTimers.delete(to.target);
    if (on) {
      const t = setInterval(() => void this.putTyping(to).catch(() => this.log("[matrix] typing renewal failed")), 10_000);
      t.unref?.();
      this.typingTimers.set(to.target, t);
    }
    await this.putTyping(to);
  }
}

const SYNC_FILTER = {
  presence: { not_types: ["*"] },
  account_data: { not_types: ["*"] },
  room: {
    timeline: { types: ["m.room.message", "m.room.encrypted", "m.room.encryption", "m.room.member", "m.reaction"], limit: 50 },
    state: { lazy_load_members: true, types: ["m.room.member", "m.room.encryption"] },
    ephemeral: { not_types: ["*"] },
    account_data: { not_types: ["*"] },
  },
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matrix event content for a text chunk (plain + Markdown-rendered HTML when it differs). */
function renderContent(chunk: string, meta?: SendMeta): Record<string, unknown> {
  const content: Record<string, unknown> = { msgtype: "m.text", body: chunk };
  if (meta?.presentation === "progress") {
    const escaped = chunk.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
    return { ...content, format: "org.matrix.custom.html", formatted_body: `<em>${escaped}</em>` };
  }
  const html = (marked.parse(chunk, { async: false, gfm: true, breaks: true }) as string).trim();
  if (html !== `<p>${chunk}</p>`) Object.assign(content, { format: "org.matrix.custom.html", formatted_body: html });
  return content;
}

/** Event limit is 65,536 bytes incl. metadata; keep content well below it. */
const MAX_CONTENT_BYTES = 48_000;

/** Split until every chunk's serialized content (body + HTML, UTF-8) fits the byte budget. */
export function fitChunks(text: string, max: number, render: (chunk: string) => Record<string, unknown>, budget = MAX_CONTENT_BYTES): string[] {
  const out: string[] = [];
  const queue = chunks(text, max);
  while (queue.length) {
    const chunk = queue.shift()!;
    if (Buffer.byteLength(JSON.stringify(render(chunk))) <= budget || [...chunk].length < 2) {
      out.push(chunk);
      continue;
    }
    queue.unshift(...chunks(chunk, Math.ceil([...chunk].length / 2)));
  }
  return out;
}

/** Split on newlines where possible, never inside a surrogate pair (counts code points). */
export function chunks(text: string, max: number): string[] {
  let rest = [...text];
  if (rest.length <= max) return [text];
  const out: string[] = [];
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).join(""));
    rest = rest.slice(cut);
    if (rest[0] === "\n") rest = rest.slice(1);
  }
  if (rest.length) out.push(rest.join(""));
  return out;
}
