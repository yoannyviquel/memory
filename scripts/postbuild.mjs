// Copie la lib chargeable sqlite-vec dans dist/ pour qu'elle soit dispo même sans node_modules
// (cas d'un plugin shippé sans réinstall). Best-effort : n'échoue pas le build si absente.
import { createRequire } from 'node:module';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';

try {
  const req = createRequire(import.meta.url);
  const src = req('sqlite-vec').getLoadablePath();
  if (existsSync(src)) {
    const dest = path.join('dist', path.basename(src));
    copyFileSync(src, dest);
    console.log(`[postbuild] sqlite-vec copié → ${dest}`);
  } else {
    console.warn('[postbuild] lib sqlite-vec introuvable, copie ignorée');
  }
} catch (err) {
  console.warn('[postbuild] sqlite-vec non résolu, copie ignorée:', err?.message ?? err);
}
