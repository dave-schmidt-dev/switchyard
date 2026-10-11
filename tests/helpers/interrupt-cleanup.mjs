const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Runs `cleanup` synchronously when the process receives SIGINT, SIGTERM, or
 * SIGHUP, then re-raises the signal so the process still dies by it.
 *
 * `finally` blocks and `process.on("exit")` handlers do not run when the test
 * runner signals the test process, so work that must survive an interrupted
 * run (such as rolling back a live VM) needs a signal handler. A `cleanup`
 * that throws is ignored so the process still ends by the signal that arrived.
 * Delivery waits for the event loop: synchronous subprocess calls can delay
 * cleanup. SIGKILL cannot be handled, including escalation during that delay.
 *
 * @param {() => unknown} cleanup
 * @returns {() => void} idempotent disposer that removes the handlers without running `cleanup`
 */
export function runOnInterrupt(cleanup) {
	const handlers = new Map();
	let disposed = false;
	let cleaning = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		for (const [signal, handler] of handlers) {
			process.off(signal, handler);
		}
	};
	for (const signal of INTERRUPT_SIGNALS) {
		const handler = () => {
			if (cleaning) return;
			cleaning = true;
			try {
				cleanup();
			} catch {
				// The process must still die by the signal that arrived.
			} finally {
				dispose();
				process.kill(process.pid, signal);
			}
		};
		handlers.set(signal, handler);
		process.on(signal, handler);
	}
	return dispose;
}
