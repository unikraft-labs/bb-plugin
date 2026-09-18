import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginMachineProviderInputsProps } from "@get-bb/plugin-sdk";
import type {
  BastionStatus,
  rpcContract,
  SandboxView,
  SettingsView,
  SettingsWrite,
} from "./server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const SANDBOX_POLL_MS = 5_000;
const MACHINE_PROVIDER_ID = "unikraft-cloud-sandbox";

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {children}
      {hint === undefined ? null : (
        <span className="text-xs text-muted-foreground">{hint}</span>
      )}
    </label>
  );
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
            <TableCell className="text-muted-foreground">
              {new Date(sandbox.createdAt).toLocaleString()}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type Drafts = Record<string, string>;

function draftsFrom(view: SettingsView): Drafts {
  return {
    ukcMetro: view.ukcMetro,
    bastionUrl: view.bastionUrl,
    bastionImage: view.bastionImage,
    bastionVcpus: String(view.bastionVcpus),
    bastionMemoryMb: String(view.bastionMemoryMb),
    sandboxImage: view.sandboxImage,
    sandboxRom: view.sandboxRom,
    sandboxVcpus: String(view.sandboxVcpus),
    sandboxMemoryMb: String(view.sandboxMemoryMb),
    sandboxExtraEnv: view.sandboxExtraEnv,
    sandboxCooldownMs: String(view.sandboxCooldownMs),
    sandboxTtl: view.sandboxTtl,
    listenPort: String(view.listenPort),
    ukcToken: "",
    bastionToken: "",
  };
}

function UnikraftCloudSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<BastionStatus | null>(null);
  const [view, setView] = useState<SettingsView | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [mode, setMode] = useState("managed");
  const [templateEnabled, setTemplateEnabled] = useState(true);
  const [sandboxes, setSandboxes] = useState<SandboxView[] | null>(null);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"stop" | "delete" | null>(null);
  const mounted = useRef(true);

  const applyView = useCallback((next: SettingsView) => {
    setView(next);
    setDrafts(draftsFrom(next));
    setMode(next.mode);
    setTemplateEnabled(next.templateEnabled);
  }, []);

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
    rpc.call("settings.read").then(applyView, (cause) => setError(message(cause)));
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
  }, [rpc, applyView, refreshStatus, refreshSandboxes]);

  useRealtime("bastion-changed", () => {
    refreshStatus();
    refreshSandboxes();
  });

  const set = (key: string, value: string) => {
    setDrafts((current) => ({ ...current, [key]: value }));
  };

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

  const number = (key: string, fallback: number): number => {
    const parsed = Number(drafts[key]);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const save = () =>
    run("save", async () => {
      if (view === null) return;
      const payload: SettingsWrite = {
        mode: mode === "external" ? "external" : "managed",
        ukcMetro: drafts.ukcMetro ?? "",
        bastionUrl: drafts.bastionUrl ?? "",
        bastionImage: drafts.bastionImage ?? "",
        bastionVcpus: number("bastionVcpus", view.bastionVcpus),
        bastionMemoryMb: number("bastionMemoryMb", view.bastionMemoryMb),
        sandboxImage: drafts.sandboxImage ?? "",
        sandboxRom: drafts.sandboxRom ?? "",
        sandboxVcpus: number("sandboxVcpus", view.sandboxVcpus),
        sandboxMemoryMb: number("sandboxMemoryMb", view.sandboxMemoryMb),
        sandboxExtraEnv: drafts.sandboxExtraEnv ?? "{}",
        sandboxCooldownMs: number("sandboxCooldownMs", view.sandboxCooldownMs),
        sandboxTtl: drafts.sandboxTtl ?? "",
        templateEnabled,
        listenPort: number("listenPort", view.listenPort),
        ukcToken: drafts.ukcToken ?? "",
        bastionToken: drafts.bastionToken ?? "",
      };
      applyView(await rpc.call("settings.write", payload));
    });

  const clearSecret = (key: "ukcToken" | "bastionToken") =>
    run(key, async () => {
      applyView(await rpc.call("settings.write", { [key]: null }));
    });

  const secretState = (has: boolean) =>
    has ? "Stored. Type a new value to replace it." : "Not set.";

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

      <Section title="Credentials">
        <Field label="Mode" hint="Managed creates the bastion for you.">
          <Select value={mode} onValueChange={setMode}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="managed">Managed</SelectItem>
              <SelectItem value="external">External</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Unikraft Cloud token"
          hint={secretState(view?.hasUkcToken ?? false)}
        >
          <div className="flex gap-2">
            <Input
              type="password"
              value={drafts.ukcToken ?? ""}
              placeholder="Replace the stored value"
              onChange={(event) => set("ukcToken", event.target.value)}
            />
            <Button
              variant="outline"
              onClick={() => clearSecret("ukcToken")}
              disabled={busy !== null}
            >
              Clear
            </Button>
          </div>
        </Field>
        <Field label="Metro" hint="For example fra.">
          <Input
            value={drafts.ukcMetro ?? ""}
            onChange={(event) => set("ukcMetro", event.target.value)}
          />
        </Field>
        <Field
          label="Bastion URL"
          hint="Managed mode fills this in when the bastion starts."
        >
          <Input
            value={drafts.bastionUrl ?? ""}
            onChange={(event) => set("bastionUrl", event.target.value)}
          />
        </Field>
        <Field
          label="Bastion token"
          hint={secretState(view?.hasBastionToken ?? false)}
        >
          <div className="flex gap-2">
            <Input
              type="password"
              value={drafts.bastionToken ?? ""}
              placeholder="Replace the stored value"
              onChange={(event) => set("bastionToken", event.target.value)}
            />
            <Button
              variant="outline"
              onClick={() => clearSecret("bastionToken")}
              disabled={busy !== null}
            >
              Clear
            </Button>
          </div>
        </Field>
      </Section>

      <Section title="Sandboxes">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Base image" hint="The image must contain git.">
            <Input
              value={drafts.sandboxImage ?? ""}
              onChange={(event) => set("sandboxImage", event.target.value)}
            />
          </Field>
          <Field label="ROM" hint="Empty selects the ROM for this bb version.">
            <Input
              value={drafts.sandboxRom ?? ""}
              onChange={(event) => set("sandboxRom", event.target.value)}
            />
          </Field>
          <Field label="vCPUs">
            <Input
              type="number"
              min={1}
              value={drafts.sandboxVcpus ?? ""}
              onChange={(event) => set("sandboxVcpus", event.target.value)}
            />
          </Field>
          <Field label="Memory (MiB)">
            <Input
              type="number"
              min={256}
              value={drafts.sandboxMemoryMb ?? ""}
              onChange={(event) => set("sandboxMemoryMb", event.target.value)}
            />
          </Field>
          <Field label="Scale-to-zero cooldown (ms)">
            <Input
              type="number"
              min={0}
              value={drafts.sandboxCooldownMs ?? ""}
              onChange={(event) => set("sandboxCooldownMs", event.target.value)}
            />
          </Field>
          <Field label="Lifetime" hint="A Go duration, such as 168h.">
            <Input
              value={drafts.sandboxTtl ?? ""}
              onChange={(event) => set("sandboxTtl", event.target.value)}
            />
          </Field>
          <Field label="Listen port">
            <Input
              type="number"
              min={1}
              max={65535}
              value={drafts.listenPort ?? ""}
              onChange={(event) => set("listenPort", event.target.value)}
            />
          </Field>
          <Field label="Bastion image">
            <Input
              value={drafts.bastionImage ?? ""}
              onChange={(event) => set("bastionImage", event.target.value)}
            />
          </Field>
          <Field label="Bastion vCPUs">
            <Input
              type="number"
              min={1}
              value={drafts.bastionVcpus ?? ""}
              onChange={(event) => set("bastionVcpus", event.target.value)}
            />
          </Field>
          <Field label="Bastion memory (MiB)">
            <Input
              type="number"
              min={128}
              value={drafts.bastionMemoryMb ?? ""}
              onChange={(event) => set("bastionMemoryMb", event.target.value)}
            />
          </Field>
        </div>
        <Field
          label="Sandbox environment"
          hint="A JSON object added to every sandbox."
        >
          <textarea
            className="min-h-24 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground"
            value={drafts.sandboxExtraEnv ?? ""}
            onChange={(event) => set("sandboxExtraEnv", event.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <Checkbox
            checked={templateEnabled}
            onCheckedChange={(checked) => setTemplateEnabled(checked === true)}
          />
          Warm a sandbox template
        </label>
        <div>
          <Button onClick={save} disabled={busy !== null || view === null}>
            Save settings
          </Button>
        </div>
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

function parseSize(value: unknown): { vcpus: string; memoryMb: string } {
  if (typeof value !== "object" || value === null) {
    return { vcpus: "", memoryMb: "" };
  }
  const record = value as Record<string, unknown>;
  return {
    vcpus: typeof record.vcpus === "number" ? String(record.vcpus) : "",
    memoryMb: typeof record.memoryMb === "number" ? String(record.memoryMb) : "",
  };
}

function SandboxSizeInputs({ value, onChange }: PluginMachineProviderInputsProps) {
  const initial = parseSize(value);
  const [vcpus, setVcpus] = useState(initial.vcpus);
  const [memoryMb, setMemoryMb] = useState(initial.memoryMb);

  const submit = (nextVcpus: string, nextMemory: string) => {
    const size: Record<string, number> = {};
    if (nextVcpus.trim() !== "") {
      const parsed = Number(nextVcpus);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16) {
        onChange({ status: "blocked", reason: "vCPUs must be 1 to 16." });
        return;
      }
      size.vcpus = parsed;
    }
    if (nextMemory.trim() !== "") {
      const parsed = Number(nextMemory);
      if (!Number.isInteger(parsed) || parsed < 256 || parsed > 65_536) {
        onChange({
          status: "blocked",
          reason: "Memory must be 256 to 65536 MiB.",
        });
        return;
      }
      size.memoryMb = parsed;
    }
    onChange({ status: "ready", value: Object.keys(size).length === 0 ? null : size });
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        className="h-8 w-20"
        type="number"
        min={1}
        max={16}
        placeholder="vCPU"
        aria-label="vCPUs for this sandbox"
        value={vcpus}
        onChange={(event) => {
          setVcpus(event.target.value);
          submit(event.target.value, memoryMb);
        }}
      />
      <Input
        className="h-8 w-28"
        type="number"
        min={256}
        max={65536}
        placeholder="MiB"
        aria-label="Memory for this sandbox"
        value={memoryMb}
        onChange={(event) => {
          setMemoryMb(event.target.value);
          submit(vcpus, event.target.value);
        }}
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "unikraft-cloud",
    title: "Unikraft Cloud",
    description:
      "Run threads in Unikraft Cloud sandboxes that scale to zero between turns.",
    component: UnikraftCloudSettings,
  });
  app.slots.experimental_machineProviderInputs({
    machineProviderId: MACHINE_PROVIDER_ID,
    component: SandboxSizeInputs,
  });
});
