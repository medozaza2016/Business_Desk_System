/* Ambient types for the third-party globals the desk touches.

   Cloudflare Turnstile is injected at runtime as `window.turnstile` (the gate
   loads its script lazily), so there is no package to import types from. Only
   the three calls the passcode gate makes are described here. */

interface TurnstileApi {
  /** Mounts a widget inside `target` and returns its widget id. */
  render(target: HTMLElement, options: Record<string, unknown>): string;
  /** Detaches a widget so it can be mounted again. */
  remove(widgetId: string): void;
  /** Re-runs the challenge on an existing widget after a failed sign-in. */
  reset(widgetId: string): void;
}

interface Window {
  turnstile?: TurnstileApi;
}
