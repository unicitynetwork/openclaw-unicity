/** Small dependency-free helpers shared by every module (leaf: no imports). */

/** Message of an Error, else String(err); never throws (a null-prototype or hostile object yields "unknown error"). */
export function errorMessage(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return "unknown error";
  }
}

/** Races `p` against an unref'd timer; rejects with Error(`${label} timed out after ${ms}ms`) when the timer wins. */
export function withTimeout<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
