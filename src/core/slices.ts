/**
 * Building a map takes seconds on a slow laptop, and it runs behind the title
 * screen while its music plays and the player picks a god. Long loading work
 * calls `slice()` between steps: once the current slice has run for
 * `SLICE_MS`, it hands the browser a turn to paint, take clicks and keep the
 * music going, instead of freezing the page until the map is done.
 */
const SLICE_MS = 20;
let sliceStart = performance.now();

export async function slice(): Promise<void> {
  if (performance.now() - sliceStart < SLICE_MS) return;
  await nextTask();
  sliceStart = performance.now();
}

/** Resolves in a new task: `scheduler.yield` where offered (it resumes ahead of other queued work), else a posted message. */
function nextTask(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}
