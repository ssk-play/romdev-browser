// The headless service's queue (src/server.ts): one job at a time, at most `max` waiting or running. A full queue
// refuses at once (Busy), and a job whose caller left before its turn is skipped (Gone), its slot freed as soon as the
// caller leaves, so abandoned requests never pile up ahead of new ones. Jobs run synchronously in the server, so each
// turn first yields once to let pending hang-ups arrive.
export class Busy extends Error {}
export class Gone extends Error {}

export class JobQueue {
  max: number;
  depth = 0;
  started = 0;
  skipped = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(max: number) { this.max = Math.max(1, Math.floor(max) || 1); }

  add<T>(f: () => Promise<T>, left: AbortSignal): Promise<T> {
    if (this.depth >= this.max) return Promise.reject(new Busy(`busy: ${this.depth} jobs queued`));
    this.depth++;
    let state: "waiting" | "running" | "gone" = "waiting";
    const leave = () => { if (state === "waiting") { state = "gone"; this.depth--; } };
    if (left.aborted) leave(); else left.addEventListener("abort", leave, { once: true });
    const job = async () => {
      await new Promise((ok) => setImmediate(ok));
      left.removeEventListener("abort", leave);
      if (state === "gone") { this.skipped++; throw new Gone(); }
      state = "running";
      this.started = Date.now();
      try { return await f(); } finally { this.started = 0; this.depth--; }
    };
    const p = this.tail.then(job, job);
    this.tail = p.catch(() => {});
    return p;
  }

  status() { return { queued: this.depth, runningMs: this.started && Date.now() - this.started, skipped: this.skipped }; }
}
