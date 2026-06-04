import { readFileSync } from 'node:fs';

export interface ParsedTurn {
  userPrompt: string;
  assistantText: string;
  tools: string[];
  filesRead: string[];
  filesModified: string[];
  hasContent: boolean;
}

const MODIFY_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'NotebookRead']);

function fileFromInput(input: any): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  return input.file_path || input.notebook_path || input.path || undefined;
}

/** Extrait le chemin de fichier d'un bloc tool_use vers le bon bucket. */
function classifyTool(
  name: string,
  input: any,
  filesRead: Set<string>,
  filesModified: Set<string>,
): void {
  const file = fileFromInput(input);
  if (!file) return;
  if (MODIFY_TOOLS.has(name)) filesModified.add(file);
  else if (READ_TOOLS.has(name)) filesRead.add(file);
}

/**
 * Lit les nouvelles lignes du transcript JSONL depuis `fromLine` et agrège le dernier tour
 * (prompt utilisateur, texte assistant, outils, fichiers). Tolérant aux lignes malformées.
 */
export function readNewTurn(
  transcriptPath: string,
  fromLine: number,
): { turn: ParsedTurn; totalLines: number } {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return { turn: emptyTurn(), totalLines: fromLine };
  }
  const allLines = raw.split('\n').filter((l) => l.trim().length > 0);
  const totalLines = allLines.length;
  const newLines = allLines.slice(fromLine);

  const tools = new Set<string>();
  const filesRead = new Set<string>();
  const filesModified = new Set<string>();
  const assistantParts: string[] = [];
  let userPrompt = '';

  for (const line of newLines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = entry?.message;
    const role = msg?.role ?? entry?.type;
    const content = msg?.content;

    if (role === 'user') {
      // Le prompt user "réel" est une string ou un bloc texte (pas un tool_result).
      if (typeof content === 'string') {
        userPrompt = content;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            userPrompt = block.text;
          }
        }
      }
    } else if (role === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          assistantParts.push(block.text);
        } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
          tools.add(block.name);
          classifyTool(block.name, block.input, filesRead, filesModified);
        }
      }
    }
  }

  const assistantText = assistantParts.join('\n\n').trim();
  const turn: ParsedTurn = {
    userPrompt: userPrompt.trim(),
    assistantText,
    tools: [...tools],
    filesRead: [...filesRead],
    filesModified: [...filesModified],
    hasContent: assistantText.length > 0 || tools.size > 0,
  };
  return { turn, totalLines };
}

function emptyTurn(): ParsedTurn {
  return {
    userPrompt: '',
    assistantText: '',
    tools: [],
    filesRead: [],
    filesModified: [],
    hasContent: false,
  };
}
