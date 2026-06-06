import { loadConfig, EMBED_TEXT_VERSION } from './config.js';
import { MemoryStore } from './store.js';
import { MemoryServer } from './memory-server.js';

// The MCP SDK communicates on stdout: we guard against console.log (transformers.js logs the
// model download via console → redirected to stderr so as not to corrupt the protocol).
console.log = (...args: unknown[]) => console.error('[stdout-redirected]', ...args);

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new MemoryStore(config.dbPath, config.embed.dim, config.embed.model, EMBED_TEXT_VERSION);
  await store.init();
  await new MemoryServer(config, store).start();
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
