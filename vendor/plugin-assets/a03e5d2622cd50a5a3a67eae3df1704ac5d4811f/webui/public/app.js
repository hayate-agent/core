import { marked } from 'marked';
import DOMPurify from 'dompurify';

const $ = id => document.getElementById(id);
const view = $('conversation');
let selected;
let conversation;
let list = [];
let listEvents;
let chatEvents;
let follow = true;
let sending = false;
const drafts = new Map();
const pending = new Map();
const nodes = new Map();

function notice(message = '') { $('error').textContent = message; $('error').hidden = !message; }
async function request(url, body) {
  const response = await fetch(url, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hayate-WebUI': '1' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || `HTTP ${response.status}`);
  return result;
}
function guarded(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(error => notice(error.message)); }
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, run) {
  const node = element('button', text);
  node.type = 'button'; node.addEventListener('click', guarded(run)); return node;
}
function renderList() {
  const query = $('search').value.toLocaleLowerCase();
  $('chats').replaceChildren(...list.filter(c => c.title.toLocaleLowerCase().includes(query)).map(chat => {
    const node = button(chat.title, () => select(chat.id));
    node.setAttribute('aria-current', String(chat.id === selected)); return node;
  }));
}
async function copy(text, node) {
  await navigator.clipboard.writeText(text);
  node.textContent = 'Copied';
  setTimeout(() => { if (node.isConnected) node.textContent = 'Copy'; }, 1400);
}
function markdown(text) {
  const body = element('div', undefined, 'body');
  // No raw HTML, images, SVG, styles, event handlers or model-defined UI controls.
  const html = marked.parse(text, { async: false });
  body.innerHTML = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a'],
    ALLOWED_ATTR: ['href', 'title', 'class', 'start'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  });
  for (const link of body.querySelectorAll('a')) {
    try {
      const url = new URL(link.getAttribute('href'));
      if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) throw Error();
      link.rel = 'noopener noreferrer'; link.target = '_blank';
    } catch { link.removeAttribute('href'); }
  }
  for (const pre of body.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    const label = element('div', code?.className.replace(/^language-/, '') || 'Code', 'code-label');
    const copyButton = button('Copy', () => copy(code?.textContent ?? pre.textContent, copyButton));
    label.append(copyButton); pre.before(label);
  }
  return body;
}
function messageNode(message) {
  const node = element('article', undefined, `message ${message.role}${message.progress ? ' progress' : ''}`);
  node.setAttribute('aria-label', message.role === 'user' ? 'Your message' : 'Hayate response');
  node.append(message.role === 'user' ? element('div', message.text) : markdown(message.text));
  if (message.outcome) node.append(element('div', message.outcome === 'cancelled' ? '■ Cancelled' : '✕ Failed', 'outcome'));
  const tools = element('div', undefined, 'tools');
  if (message.role === 'user' && message.accepted === false) {
    const id = selected;
    tools.append(element('span', 'Acceptance unconfirmed'), button('Retry safely', async () => {
      await request(`/api/chats/${id}/messages`, { id: message.id, text: message.text });
      if (pending.get(id)?.id === message.id) {
        pending.delete(id); sessionStorage.setItem('hayate.webui.pending', JSON.stringify([...pending]));
      }
      if (selected === id && $('input').value.trim() === message.text) $('input').value = '';
    }));
  }
  const copyButton = button('Copy', () => copy(message.text, copyButton));
  tools.append(copyButton); node.append(tools); return node;
}
function applyUI(ui, active) {
  if (!ui) return;
  const theme = localStorage.getItem('hayate.webui.theme') || ui.theme;
  if (theme === 'system') delete document.body.dataset.theme;
  else document.body.dataset.theme = theme;
  $('input').placeholder = ui.placeholder;
  document.title = `${ui.title} · WebUI`;
  $('activity').hidden = ui.workArea === 'hidden' || (ui.workArea === 'auto' && !active);
  $('activity').style.maxHeight = `${ui.workAreaRows * 1.65}em`;
  const signature = JSON.stringify({ panels: ui.panels, actions: ui.actions });
  if ($('panels').dataset.signature !== signature) {
    $('panels').dataset.signature = signature;
    $('panels').replaceChildren(...ui.panels.map(panel => {
      const node = element('details'); node.append(element('summary', panel.title), element('pre', panel.text)); return node;
    }));
    $('module-actions').replaceChildren(...ui.actions.map(action => button(action.label, () => {
      // Actions prepare visible input; they never execute automatically.
      $('input').value = action.input; $('input').focus();
    })));
  }
  if (ui.error) notice(ui.error);
}
function paint(chat) {
  if (chat.id !== selected) return;
  conversation = chat;
  applyUI(chat.ui, Boolean(chat.live));
  $('title').textContent = chat.title;
  const rows = [...chat.messages];
  if (chat.live?.text) rows.push({ id: 'live', role: 'assistant', text: chat.live.text });
  const container = $('messages');
  if (!rows.length) {
    const empty = element('div', undefined, 'empty');
    empty.append(element('h2', 'A clear space to work.'), element('p', 'Ask a question, explore an idea, or start a task.'));
    container.replaceChildren(empty); nodes.clear();
  } else {
    if (container.querySelector('.empty')) container.replaceChildren();
    const keep = new Set();
    rows.forEach((row, index) => {
      keep.add(row.id);
      const signature = JSON.stringify(row);
      let entry = nodes.get(row.id);
      if (!entry || entry.signature !== signature) {
        const node = messageNode(row);
        if (entry?.node.isConnected) entry.node.replaceWith(node);
        entry = { signature, node }; nodes.set(row.id, entry);
      }
      if (container.children[index] !== entry.node) container.insertBefore(entry.node, container.children[index] ?? null);
    });
    for (const [id, entry] of nodes) if (!keep.has(id)) { entry.node.remove(); nodes.delete(id); }
  }
  const live = chat.live;
  const tools = live ? Object.entries(live.tools).filter(([, count]) => count).map(([name, count]) => `${name}${count > 1 ? ` ×${count}` : ''}`).join(', ') : '';
  $('activity').textContent = live ? `${live.awaitingDelivery ? 'Waiting for final delivery…' : tools ? `Tools: ${tools}` : live.text ? 'Receiving response…' : 'Waiting for agent output…'} · ${live.completed} tools completed${live.failed ? ` · ${live.failed} failed` : ''}${live.usage?.model ? ` · ${live.usage.model}` : ''}` : '';
  if (follow) requestAnimationFrame(() => { view.scrollTop = view.scrollHeight; });
}
async function select(id) {
  if (selected) drafts.set(selected, $('input').value);
  selected = id; conversation = undefined;
  if (pending.has(id)) drafts.set(id, pending.get(id).text);
  sessionStorage.setItem('hayate.webui.chat', id);
  chatEvents?.close();
  nodes.clear(); $('messages').replaceChildren(); $('activity').textContent = '';
  $('input').value = drafts.get(id) ?? '';
  follow = true; $('latest').hidden = true;
  renderList(); notice();
  chatEvents = new EventSource(`/api/events?chat=${encodeURIComponent(id)}`);
  chatEvents.onmessage = event => {
    const value = JSON.parse(event.data);
    if (value.type === 'live') {
      if (conversation && value.id === selected) paint({ ...conversation, live: value.live });
    } else if (value.type === 'presentation') {
      if (conversation && value.id === selected) { conversation.ui = value.ui; applyUI(value.ui, Boolean(conversation.live)); }
    } else paint(value);
  };
  chatEvents.onerror = () => { $('connection').textContent = 'Connection interrupted · reconnecting; sending remains retry-safe'; };
  chatEvents.onopen = () => { $('connection').textContent = 'Local connection · 127.0.0.1'; };
}
async function newChat() {
  const chat = await request('/api/chats', {});
  list.unshift(chat); await select(chat.id); $('input').focus();
}
async function send(text = $('input').value.trim(), fromEditor = true) {
  if (!text || sending) return;
  if (!selected) await newChat();
  const id = selected;
  let attempt = pending.get(id);
  if (attempt && attempt.text !== text) throw Error('The previous submission is unconfirmed. Retry that message first (its text is preserved in the editor).');
  attempt ??= { id: crypto.randomUUID(), text };
  pending.set(id, attempt);
  sessionStorage.setItem('hayate.webui.pending', JSON.stringify([...pending]));
  sending = true; $('send').disabled = true; notice();
  try {
    await request(`/api/chats/${id}/messages`, attempt);
    pending.delete(id);
    if (fromEditor) {
      drafts.delete(id);
      if (selected === id && $('input').value.trim() === text) $('input').value = '';
    }
  } catch (error) {
    if (!fromEditor && selected === id) $('input').value = text;
    // Keep the exact identity across reloads: ambiguous acceptance must not duplicate work.
    throw error;
  } finally {
    sending = false; $('send').disabled = false;
    sessionStorage.setItem('hayate.webui.pending', JSON.stringify([...pending]));
  }
}
$('new').onclick = guarded(newChat);
$('search').oninput = renderList;
$('composer').onsubmit = event => { event.preventDefault(); guarded(send)(); };
$('input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); guarded(send)(); }
});
$('stop').onclick = guarded(() => send('/stop', false));
$('help').onclick = guarded(() => send('/help', false));
view.addEventListener('scroll', () => {
  follow = view.scrollHeight - view.scrollTop - view.clientHeight < 60;
  $('latest').hidden = follow;
});
function latest() { follow = true; view.scrollTop = view.scrollHeight; $('latest').hidden = true; }
$('latest').onclick = latest;
document.addEventListener('keydown', event => { if (event.ctrlKey && event.key === 'End') { event.preventDefault(); latest(); } });
$('theme').onclick = () => {
  const dark = document.body.dataset.theme ? document.body.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.body.dataset.theme = dark ? 'light' : 'dark';
  localStorage.setItem('hayate.webui.theme', document.body.dataset.theme);
};
$('rename').onclick = () => {
  if (!conversation) return;
  $('rename-input').value = conversation.title; $('rename-dialog').showModal();
};
$('rename-dialog').addEventListener('close', guarded(async () => {
  if ($('rename-dialog').returnValue !== 'save' || !selected) return;
  await request(`/api/chats/${selected}/title`, { title: $('rename-input').value });
}));
$('export').onclick = () => {
  if (!conversation) return;
  const text = `# ${conversation.title}\n\n` + conversation.messages.map(m => `## ${m.role === 'user' ? 'User' : 'Hayate'}${m.outcome ? ` (${m.outcome})` : ''}\n\n${m.text}`).join('\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = element('a'); a.href = url; a.download = `hayate-${selected}.md`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener('beforeunload', () => { listEvents?.close(); chatEvents?.close(); });

async function init() {
  const theme = localStorage.getItem('hayate.webui.theme');
  if (['light', 'dark'].includes(theme)) document.body.dataset.theme = theme;
  try { for (const [id, attempt] of JSON.parse(sessionStorage.getItem('hayate.webui.pending') ?? '[]')) { pending.set(id, attempt); drafts.set(id, attempt.text); } } catch { /* Ignore damaged browser preferences. */ }
  const state = await request('/api/state'); list = state.chats;
  const previous = sessionStorage.getItem('hayate.webui.chat');
  if (list.length) await select(list.some(c => c.id === previous) ? previous : list[0].id);
  else await newChat();
  listEvents = new EventSource('/api/events');
  listEvents.onmessage = event => { const state = JSON.parse(event.data); if (state.chats) { list = state.chats; renderList(); } };
  listEvents.onerror = () => { $('connection').textContent = 'Connection interrupted · reconnecting'; };
}
guarded(init)();
