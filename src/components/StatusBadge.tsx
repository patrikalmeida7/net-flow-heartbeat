import { cn } from "@/lib/utils";

export type DeviceStatus = "online" | "warning" | "offline" | "unknown";

const labels: Record<DeviceStatus, string> = {
  online: "Online",
  warning: "Atenção",
  offline: "Offline",
  unknown: "Desconhecido",
};

const styles: Record<DeviceStatus, string> = {
  online: "bg-status-online/15 text-status-online border-status-online/30",
  warning: "bg-status-warning/15 text-status-warning border-status-warning/30",
  offline: "bg-status-offline/15 text-status-offline border-status-offline/40",
  unknown: "bg-status-unknown/15 text-status-unknown border-status-unknown/30",
};

export function StatusDot({ status, className }: { status: DeviceStatus; className?: string }) {
  const color =
    status === "online"
      ? "text-status-online"
      : status === "warning"
        ? "text-status-warning"
        : status === "offline"
          ? "text-status-offline"
          : "text-status-unknown";
  return (
    <span className={cn("relative inline-flex h-2.5 w-2.5", color, className)}>
      <span className={cn("absolute inset-0 rounded-full bg-current", status !== "offline" && "pulse-dot")} />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-current" />
    </span>
  );
}

export function StatusBadge({ status, className }: { status: DeviceStatus; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        styles[status],
        className,
      )}
    >
      <StatusDot status={status} />
      {labels[status]}
    </span>
  );
}
