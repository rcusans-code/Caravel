// Tick watchdog (Raven D-01). The RPC client times out each request
// (RPC_TIMEOUT_MS, chain.ts), but a tick makes several calls in a row, so a
// hung RPC could still keep one tick waiting for minutes while the process
// looks alive to systemd. The watchdog fires when no RPC call has answered
// for `ms` during a tick: the keeper ALERTs and exits 1, systemd restarts it
// (Restart=always) and a crash loop past the start limit fires OnFailure.
// Every RPC answer (chain.ts `onRpcAnswer`) pushes the deadline back, so a
// slow but working tick (many sends in a row) is never killed.

export class Watchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ms: number,
    private readonly onFire: () => void,
  ) {}

  /** Start (or restart) the countdown. */
  arm() {
    this.clear();
    this.timer = setTimeout(this.onFire, this.ms);
    // Never keep the process alive on its own (--once exits normally).
    this.timer.unref?.();
  }

  /** An RPC call answered: restart the countdown if armed. */
  kick() {
    if (this.timer) this.arm();
  }

  /** Tick ended: stop the countdown (the sleep between ticks is not watched). */
  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get armed() {
    return this.timer !== null;
  }
}
