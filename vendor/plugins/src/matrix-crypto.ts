import { OlmMachine, UserId, DeviceId, RoomId, DeviceLists, EncryptionSettings, EncryptionAlgorithm, HistoryVisibility, RequestType, ShieldStateCode } from "@matrix-org/matrix-sdk-crypto-nodejs";
import { mkdir, readFile, writeFile, chmod, lstat } from "node:fs/promises";
import path from "node:path";
import type { MatrixEvent } from "./matrix-sync.js";

type Api = (method: string, path: string, body?: any) => Promise<any>;
type Request = Awaited<ReturnType<OlmMachine["outgoingRequests"]>>[number];

/** Rust SDK owns all Olm/Megolm keys, signing, replay checks and SQLite persistence. */
export class MatrixCrypto {
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(private readonly machine: OlmMachine, private readonly api: Api) {}

  static async open(directory: string, homeserver: string, userId: string, deviceId: string, api: Api): Promise<MatrixCrypto> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const st = await lstat(directory);
    if (!st.isDirectory() || st.isSymbolicLink()) throw Error("Matrix crypto store must be a private directory, not a symlink");
    await chmod(directory, 0o700);
    const identity = JSON.stringify({ homeserver, userId, deviceId });
    const file = path.join(directory, "identity.json");
    try { await writeFile(file, identity, { flag: "wx", mode: 0o600 }); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    if (await readFile(file, "utf8") !== identity) throw Error("Matrix crypto store identity mismatch; never reuse a store for another homeserver/user/device");
    return new MatrixCrypto(await OlmMachine.initialize(new UserId(userId), new DeviceId(deviceId), path.join(directory, "sqlite")), api);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async request(r: Request): Promise<void> {
    let method = "POST", endpoint: string;
    switch (r.type) {
      case RequestType.KeysUpload: endpoint = "/keys/upload"; break;
      case RequestType.KeysQuery: endpoint = "/keys/query"; break;
      case RequestType.KeysClaim: endpoint = "/keys/claim"; break;
      case RequestType.SignatureUpload: endpoint = "/keys/signatures/upload"; break;
      case RequestType.ToDevice: {
        const q = r as import("@matrix-org/matrix-sdk-crypto-nodejs").ToDeviceRequest;
        method = "PUT"; endpoint = `/sendToDevice/${encodeURIComponent(q.eventType)}/${encodeURIComponent(q.txnId)}`; break;
      }
      case RequestType.RoomMessage: {
        const q = r as import("@matrix-org/matrix-sdk-crypto-nodejs").RoomMessageRequest;
        method = "PUT"; endpoint = `/rooms/${encodeURIComponent(q.roomId)}/send/${encodeURIComponent(q.eventType)}/${encodeURIComponent(q.txnId)}`; break;
      }
      default: throw Error(`Unsupported Matrix crypto request type ${r.type}`);
    }
    const response = await this.api(method, endpoint, JSON.parse(r.body));
    // Do not acknowledge failed/partial key operations: no subsequent plaintext fallback.
    if (response.failures && Object.keys(response.failures).length) throw Error("Matrix crypto key request partially failed");
    if (r.type === RequestType.KeysQuery) {
      for (const user of Object.keys(JSON.parse(r.body).device_keys)) if (!response.device_keys || !Object.hasOwn(response.device_keys, user)) throw Error("Matrix crypto device query incomplete");
    }
    if (r.type === RequestType.KeysClaim) {
      for (const [user, devices] of Object.entries<any>(JSON.parse(r.body).one_time_keys)) {
        for (const device of Object.keys(devices)) if (!Object.keys(response.one_time_keys?.[user]?.[device] ?? {}).length) throw Error("Matrix crypto one-time key unavailable; refusing incomplete sharing");
      }
    }
    await this.machine.markRequestAsSent(r.id, r.type, JSON.stringify(response));
  }

  private async flush(): Promise<void> {
    for (const request of await this.machine.outgoingRequests()) await this.request(request);
  }

  sync(response: any): Promise<void> {
    return this.serial(async () => {
      const tracked = new Set<string>();
      for (const room of Object.values<any>(response.rooms?.join ?? {})) {
        for (const event of [...(room.state?.events ?? []), ...(room.timeline?.events ?? [])]) {
          if (event.type === "m.room.member" && event.content?.membership === "join" && typeof event.state_key === "string") tracked.add(event.state_key);
          if (event.type === "m.room.encrypted" && typeof event.sender === "string") tracked.add(event.sender);
        }
      }
      if (tracked.size) await this.machine.updateTrackedUsers([...tracked].map(u => new UserId(u)));
      await this.machine.receiveSyncChanges(JSON.stringify(response.to_device?.events ?? []), new DeviceLists(
        (response.device_lists?.changed ?? []).map((u: string) => new UserId(u)),
        (response.device_lists?.left ?? []).map((u: string) => new UserId(u)),
      ), response.device_one_time_keys_count ?? {}, response.device_unused_fallback_key_types ?? []);
      await this.flush();
    });
  }

  encrypt(room: string, type: string, content: Record<string, any>, members: string[]): Promise<Record<string, any>> {
    return this.serial(async () => {
      const users = members.map(u => new UserId(u));
      await this.machine.updateTrackedUsers(users);
      await this.flush();
      const missing = await this.machine.getMissingSessions(users);
      if (missing) await this.request(missing);
      const settings = new EncryptionSettings();
      settings.algorithm = EncryptionAlgorithm.MegolmV1AesSha2;
      settings.historyVisibility = HistoryVisibility.Joined;
      // This binding has no invalidateGroupSession API. Rotate each message so a departed
      // member/device can never retain the next message's session key (including restart).
      settings.rotationPeriodMessages = 1n;
      for (const request of await this.machine.shareRoomKey(new RoomId(room), users, settings)) await this.request(request);
      return JSON.parse(await this.machine.encryptRoomEvent(new RoomId(room), type, JSON.stringify(content)));
    });
  }

  decrypt(room: string, event: MatrixEvent): Promise<MatrixEvent> {
    return this.serial(async () => {
      // Backfill events may precede the sync membership snapshot.
      await this.machine.updateTrackedUsers([new UserId(event.sender)]);
      await this.flush();
      const decrypted = await this.machine.decryptRoomEvent(JSON.stringify(event), new RoomId(room));
      const plain = JSON.parse(decrypted.event);
      if (plain.type === "m.room.encrypted" || !plain.content || typeof plain.content !== "object") throw Error("Invalid nested encrypted Matrix payload");
      // Never let inner JSON replace the server envelope used by ACLs and deduplication.
      if (plain.sender && plain.sender !== event.sender) throw Error("Matrix encrypted sender mismatch");
      if (plain.room_id && plain.room_id !== room) throw Error("Matrix encrypted room mismatch");
      const shield = decrypted.shieldState(false);
      if (shield && [ShieldStateCode.AuthenticityNotGuaranteed, ShieldStateCode.UnknownDevice, ShieldStateCode.VerificationViolation].includes(shield.code)) throw Error("Matrix encrypted sender authenticity not established");
      return { ...event, type: plain.type, content: plain.content };
    });
  }

  async idle(): Promise<void> { await this.tail; }
  close(): void { this.machine.close(); }
}
