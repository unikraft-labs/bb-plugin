import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  PluginMachineProviderInputsProps,
  PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk";
import type {
  BastionStatus,
  rpcContract,
  SandboxView,
  SettingsView,
} from "./server";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FloatingInput } from "@/components/ui/floating-input";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { decorateTree } from "@/lib/machine-line";
import {
  serviceLinks,
  type SandboxServiceLink,
} from "@/lib/sandbox-services";
import {
  parseSandboxOptions,
  submissionFor,
  type SandboxOptionDrafts,
} from "@/lib/sandbox-options";
import {
  nextInterval,
  SANDBOX_POLL_MS,
  type PollOutcome,
} from "@/lib/sandbox-poll";
import {
  consoleUrlFor,
  rememberSandbox,
  subscribeSandboxes,
} from "@/lib/sandbox-store";
import { cn } from "@/lib/utils";

const MACHINE_PROVIDER_ID = "unikraft-cloud-sandbox";

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description === undefined ? null : (
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      )}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function StatusLine({ status }: { status: BastionStatus | null }) {
  if (status === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  const dot = status.ready && status.tunnelConnected
    ? "bg-emerald-500"
    : status.configured
      ? "bg-amber-500"
      : "bg-muted-foreground";
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn("size-2 rounded-full", dot)} aria-hidden />
        <span className="text-foreground">
          {status.bastionUrl === "" ? "No bastion" : status.bastionUrl}
        </span>
        <span className="text-muted-foreground">
          {status.ready ? "ready" : "not ready"} ·{" "}
          {status.tunnelConnected ? "tunnel connected" : "tunnel disconnected"}
        </span>
      </div>
      {status.counts === null ? null : (
        <p className="text-xs text-muted-foreground">
          {status.counts.total} sandboxes · {status.counts.running} running ·{" "}
          {status.counts.standby} in standby
          {status.template === null
            ? ""
            : ` · template ${status.template.state}`}
        </p>
      )}
      {status.message === null ? null : (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {status.message}
        </p>
      )}
      {status.error === null ? null : (
        <p className="text-xs text-destructive">{status.error}</p>
      )}
    </div>
  );
}

