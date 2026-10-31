import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Versioned independently of queue depth. Missing legacy evidence is not a reset. */
export interface RepetitionBudget {
  version: 1;
  repetitions: number;
  attempts: number;
  evidence: string[];
}
export function repetitions(task: { depth: number; repetition?: RepetitionBudget }): number {
  const budget = task.repetition;
  if (!budget) return task.depth;
  if (budget.version !== 1 || !Number.isSafeInteger(budget.repetitions) || budget.repetitions < 0 ||
      !Number.isSafeInteger(budget.attempts) || budget.attempts < 0 || !Array.isArray(budget.evidence) ||
      budget.evidence.length > 256 || budget.evidence.some(value => typeof value !== 'string')) return 20;
  return budget.repetitions;
}
export function accountRepetition(task: { depth: number; repetition?: RepetitionBudget }, before?: string, after?: string,
  assessed?: { fingerprint: string; advanced: boolean }): void {
  const prior = repetitions(task);
  if (prior >= 20) return; // malformed or exhausted persisted state cannot self-reopen
  const budget = task.repetition ??= { version: 1, repetitions: task.depth, attempts: 0, evidence: [] };
  const needed = (before && !budget.evidence.includes(before) ? 1 : 0) +
    (after && after !== before && !budget.evidence.includes(after) ? 1 : 0);
  const novel = !!before && !!after && before !== after && !budget.evidence.includes(after) &&
    budget.evidence.length + needed <= 256;
  const milestone = assessed?.advanced && typeof assessed.fingerprint === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9 ._:/-]{0,199}$/.test(assessed.fingerprint)
    ? `assessment:${createHash('sha256').update(assessed.fingerprint).digest('hex')}` : undefined;
  const semanticNovel = !!milestone && !budget.evidence.includes(milestone) && budget.evidence.length + needed < 256;
  if (before && !budget.evidence.includes(before) && budget.evidence.length < 256) budget.evidence.push(before);
  if (novel) budget.evidence.push(after!);
  if (semanticNovel) budget.evidence.push(milestone!);
  budget.attempts++;
  budget.repetitions = novel || semanticNovel ? 0 : budget.repetitions + 1;
}

/** Host reads tracked working-tree bytes, never tool arguments, prose or result text.
 * Fail closed outside Git. Untracked files and metadata-only commits are not evidence.
 */
export async function workingTreeEvidence(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)('git', ['ls-files', '-z', '--cached'], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (!stdout) return;
    const hash = createHash('sha256');
    for (const file of [...new Set(stdout.split('\0').filter(Boolean))].sort()) {
      hash.update(JSON.stringify(file));
      try { const bytes = await readFile(path.join(cwd, file)); hash.update(String(bytes.length)); hash.update(bytes); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; hash.update('deleted'); }
    }
    return hash.digest('hex');
  } catch { return; }
}
