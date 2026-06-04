// Copies the loadable sqlite-vec library into dist/ so it's available even without node_modules
// (case of a plugin shipped without reinstall). Best-effort: doesn't fail the build if absent.
import { createRequire } from 'node:module';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';

try {
  const req = createRequire(import.meta.url);
  const src = req('sqlite-vec').getLoadablePath();
  if (existsSync(src)) {
    const dest = path.join('dist', path.basename(src));
    copyFileSync(src, dest);
    console.log(`[postbuild] sqlite-vec copied → ${dest}`);
  } else {
    console.warn('[postbuild] sqlite-vec library not found, copy skipped');
  }
} catch (err) {
  console.warn('[postbuild] sqlite-vec not resolved, copy skipped:', err?.message ?? err);
}