function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onCancel())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SandboxTable({
  sandboxes,
  error,
}: {
  sandboxes: SandboxView[] | null;
  error: string | null;
}) {
  if (error !== null) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (sandboxes === null) {
    return <p className="text-sm text-muted-foreground">Loading sandboxes…</p>;
  }
  if (sandboxes.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        No sandboxes yet. Start a thread on Unikraft Cloud to make one.
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Sandbox</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Size</TableHead>
          <TableHead>Exposed</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sandboxes.map((sandbox) => (
          <TableRow key={sandbox.id}>
            <TableCell className="font-mono text-xs">{sandbox.name}</TableCell>
            <TableCell>{sandbox.state}</TableCell>
            <TableCell>
              {sandbox.vcpus} vCPU · {sandbox.memoryMb} MiB
            </TableCell>
            <TableCell>
              {sandbox.services.length === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <div className="flex flex-col">
                  {sandbox.services.map((service) => (
                    <a
                      key={service.port}
                      href={service.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-xs underline underline-offset-2"
                    >
                      {service.port}
                    </a>
                  ))}
                </div>
              )}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {new Date(sandbox.createdAt).toLocaleString()}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function UnikraftCloudSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<BastionStatus | null>(null);
  const [sandboxes, setSandboxes] = useState<SandboxView[] | null>(null);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"stop" | "delete" | null>(null);
  const mounted = useRef(true);

  const refreshStatus = useCallback(() => {
    rpc.call("bastion.status").then(setStatus, (cause) => {
      setError(message(cause));
    });
  }, [rpc]);

  const refreshSandboxes = useCallback(() => {
    rpc.call("sandboxes.list").then(
      (result) => {
        setSandboxes(result.sandboxes);
        setSandboxError(null);
      },
      (cause) => {
        setSandboxes([]);
        setSandboxError(message(cause));
      },
    );
  }, [rpc]);

  useEffect(() => {
    mounted.current = true;
    refreshStatus();
    refreshSandboxes();
    const timer = setInterval(() => {
      refreshSandboxes();
      refreshStatus();
    }, SANDBOX_POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [rpc, refreshStatus, refreshSandboxes]);

  useRealtime("bastion-changed", () => {
    refreshStatus();
    refreshSandboxes();
  });

  const run = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await action();
      refreshStatus();
      refreshSandboxes();
    } catch (cause) {
      setError(message(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <Section
        title="Bastion"
        description="The service on Unikraft Cloud that owns every sandbox."
      >
        <StatusLine status={status} />
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => run("start", () => rpc.call("bastion.start"))}
            disabled={busy !== null}
          >
            <Icon name="Play" className="size-4" />
            Start bastion
          </Button>
          <Button
            variant="outline"
            onClick={() => setConfirm("stop")}
            disabled={busy !== null}
          >
            Stop bastion
          </Button>
          <Button
            variant="outline"
            onClick={() => run("warm", () => rpc.call("template.warm", {}))}
            disabled={busy !== null}
          >
            Warm template
          </Button>
          <Button
            variant="destructive"
            onClick={() => setConfirm("delete")}
            disabled={busy !== null}
          >
            <Icon name="Trash2" className="size-4" />
            Delete all sandboxes
          </Button>
        </div>
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </Section>

      <Section title="Running sandboxes">
        <SandboxTable sandboxes={sandboxes} error={sandboxError} />
      </Section>

      <ConfirmDialog
        open={confirm === "stop"}
        title="Stop the bastion?"
        description="The bastion instance is deleted. Sandboxes stay in standby and threads cannot reach them until it is started again."
        confirmLabel="Stop bastion"
        pending={busy !== null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          void run("stop", () => rpc.call("bastion.stop"));
        }}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        title="Delete every sandbox?"
        description="Every sandbox and its filesystem is deleted. Threads running on them lose their machine."
        confirmLabel="Delete all"
        pending={busy !== null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          void run("delete", () => rpc.call("sandboxes.deleteAll"));
        }}
      />
    </div>
  );
}

function SandboxOptions({ value, onChange }: PluginMachineProviderInputsProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [options, setOptions] = useState(() => parseSandboxOptions(value));
  const [defaults, setDefaults] = useState<SettingsView | null>(null);

  useEffect(() => {
    let live = true;
    rpc.call("settings.read").then(
      (view) => {
        if (live) setDefaults(view);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [rpc]);

  const edit = (next: SandboxOptionDrafts) => {
    setOptions(next);
    onChange(submissionFor(next));
  };

  const set = (key: "vcpus" | "memoryMb" | "image", next: string) => {
    edit({ ...options, [key]: next });
  };

  const setPort = (index: number, next: string) => {
    edit({
      ...options,
      ports: options.ports.map((port, at) => (at === index ? next : port)),
    });
  };

  const addPort = () => edit({ ...options, ports: [...options.ports, ""] });

  const removePort = (index: number) => {
    edit({ ...options, ports: options.ports.filter((_, at) => at !== index) });
  };

  const exposed = options.ports.filter((port) => port.trim() !== "").length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative size-8"
          aria-label="Sandbox options"
        >
          <Icon name="Settings" className="size-4" />
          {exposed === 0 ? null : (
            <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-foreground text-[10px] leading-none text-background">
              {exposed}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3">
        <FloatingInput
          label="Image"
          className="h-8"
          placeholder={defaults?.sandboxImage ?? ""}
          value={options.image}
          onChange={(event) => set("image", event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Another image skips the warm template, so the sandbox takes longer to
          start.
        </p>
        <div className="flex items-center gap-2">
          <FloatingInput
            label="vCPU"
            containerClassName="w-20"
            className="h-8"
            type="number"
            min={1}
            max={16}
            placeholder={
              defaults === null ? "" : String(defaults.sandboxVcpus)
            }
            value={options.vcpus}
            onChange={(event) => set("vcpus", event.target.value)}
          />
          <FloatingInput
            label="Memory (MiB)"
            containerClassName="w-32"
            className="h-8"
            type="number"
            min={256}
            max={65536}
            placeholder={
              defaults === null ? "" : String(defaults.sandboxMemoryMb)
            }
            value={options.memoryMb}
            onChange={(event) => set("memoryMb", event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">
              Exposed ports
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Expose another port"
              onClick={addPort}
            >
              <Icon name="Plus" className="size-4" />
            </Button>
          </div>
          {options.ports.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              The sandbox is reachable from the Internet on every port you add,
              at an address it gets when it starts.
            </p>
          ) : (
            options.ports.map((port, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  className="h-8 w-24"
                  type="number"
                  min={1}
                  max={65535}
                  placeholder="8080"
                  aria-label={`Port ${index + 1}`}
                  value={port}
                  onChange={(event) => setPort(index, event.target.value)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`Remove port ${index + 1}`}
                  onClick={() => removePort(index)}
                >
                  <Icon name="X" className="size-4" />
                </Button>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const SANDBOX_STATE_DOT: Record<string, string> = {
  running: "bg-emerald-500",
  standby: "bg-indigo-500",
  stopped: "bg-muted-foreground",
  creating: "bg-amber-500",
  deleting: "bg-amber-500",
};

function useSandbox(threadId: string | null): {
  sandbox: SandboxView | null;
  consoleUrl: string | null;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [sandbox, setSandbox] = useState<SandboxView | null>(null);
  const [consoleUrl, setConsoleUrl] = useState<string | null>(null);
  const [pulse, setPulse] = useState(0);

  useRealtime("bastion-changed", () => setPulse((count) => count + 1));

  useEffect(() => {
    if (threadId === null) {
      setSandbox(null);
      setConsoleUrl(null);
      return;
    }
    let live = true;
    let interval = SANDBOX_POLL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (outcome: PollOutcome) => {
      if (!live) return;
      interval = nextInterval(interval, outcome);
      timer = setTimeout(poll, interval);
    };
    const poll = () => {
      rpc.call("sandboxes.get", { threadId }).then(
        (result) => {
          if (!live) return;
          setSandbox(result.sandbox);
          setConsoleUrl(result.consoleUrl);
          if (result.sandbox !== null) {
            rememberSandbox(result.sandbox.name, result.consoleUrl);
          }
          schedule(result.sandbox === null ? "missing" : "found");
        },
        () => {
          if (!live) return;
          setSandbox(null);
          setConsoleUrl(null);
          schedule("failed");
        },
      );
    };
    poll();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [rpc, threadId, pulse]);

  return { sandbox, consoleUrl };
}

function SandboxServiceMenu({ links }: { links: SandboxServiceLink[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${links.length} exposed ${links.length === 1 ? "service" : "services"}`}
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"
        >
          <Icon name="Plug02" className="size-3" />
          {links.length}
          <Icon name="ChevronDown" className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-0">
        {links.map((link) => (
          <DropdownMenuItem key={link.port} asChild>
            <a
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs"
            >
              {link.label}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SandboxStatePill({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const { sandbox } = useSandbox(threadId);

  if (sandbox === null) return null;
  const links = serviceLinks(sandbox.fqdn, sandbox.services);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        role="status"
        aria-label={`Unikraft Cloud sandbox ${sandbox.state}`}
        title={`${sandbox.name} · ${sandbox.state}`}
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            SANDBOX_STATE_DOT[sandbox.state] ?? "bg-muted-foreground",
          )}
          aria-hidden
        />
        {isCompactViewport ? null : sandbox.state}
      </span>
      {links.length === 0 ? null : <SandboxServiceMenu links={links} />}
    </span>
  );
}

function decorateMachineLines(root: Node): void {
  try {
    decorateTree(root, consoleUrlFor);
  } catch {
    return;
  }
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "unikraft-cloud",
    title: "Unikraft Cloud",
    description:
      "Run threads in Unikraft Cloud sandboxes that scale to zero between turns.",
    component: UnikraftCloudSettings,
  });
  app.contentScripts.register({
    id: "sandbox-console-link",
    mount(context) {
      decorateMachineLines(document.body);
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "characterData") {
            decorateMachineLines(record.target);
            continue;
          }
          for (const node of Array.from(record.addedNodes)) {
            decorateMachineLines(node);
          }
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      const unsubscribe = subscribeSandboxes(() => {
        decorateMachineLines(document.body);
      });
      const stop = () => {
        observer.disconnect();
        unsubscribe();
      };
      context.signal.addEventListener("abort", stop, { once: true });
      return stop;
    },
  });
  app.slots.experimental_machineProviderInputs({
    machineProviderId: MACHINE_PROVIDER_ID,
    component: SandboxOptions,
  });
  app.slots.experimental_threadHeaderAction({
    id: "sandbox-state",
    title: "Unikraft Cloud sandbox",
    component: SandboxStatePill,
  });
});
