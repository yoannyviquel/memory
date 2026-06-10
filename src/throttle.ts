/** Resolves after `ms` (unref'd so a pending timer never keeps the process alive). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Duty-cycle throttle for background work (vectorization, digests). Given how long a unit of work
 * just took and the target load percentage — the share of wall-time the background loops may keep
 * the inference device (CPU **or** GPU) busy — returns how long to idle before the next unit:
 *
 *   pause = workMs · (100 / loadPercent − 1)
 *
 * So 100% → 0 (drain at full speed), 50% → idle ≈ work time (~half the device's time), 25% → idle ≈
 * 3× work time (~a quarter). Unlike a thread-count cap (CPU-only, caps *peak*), this caps the
 * *average* load and is device-agnostic — a GPU runs the whole model regardless of CPU threads, so
 * only pacing can throttle it. Capped so one slow unit can't stall the loop for minutes.
 */
export function throttlePause(workMs: number, loadPercent: number, capMs = 30_000): number {
  if (!Number.isFinite(loadPercent) || loadPercent >= 100 || loadPercent <= 0 || workMs <= 0) return 0;
  return Math.min(capMs, Math.round(workMs * (100 / loadPercent - 1)));
}
