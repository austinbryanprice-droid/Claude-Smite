/**
 * Length of the vector (x, z). Use it instead of Math.hypot in anything that
 * runs every frame: V8 doesn't inline Math.hypot, so each call is a builtin
 * call that boxes its result on the heap (about 18x slower, and garbage).
 */
export function hypot(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}
