import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export const defaults = Object.freeze({ theme: 'system', workArea: 'auto', workAreaRows: 3,
  placeholder: 'Ask Hayate, or use /help…', title: 'Hayate', panels: [], actions: [] });
export function validateUI(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('UI settings must be an object');
  const allowed = new Set([...Object.keys(defaults), 'modules']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw Error(`Unknown UI setting: ${key}`);
  if (value.theme !== undefined && !['system', 'light', 'dark'].includes(value.theme)) throw Error('Invalid theme');
  if (value.workArea !== undefined && !['auto', 'always', 'hidden'].includes(value.workArea)) throw Error('Invalid workArea');
  if (value.workAreaRows !== undefined && (!Number.isInteger(value.workAreaRows) || value.workAreaRows < 1 || value.workAreaRows > 12)) throw Error('workAreaRows must be 1–12');
  for (const [key, max] of [['title', 120], ['placeholder', 500]]) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > max)) throw Error(`Invalid ${key}`);
  if (value.modules !== undefined && (!Array.isArray(value.modules) || value.modules.some(m => typeof m !== 'string' || !m))) throw Error('Invalid modules');
  if (value.panels !== undefined && (!Array.isArray(value.panels) || value.panels.length > 12 || value.panels.some(p => !p || typeof p.title !== 'string' || typeof p.text !== 'string' || p.title.length > 120 || p.text.length > 8000))) throw Error('Invalid panels');
  if (value.actions !== undefined && (!Array.isArray(value.actions) || value.actions.length > 16 || value.actions.some(a => !a || typeof a.label !== 'string' || typeof a.input !== 'string' || a.label.length > 80 || a.input.length > 8000))) throw Error('Invalid actions');
  return value;
}
export async function readUI(home) {
  try { return validateUI(JSON.parse(await readFile(path.join(home, 'webui', 'ui.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

/** Optional startup PluginModule: exposes an ordinary host tool, not a privileged HTTP backdoor. */
export async function activateSettingsTool(api) {
  let serial = Promise.resolve();
  let closing = false;
  api.registerTool({ name: 'plugin_webui_settings', description: 'Read or patch WebUI presentation according to operator instructions. Does not change model settings, permissions or install executable modules.',
    parameters: { type: 'object', properties: { patch: { type: 'object', description: 'Optional presentation settings: theme, workArea, workAreaRows, title, placeholder, panels [{title,text}], actions [{label,input}]. Omit to read.' } } },
    execute(input) {
      if (closing) return Promise.reject(Error('WebUI settings tool is stopping'));
      const work = serial.then(async () => {
        const current = await readUI(api.home);
        if (input.patch === undefined) return JSON.stringify({ ...defaults, ...current });
        if (!input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch) || Object.hasOwn(input.patch, 'modules')) throw Error('Executable modules require explicit operator installation and restart');
        const next = validateUI({ ...current, ...input.patch });
        const directory = path.join(api.home, 'webui');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, 'ui.json'); const temp = `${file}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 }); await rename(temp, file);
        return 'WebUI presentation saved. Connected browsers apply it automatically; model/context settings are unchanged.';
      });
      serial = work.catch(() => {}); return work;
    },
  });
  api.onStop(() => { closing = true; return serial; });
}

/** Explicitly installed trusted server-side modules. Browser output remains declarative. */
export async function loadModules(home, settings) {
  const panels = []; const actions = []; const cleanups = [];
  let stopping;
  const stop = () => {
    stopping ??= (async () => {
      const errors = [];
      for (const cleanup of cleanups.splice(0).reverse()) try { await cleanup(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'WebUI module cleanup failed');
    })();
    return stopping;
  };
  try {
    for (const location of settings.modules ?? []) {
      const module = (await import(pathToFileURL(path.resolve(home, location)).href)).default;
      if (module?.apiVersion !== 1 || typeof module.activate !== 'function') throw Error('Invalid WebUI module');
      if (module.updateAdmission !== 'foreground-owned') throw Error('WebUI modules must declare updateAdmission: foreground-owned and drain resources via onStop');
      let registering = true;
      try {
        await module.activate(Object.freeze({
          version: 1, home,
          onStop(cleanup) {
            if (!registering || typeof cleanup !== 'function') throw Error('Invalid cleanup');
            cleanups.push(cleanup);
          },
          registerPanel(panel) {
            if (!registering || typeof panel?.render !== 'function' || typeof panel.title !== 'string') throw Error('Invalid WebUI panel');
            panels.push({ title: panel.title, render: panel.render.bind(panel) });
          },
          registerAction(action) {
            if (!registering) throw Error('Registration closed');
            validateUI({ actions: [action] }); actions.push(structuredClone(action));
          },
        }));
      } finally { registering = false; }
    }
  } catch (error) {
    try { await stop(); } catch (cleanupError) { throw Object.assign(new AggregateError([error, cleanupError], 'WebUI module activation and cleanup failed'), { cleanupFailed: true }); }
    throw new Error(`WebUI module activation failed: ${error.message}`, { cause: error });
  }
  return {
    stop,
    project(context) {
      if (stopping) return { panels: [], actions: [] };
      const output = panels.map(panel => {
        try {
          const text = panel.render(Object.freeze(context));
          if (typeof text !== 'string') throw Error('Panel must return synchronous plain text');
          return { title: panel.title.slice(0, 120), text: text.slice(0, 8000) };
        } catch { return { title: panel.title.slice(0, 120), text: 'Panel unavailable' }; }
      });
      return { panels: output, actions };
    },
  };
}
