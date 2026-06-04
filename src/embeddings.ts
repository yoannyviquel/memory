import { log, writeStatus } from './log.js';

export interface EmbedConfig {
  enabled: boolean;
  model: string;
  dim: number;
  cacheDir: string;
  /** Précision ONNX : 'q8' (quantifié, défaut, ~4× plus léger) ou 'fp32' (pleine précision). */
  dtype: string;
  /** Racine des données (logs + status.json), pour journaliser le chargement du modèle. */
  dataDir: string;
}

/** Construit le texte à plonger pour un document (champs porteurs de sens). */
export function embedText(parts: Array<string | undefined>, max = 2000): string {
  return parts
    .filter((p): p is string => !!p && p.trim().length > 0)
    .join('\n')
    .slice(0, max);
}

// Singleton de pipeline transformers.js (chargé une fois par process).
let _pipe: any = null;
let _loading: Promise<any> | null = null;
let _failed = false;

async function getPipe(cfg: EmbedConfig): Promise<any | null> {
  if (!cfg.enabled) return null;
  if (_pipe) return _pipe;
  if (_failed) return null;
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      // Specifier en variable : laisse l'import résoluble au runtime depuis node_modules.
      const mod = '@huggingface/transformers';
      const tf: any = await import(mod);
      tf.env.cacheDir = cfg.cacheDir;
      tf.env.allowRemoteModels = true;

      const dtype = cfg.dtype || 'q8';
      log(cfg.dataDir, `[embed] chargement ${cfg.model} (dtype=${dtype}) cache=${cfg.cacheDir}`);
      writeStatus(cfg.dataDir, { state: 'loading', model: cfg.model, progress: undefined, file: undefined });

      // Progression de téléchargement HuggingFace → logs + status.json (throttlé par décile).
      const lastPct: Record<string, number> = {};
      const progress_callback = (p: any) => {
        try {
          if (p?.status === 'progress' && p.file && typeof p.progress === 'number') {
            const pct = Math.round(p.progress);
            const bucket = Math.floor(pct / 10);
            if (lastPct[p.file] !== bucket) {
              lastPct[p.file] = bucket;
              log(cfg.dataDir, `[embed] download ${p.file} ${pct}%`);
            }
            writeStatus(cfg.dataDir, { state: 'downloading', model: cfg.model, file: p.file, progress: pct });
          } else if (p?.status === 'done' && p.file) {
            log(cfg.dataDir, `[embed] téléchargé ${p.file}`);
          } else if (p?.status === 'ready') {
            log(cfg.dataDir, `[embed] modèle prêt (${cfg.model})`);
          }
        } catch {
          /* best-effort */
        }
      };

      let pipe: any;
      try {
        pipe = await tf.pipeline('feature-extraction', cfg.model, { dtype, progress_callback });
      } catch (e) {
        // Le palier n'expose pas forcément la variante quantifiée → repli pleine précision.
        log(
          cfg.dataDir,
          `[embed] dtype=${dtype} indisponible (${e instanceof Error ? e.message : String(e)}); repli fp32`,
        );
        pipe = await tf.pipeline('feature-extraction', cfg.model, { dtype: 'fp32', progress_callback });
      }
      _pipe = pipe;
      writeStatus(cfg.dataDir, { state: 'idle', progress: undefined, file: undefined });
      return pipe;
    } catch (err) {
      _failed = true;
      const message = err instanceof Error ? err.message : String(err);
      log(cfg.dataDir, `[embed] indisponible: ${message}`);
      writeStatus(cfg.dataDir, { state: 'idle', progress: undefined, file: undefined });
      process.stderr.write(`[memory] embedder indisponible: ${message}\n`);
      return null;
    } finally {
      _loading = null;
    }
  })();
  return _loading;
}

/** True si le modèle est chargeable (déclenche le chargement). */
export async function embedReady(cfg: EmbedConfig): Promise<boolean> {
  return !!(await getPipe(cfg));
}

export async function embed(text: string, cfg: EmbedConfig): Promise<number[] | null> {
  const r = await embedBatch([text], cfg);
  return r[0] ?? null;
}

/** Embeddings en lot (mean pooling + normalisation L2). null par entrée en cas d'échec. */
export async function embedBatch(
  texts: string[],
  cfg: EmbedConfig,
): Promise<Array<number[] | null>> {
  if (!cfg.enabled || texts.length === 0) return texts.map(() => null);
  const pipe = await getPipe(cfg);
  if (!pipe) return texts.map(() => null);
  try {
    const out = await pipe(texts, { pooling: 'mean', normalize: true });
    const arr: number[][] = out.tolist();
    return texts.map((_, i) => (Array.isArray(arr[i]) && arr[i].length > 0 ? arr[i] : null));
  } catch {
    return texts.map(() => null);
  }
}
