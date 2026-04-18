import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

interface MetricCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: "default" | "online" | "warning" | "offline" | "primary";
  className?: string;
}

const toneStyles: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  default: "",
  online: "before:bg-gradient-to-br before:from-status-online/15 before:to-transparent",
  warning: "before:bg-gradient-to-br before:from-status-warning/15 before:to-transparent",
  offline: "before:bg-gradient-to-br before:from-status-offline/20 before:to-transparent",
  primary: "before:bg-gradient-to-br before:from-primary/15 before:to-transparent",
};

const valueTone: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  default: "text-foreground",
  online: "text-status-online",
  warning: "text-status-warning",
  offline: "text-status-offline",
  primary: "text-primary",
};

export function MetricCard({ label, value, hint, icon, tone = "default", className }: MetricCardProps) {
  return (
    <Card
      className={cn(
        "relative overflow-hidden bg-gradient-card shadow-card",
        "before:absolute before:inset-0 before:pointer-events-none",
        toneStyles[tone],
        className,
      )}
    >
      <div className="relative p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
            <div className={cn("font-mono text-3xl font-semibold tabular-nums", valueTone[tone])}>{value}</div>
          </div>
          {icon && <div className="rounded-lg bg-secondary/60 p-2 text-muted-foreground">{icon}</div>}
        </div>
        {hint && <div className="mt-3 text-xs text-muted-foreground">{hint}</div>}
      </div>
    </Card>
  );
}
