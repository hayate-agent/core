/** Scheduling metadata only: never task authority, permissions or replay consent.
 * Machine API, delegated work, cron, reviews and memory remain background by
 * default. A human-facing gateway gets the reserved local-model response lane.
 */
export function modelWorkClass(key: string, ephemeral = false, requested?: 'interactive' | 'background'): 'interactive' | 'background' {
  if (ephemeral || /^(?:dispatch|subagent|cron):/.test(key) || key.startsWith('api:cron-')) return 'background';
  if (requested) return requested;
  if (key.startsWith('api:')) return 'background';
  return /^(?:matrix|webui|telegram|slack|discord|signal|tui):/.test(key) ||
    key === 'console:local' || key.startsWith('local-') ? 'interactive' : 'background';
}
export function localModelWorkHeaders(headers: Record<string, string | null>, key: string,
  local: boolean, ephemeral = false, requested?: 'interactive' | 'background'): void {
  if (!local) return;
  // Explicit background on a maintenance/compaction request always wins over
  // the surrounding interactive session. Header names are case-insensitive.
  const names = Object.keys(headers).filter(name => name.toLowerCase() === 'x-hayate-model-work');
  const background = names.some(name => headers[name] === 'background');
  for (const name of Object.keys(headers)) {
    if (names.includes(name) || name.toLowerCase().startsWith('x-hayate-qos-')) delete headers[name];
  }
  headers['X-Hayate-Model-Work'] = background ? 'background' : modelWorkClass(key, ephemeral, requested);
}
