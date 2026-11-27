/** Serial polling with an explicit wake-up and disposal boundary. */
export function watchChanges(options: {
  load: (signal: AbortSignal) => Promise<{ revision: string }>;
  active: () => boolean;
  changed: () => void;
  failed: (error: unknown) => void;
  recovered: () => void;
  intervalMs?: number;
}) {
  let stopped = false;
  let running = false;
  let revision: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  async function check() {
    if (stopped || running) return;
    clearTimeout(timer);
    if (!options.active()) { timer = setTimeout(check, options.intervalMs ?? 5000); return; }
    running = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 15000);
    try {
      const next = await options.load(controller.signal);
      if (stopped) return;
      options.recovered();
      // Also refresh on first contact: a write may have landed between the page's
      // initial fetch and this baseline snapshot.
      if (next.revision !== revision) {
        options.changed();
        revision = next.revision;
      }
    } catch (error) {
      if (!stopped) { revision = undefined; options.failed(error); }
    } finally {
      clearTimeout(timeout);
      running = false;
      if (!stopped) timer = setTimeout(check, options.intervalMs ?? 5000);
    }
  }
  void check();
  return {
    wake: () => { void check(); },
    invalidate: () => { revision = undefined; },
    stop: () => { stopped = true; clearTimeout(timer); controller?.abort(); },
  };
}
