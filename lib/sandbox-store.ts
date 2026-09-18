type Listener = () => void;

const consoleUrls = new Map<string, string | null>();
const listeners = new Set<Listener>();

export function rememberSandbox(name: string, consoleUrl: string | null): void {
  if (name === "") return;
  if (consoleUrls.has(name) && consoleUrls.get(name) === consoleUrl) return;
  consoleUrls.set(name, consoleUrl);
  for (const listener of listeners) listener();
}

export function consoleUrlFor(name: string): string | null {
  return consoleUrls.get(name) ?? null;
}

export function subscribeSandboxes(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function forgetSandboxes(): void {
  consoleUrls.clear();
}
