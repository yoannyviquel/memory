import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Nom de projet = basename du répertoire de travail. */
export function projectFromCwd(cwd?: string): string {
  if (!cwd) return 'unknown';
  const base = path.basename(cwd.replace(/[\\/]+$/, ''));
  return base || 'unknown';
}

/** Branche git lue depuis .git/HEAD (sans spawn de process). */
export function gitBranch(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  try {
    const head = readFileSync(path.join(cwd, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/ref:\s*refs\/heads\/(.+)$/);
    if (m) return m[1];
    return head.slice(0, 12); // detached HEAD : début du SHA
  } catch {
    return undefined;
  }
}

/** Résumé court : 1re phrase ou ~200 premiers caractères. */
export function summarize(text: string, max = 200): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const dot = clean.indexOf('. ');
  const firstSentence = dot > 0 && dot < max ? clean.slice(0, dot + 1) : '';
  if (firstSentence) return firstSentence;
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

const MODIFY_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'NotebookRead']);

export interface ToolFiles {
  filesRead: string[];
  filesModified: string[];
}

/** Extrait les fichiers lus/modifiés d'un tool_input PostToolUse. */
export function filesFromToolInput(toolName: string, input: any): ToolFiles {
  const out: ToolFiles = { filesRead: [], filesModified: [] };
  const file = input?.file_path || input?.notebook_path || input?.path;
  if (file) {
    if (MODIFY_TOOLS.has(toolName)) out.filesModified.push(file);
    else if (READ_TOOLS.has(toolName)) out.filesRead.push(file);
  }
  return out;
}

/** Brief lisible d'un appel d'outil (commande Bash, motif de recherche, params tronqués). */
export function toolBrief(toolName: string, input: any): string {
  if (!input || typeof input !== 'object') return toolName;
  if (typeof input.command === 'string') return input.command.slice(0, 300);
  if (typeof input.pattern === 'string') {
    const where = input.path || input.glob || '';
    return `${input.pattern}${where ? ' @ ' + where : ''}`.slice(0, 300);
  }
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.notebook_path === 'string') return input.notebook_path;
  if (typeof input.url === 'string') return input.url;
  if (typeof input.description === 'string') return input.description.slice(0, 300);
  try {
    return JSON.stringify(input).slice(0, 300);
  } catch {
    return toolName;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Déduplique en préservant l'ordre. */
export function uniq(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}
