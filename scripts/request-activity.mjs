/** Diagnostic state only: no built-in timeout and no inference from GPU-wide
 * counters, open sockets, response headers or SSE keepalives. */
export class RequestActivity {
  constructor(id, now = Date.now) {
    this.id = id; this.now = now; this.started = now();
    this.events = 0; this.outputUnits = 0; this.tokens = 0;
  }
  transport() { this.lastTransportAt = this.now(); }
  headers(status) { this.status = status; this.headersAt = this.now(); }
  frame(value) {
    let units = 0, tokens = 0;
    for (const choice of value?.choices ?? []) {
      tokens += Array.isArray(choice.token_ids) ? choice.token_ids.length : 0;
      const delta = choice.delta ?? {};
      for (const key of ['content', 'reasoning', 'reasoning_content']) if (typeof delta[key] === 'string') units += delta[key].length;
      for (const call of delta.tool_calls ?? []) for (const key of ['name', 'arguments']) {
        const text = call.function?.[key]; if (typeof text === 'string') units += text.length;
      }
    }
    tokens += Array.isArray(value?.token_ids) ? value.token_ids.length : 0;
    if (units > 0 || tokens > 0) {
      this.events++; this.outputUnits += units; this.tokens += tokens; this.lastModelAt = this.now();
    }
  }
  finish() { this.finishedAt ??= this.now(); }
  snapshot() {
    const now = this.finishedAt ?? this.now();
    return { id: this.id, status: this.status, elapsedMs: now - this.started,
      state: this.finishedAt !== undefined ? 'finished' : this.lastModelAt === undefined ? 'waiting-or-prefill-unknown' : 'model-stream-observed',
      headerMs: this.headersAt === undefined ? null : this.headersAt - this.started,
      firstTransportObserved: this.lastTransportAt !== undefined, events: this.events,
      outputUnits: this.outputUnits, emittedTokenIds: this.tokens,
      modelInactiveMs: this.lastModelAt === undefined ? null : now - this.lastModelAt };
  }
  /** Only an explicit caller policy may use this. Queue/prefill before the first
   * own delta is unknown, not evidence of a stalled model. */
  inactive(limitMs) {
    return this.finishedAt === undefined && this.lastModelAt !== undefined &&
      Number.isFinite(limitMs) && limitMs > 0 && this.now() - this.lastModelAt >= limitMs;
  }
}
