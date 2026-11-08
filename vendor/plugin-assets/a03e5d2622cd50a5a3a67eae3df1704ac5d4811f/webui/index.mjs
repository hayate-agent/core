import { createServer } from 'node:http';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults, readUI, loadModules, activateSettingsTool } from './ui.mjs';

const assets = fileURLToPath(new URL('./public/', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });
const MAX_TEXT = 64_000;

/** Native GatewayModule v1. No host imports, SDK subprocess or parallel agent runtime. */
export default {
  apiVersion: 1,
  // Ingress/agent work is host-owned; stop/onStop drain all presentation resources.
  // UI modules must explicitly uphold the same contract (validated at startup).
  updateAdmission: 'foreground-owned',
  activate: activateSettingsTool,
  async create(context) {
    const port = Number(process.env.HAYATE_WEBUI_PORT ?? 3210);
    return { channel: new WebUIChannel({ home: context.home, agent: context.agent, port }) };
  },
};

export class WebUIChannel {
  name = 'webui';
  #server;
  #deliver;
  #origin;
  #clients = new Set();
  #live = new Map();
  #data = { version: 1, chats: [] };
  #serial = Promise.resolve();
  #requests = new Set();
  #timer;
  #closing = false;
  #ui = {};
  #modules;
  #modulePaths = '[]';
  #refreshing = false;
  #refreshWork;
  #starting;
  #stopping;
  #cleanupError;
  #sockets = new Set();
  #uiError;
  #notifyTimer;
  constructor({ home, agent = 'Hayate', port = 3210 }) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid WebUI port');
    this.port = port;
    this.home = home;
    this.agent = agent;
    this.file = path.join(home, 'webui', 'conversations.json');
  }
  get url() { return this.#origin; }
  #transaction(fn) {
    const next = this.#serial.then(async () => {
      const candidate = structuredClone(this.#data);
      const result = await fn(candidate);
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(candidate), { mode: 0o600 });
      await rename(temp, this.file);
      this.#data = candidate;
      this.#broadcast();
      return result;
    });
    this.#serial = next.catch(() => {});
    return next;
  }
  #chat(id, data = this.#data) {
    const chat = data.chats.find(c => c.id === id);
    if (!chat) throw fail(404, 'Conversation not found');
    return chat;
  }
  #presentation(id) {
    const extra = this.#modules?.project({ agent: this.agent, conversationId: id, active: id ? this.#live.has(id) : this.#live.size > 0 }) ?? { panels: [], actions: [] };
    return { ...defaults, ...this.#ui, modules: undefined, error: this.#uiError,
      panels: [...(this.#ui.panels ?? []), ...extra.panels], actions: [...(this.#ui.actions ?? []), ...extra.actions] };
  }
  #snapshot() {
    return { agent: this.agent, ui: this.#presentation(), chats: this.#data.chats.map(({ messages, deliveries, ...chat }) => chat).sort((a, b) => b.updatedAt - a.updatedAt) };
  }
  #view(id) { return { ...this.#chat(id), ui: this.#presentation(id), live: this.#live.get(id) ?? null }; }
  #notify() {
    if (this.#closing) return;
    if (!this.#notifyTimer) this.#notifyTimer = setTimeout(() => {
      this.#notifyTimer = undefined;
      for (const client of this.#clients) if (client.chat) {
        this.#writeEvent(client, { type: 'live', id: client.chat, live: this.#live.get(client.chat) ?? null });
      }
    }, 60);
  }
  async #refreshUI() {
    if (this.#refreshing || this.#closing) return;
    this.#refreshing = true;
    try {
      const next = await readUI(this.home);
      this.#uiError = JSON.stringify(next.modules ?? []) !== this.#modulePaths ? 'Module changes require a WebUI restart.' : undefined;
      this.#ui = next;
    } catch { this.#uiError = 'Invalid UI settings; retaining the last valid presentation.'; }
    finally { this.#refreshing = false; }
    if (!this.#closing) for (const client of this.#clients) {
      this.#writeEvent(client, { type: 'presentation', id: client.chat, ui: this.#presentation(client.chat) });
    }
  }
  #writeEvent(client, data) {
    if (client.res.writableLength > 1_000_000) { client.res.destroy(); return; }
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
  #broadcast() {
    for (const client of this.#clients) {
      // Bound slow-reader memory. EventSource reconnect obtains a complete snapshot.
      const data = client.chat ? this.#view(client.chat) : this.#snapshot();
      this.#writeEvent(client, data);
    }
  }
  start(deliver) {
    if (this.#cleanupError) return Promise.reject(Error('WebUI cleanup failed; process restart required', { cause: this.#cleanupError }));
    if (this.#server || this.#starting || this.#stopping) return Promise.reject(Error('WebUI already started or transitioning'));
    this.#closing = false;
    const work = this.#open(deliver);
    this.#starting = work;
    void work.then(() => { this.#starting = undefined; }, () => { this.#starting = undefined; });
    return work;
  }
  async #open(deliver) {
    try {
      this.#data = JSON.parse(await readFile(this.file, 'utf8'));
      if (this.#data.version !== 1 || !Array.isArray(this.#data.chats) || this.#data.chats.some(c => !uuid.test(c.id) || !Array.isArray(c.messages))) throw Error('Invalid WebUI conversation store');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.#ui = await readUI(this.home);
    this.#modulePaths = JSON.stringify(this.#ui.modules ?? []);
    try { this.#modules = await loadModules(this.home, this.#ui); }
    catch (error) { if (error.cleanupFailed) this.#cleanupError = error; throw error; }
    this.#deliver = deliver;
    const server = createServer((req, res) => {
      const work = this.#handle(req, res).catch(error => {
        if (res.headersSent) { res.destroy(); return; }
        this.#json(res, error.status ?? 500, { error: error.status ? error.message : 'WebUI operation failed; retry with the same message ID.' });
      });
      this.#requests.add(work);
      void work.then(() => this.#requests.delete(work), () => this.#requests.delete(work));
    });
    server.on('connection', socket => {
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.port, '127.0.0.1', resolve);
      });
    } catch (error) {
      server.close();
      const modules = this.#modules; this.#modules = undefined;
      try { await modules.stop(); } catch (cleanupError) {
        this.#cleanupError = cleanupError;
        throw new AggregateError([error, cleanupError], 'WebUI startup and cleanup failed');
      }
      throw error;
    }
    this.#server = server;
    this.#origin = `http://127.0.0.1:${server.address().port}`;
    this.#timer = setInterval(() => {
      if (!this.#refreshWork && !this.#closing) {
        this.#refreshWork = this.#refreshUI().catch(() => {
          this.#uiError = 'Presentation refresh failed; retaining the last valid settings.';
        }).finally(() => { this.#refreshWork = undefined; });
      }
      for (const { res } of this.#clients) {
        if (res.writableLength > 1_000_000) res.destroy();
        else res.write(': heartbeat\n\n');
      }
    }, 2_000);
    this.#timer.unref();
  }
  #json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }
  async #body(req) {
    if (req.headers['content-type'] !== 'application/json') throw fail(415, 'JSON required');
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 300_000) throw fail(413, 'Request too large');
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected object');
      if (this.#closing) throw fail(503, 'WebUI stopping');
      return value;
    } catch (error) { if (error.status) throw error; throw fail(400, 'Invalid JSON object'); }
  }
  async #handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    // Exact authority prevents DNS rebinding. No proxy or forwarded-header trust.
    if (req.headers.host !== new URL(this.#origin).host) throw fail(403, 'Invalid host');
    if (this.#closing) throw fail(503, 'WebUI stopping');
    if (req.headers.origin && req.headers.origin !== this.#origin) throw fail(403, 'Invalid origin');
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw fail(403, 'Cross-site request refused');
    if (req.method !== 'GET' && (req.headers.origin !== this.#origin || req.headers['x-hayate-webui'] !== '1')) throw fail(403, 'Same-origin WebUI request required');
    const url = new URL(req.url, this.#origin);
    if (req.method === 'GET') {
      const asset = { '/': ['index.html', 'text/html'], '/app.js': ['app.bundle.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] }[url.pathname];
      if (asset) {
        const body = await readFile(path.join(assets, asset[0]));
        res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` }); res.end(body); return;
      }
      if (url.pathname === '/api/state') { this.#json(res, 200, this.#snapshot()); return; }
      if (url.pathname === '/api/events') {
        const chat = url.searchParams.get('chat');
        if (chat) this.#chat(chat);
        if (this.#clients.size >= 32) throw fail(429, 'Too many live connections');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        const client = { res, chat };
        this.#clients.add(client);
        res.on('close', () => this.#clients.delete(client));
        res.write(`data: ${JSON.stringify(chat ? this.#view(chat) : this.#snapshot())}\n\n`);
        return;
      }
      const match = /^\/api\/chats\/([^/]+)$/.exec(url.pathname);
      if (match) { this.#json(res, 200, this.#view(match[1])); return; }
    }
    if (req.method === 'POST' && url.pathname === '/api/chats') {
      await this.#body(req);
      const chat = { id: randomUUID(), title: 'New conversation', updatedAt: Date.now(), messages: [] };
      await this.#transaction(data => {
        data.chats.unshift(chat);
      });
      this.#json(res, 201, chat); return;
    }
    const match = /^\/api\/chats\/([^/]+)\/(messages|title)$/.exec(url.pathname);
    if (req.method === 'POST' && match) {
      const [, id, action] = match;
      this.#chat(id);
      const body = await this.#body(req);
      if (action === 'title') {
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 120) throw fail(400, 'Title must have 1–120 characters');
        await this.#transaction(data => { this.#chat(id, data).title = body.title.trim(); });
        this.#json(res, 200, { ok: true }); return;
      }
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_TEXT || !uuid.test(body.id)) throw fail(400, 'Invalid message or ID (maximum 64000 characters)');
      const text = body.text.trim();
      // Persist presentation before host acceptance. Failed/unconfirmed acceptance is safe to retry:
      // the host deduplicates the stable inbound id; no independent execution queue lives here.
      await this.#transaction(data => {
        const chat = this.#chat(id, data);
        const previous = chat.messages.find(m => m.id === body.id);
        if (previous && (previous.role !== 'user' || previous.text !== text)) throw fail(409, 'Message ID already used');
        if (!previous) {
          chat.messages.push({ id: body.id, role: 'user', text, at: Date.now(), accepted: false });
          if (chat.title === 'New conversation') chat.title = text.replace(/\s+/g, ' ').slice(0, 72);
          chat.updatedAt = Date.now();
        }
      });
      if (this.#closing) throw fail(503, 'WebUI stopping; retry with the same message ID');
      await this.#deliver({ id: `webui:${id}:${body.id}`, sessionKey: `webui:${id}`, text,
        source: 'channel', sender: 'webui:local', replyTo: { channel: 'webui', target: id } });
      await this.#transaction(data => { this.#chat(id, data).messages.find(m => m.id === body.id).accepted = true; });
      this.#json(res, 202, { accepted: true, id: body.id }); return;
    }
    throw fail(404, 'Not found');
  }
  async send(to, text, meta = {}) {
    if (this.#closing) throw fail(503, 'WebUI stopping');
    // Delivery acknowledgements happen only after presentation persistence. Core owns retries.
    await this.#transaction(data => {
      const chat = this.#chat(to.target, data);
      chat.deliveries ??= chat.messages.map(m => m.deliveryId).filter(Boolean);
      if (meta.deliveryId && chat.deliveries.includes(meta.deliveryId)) return;
      if (meta.deliveryId) chat.deliveries.push(meta.deliveryId);
      const message = { id: randomUUID(), role: 'assistant', text, at: Date.now(),
        deliveryId: meta.deliveryId, outcome: meta.outcome, progressId: meta.progressId,
        progress: meta.presentation === 'progress' };
      const previous = meta.progressId ? chat.messages.findIndex(m => m.role === 'assistant' && m.progressId === meta.progressId) : -1;
      if (previous >= 0) chat.messages[previous] = message;
      else chat.messages.push(message);
      chat.updatedAt = Date.now();
    });
    if (meta.presentation !== 'progress' && !meta.approvalId) this.#live.delete(to.target);
    this.#broadcast();
  }
  turnEvent(to, event) {
    if (this.#closing) return;
    if (!this.#data.chats.some(c => c.id === to.target)) return;
    const live = this.#live.get(to.target) ?? { text: '', tools: Object.create(null), completed: 0, failed: 0, startedAt: Date.now() };
    if (event.type === 'text') live.text += event.delta;
    if (event.type === 'tool') {
      const name = String(event.name).slice(0, 120);
      if (event.phase === 'start') live.tools[name] = (live.tools[name] ?? 0) + 1;
      else { live.tools[name] = Math.max(0, (live.tools[name] ?? 0) - 1); live.completed++; if (event.error) live.failed++; }
    }
    if (event.type === 'usage') live.usage = { model: event.model, input: event.input, output: event.output, costUsd: event.costUsd };
    // Deliberately ignore tool arguments/details and hidden reasoning.
    this.#live.set(to.target, live);
    this.#notify();
  }
  async typing(to, on) {
    if (this.#closing) return;
    if (on && !this.#live.has(to.target)) this.#live.set(to.target, { text: '', tools: Object.create(null), completed: 0, failed: 0, startedAt: Date.now() });
    if (!on) {
      const live = this.#live.get(to.target);
      if (live?.text) live.awaitingDelivery = true;
      else this.#live.delete(to.target);
    }
    this.#broadcast();
  }
  stop() {
    if (this.#stopping) return this.#stopping;
    // Fence synchronously, including requests paused in body parsing or persistence.
    this.#closing = true;
    const work = this.#close();
    this.#stopping = work;
    void work.then(() => { this.#stopping = undefined; }, error => {
      this.#cleanupError = error; this.#stopping = undefined;
    });
    return work;
  }
  async #close() {
    // An in-flight start owns its resources until it settles. Never return early.
    await this.#starting?.catch(() => {});
    clearInterval(this.#timer);
    clearTimeout(this.#notifyTimer);
    this.#notifyTimer = undefined;
    for (const { res } of this.#clients) res.end();
    this.#clients.clear();
    const server = this.#server;
    if (server) {
      const closed = new Promise(resolve => server.close(resolve));
      // Interrupt incomplete headers/bodies and SSE, not their accepted host work.
      // A disconnected submission is unconfirmed and retries use its stable ID.
      for (const socket of this.#sockets) socket.destroy();
      await closed;
      this.#server = undefined;
    }
    await Promise.allSettled([...this.#requests]);
    await this.#refreshWork;
    await this.#serial;
    this.#live.clear();
    const modules = this.#modules;
    this.#modules = undefined;
    await modules?.stop();
    if (this.#cleanupError) throw this.#cleanupError;
  }
}
