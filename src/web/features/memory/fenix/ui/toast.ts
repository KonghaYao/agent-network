/**
 * Local shim for the `sonner` toast API used by the vendored memory UI.
 *
 * The vendor phase does not add `sonner`; failures surface through a DOM event that
 * a later phase can host. No message text is persisted or logged.
 */

export type FenixToastDetail = { type: 'error' | 'success'; message: string };

export const toast = {
  error(message: string): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<FenixToastDetail>('fenix-memory-toast', { detail: { type: 'error', message } }));
  },
  success(message: string): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<FenixToastDetail>('fenix-memory-toast', { detail: { type: 'success', message } }));
  },
};
