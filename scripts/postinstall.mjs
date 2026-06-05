// Best-effort trace of the plugin's dependency installation. NEVER fails the install
// (exit 0 no matter what) and stays silent if Claude Code runs npm with --ignore-scripts
// (which it does — so this script usually does NOT run at plugin install; the process rename
// and other first-run setup are done by the MCP server at startup instead, see src/server.ts).
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

try {
  const dataDir = process.env.MEMORY_DATA_DIR || path.join(os.homedir(), '.claude-memory');
  const dir = path.join(dataDir, 'logs');
  mkdirSync(dir, { recursive: true });
  const distOk = existsSync(path.join(process.cwd(), 'dist', 'server.js'));
  const line =
    `${new Date().toISOString()} pid=${process.pid} ` +
    `[postinstall] node ${process.version} ${process.platform}/${process.arch} ` +
    `cwd=${process.cwd()} dist/server.js=${distOk ? 'present' : 'absent'}\n`;
  appendFileSync(path.join(dir, 'memory.log'), line);
} catch {
  /* best-effort: never break the install */
}
process.exit(0);
