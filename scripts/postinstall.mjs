// Trace best-effort de l'installation des dépendances du plugin. N'échoue JAMAIS l'install
// (exit 0 quoi qu'il arrive) et reste silencieux si Claude Code lance npm avec --ignore-scripts
// (auquel cas ce script n'est tout simplement pas exécuté ; le diagnostic de premier démarrage
// du serveur MCP prend alors le relais).
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
    `cwd=${process.cwd()} dist/server.js=${distOk ? 'présent' : 'absent'}\n`;
  appendFileSync(path.join(dir, 'memory.log'), line);
} catch {
  /* best-effort : ne jamais casser l'install */
}
process.exit(0);
