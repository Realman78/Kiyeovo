import { useEffect, useMemo, useState } from "react";
import { Inbox, Info, X } from "lucide-react";
import type {
  DirectOfflineInboxCapacitySnapshot,
  GroupOfflineInboxCapacitySnapshot,
  OfflineInboxCapacitySnapshot,
} from "../../../core/types";
import { Tooltip } from "../ui/Tooltip";

type OfflineInboxCapacityProps = {
  chatId: number;
  expanded: boolean;
  onToggle: () => void;
};

const PANEL_WIDTH = "min(26rem, calc(100vw - 6rem))";

const clampRatio = (value: number) => Math.max(0, Math.min(1, value));

const getToneClasses = (ratio: number) => {
  if (ratio >= 0.9) {
    return {
      fill: "bg-destructive",
      text: "text-destructive",
      badge: "border-destructive/40 bg-destructive/10 text-destructive",
    };
  }
  if (ratio >= 0.65) {
    return {
      fill: "bg-amber-500",
      text: "text-amber-400",
      badge: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    };
  }
  return {
    fill: "bg-emerald-500",
    text: "text-emerald-400",
    badge: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  };
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KB`;
};

const DetailBar = ({
  label,
  caption,
  used,
  limit,
  ratio,
  valueLabel,
}: {
  label: string;
  caption: string;
  used: number;
  limit: number;
  ratio: number;
  valueLabel?: string;
}) => {
  const tone = getToneClasses(ratio);

  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium text-foreground">{label}</div>
          <div className="text-[10px] leading-4 text-muted-foreground">{caption}</div>
        </div>
        <div className="text-[10px] font-mono text-muted-foreground">{valueLabel ?? `${used} / ${limit}`}</div>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted/70">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${tone.fill}`}
          style={{ width: `${clampRatio(ratio) * 100}%` }}
        />
      </div>
    </div>
  );
};

const DirectDetails = ({ snapshot }: { snapshot: DirectOfflineInboxCapacitySnapshot }) => {
  return (
    <div className="w-80 space-y-3">
      <div className="text-[10px] leading-4 text-muted-foreground">
        41 total slots: 30 sendable, 10 reserved for group updates, 1 ACK
      </div>
      <DetailBar
        label="Sendable messages"
        caption={`${snapshot.regular.stored} delivered • ${snapshot.regular.pending} pending`}
        used={snapshot.regular.total}
        limit={snapshot.regular.limit}
        ratio={snapshot.regular.limit > 0 ? snapshot.regular.total / snapshot.regular.limit : 0}
      />
      <DetailBar
        label="Group updates"
        caption="Notifications for recipient-created groups"
        used={snapshot.control.total}
        limit={snapshot.control.limit}
        ratio={snapshot.control.limit > 0 ? snapshot.control.total / snapshot.control.limit : 0}
      />
      <DetailBar
        label="Inbox read notification"
        caption="Notification indicating that the user read the inbox"
        used={snapshot.ack.total}
        limit={snapshot.ack.limit}
        ratio={snapshot.ack.limit > 0 ? snapshot.ack.total / snapshot.ack.limit : 0}
      />
    </div>
  );
};

const GroupDetails = ({ snapshot }: { snapshot: GroupOfflineInboxCapacitySnapshot }) => {
  return (
    <div className="w-80 space-y-3">
      <div className="text-[10px] leading-4 text-muted-foreground">
        Your group messages backup for offline users
      </div>
      <DetailBar
        label={`Current epoch (v${snapshot.currentKeyVersion})`}
        caption="Message count usage for the active sender bucket"
        used={snapshot.mainUsed}
        limit={snapshot.mainLimit}
        ratio={snapshot.mainLimit > 0 ? snapshot.mainUsed / snapshot.mainLimit : 0}
      />
      <DetailBar
        label="Compressed store size"
        caption="The DHT record size limit for the active sender bucket"
        used={snapshot.mainCompressedBytesUsed}
        limit={snapshot.mainCompressedBytesLimit}
        ratio={snapshot.mainCompressedBytesLimit > 0 ? snapshot.mainCompressedBytesUsed / snapshot.mainCompressedBytesLimit : 0}
        valueLabel={`${formatBytes(snapshot.mainCompressedBytesUsed)} / ${formatBytes(snapshot.mainCompressedBytesLimit)}`}
      />
    </div>
  );
};

const DetailTooltip = ({ snapshot }: { snapshot: OfflineInboxCapacitySnapshot }) => {
  if (snapshot.kind === "direct") {
    return <DirectDetails snapshot={snapshot} />;
  }
  return <GroupDetails snapshot={snapshot} />;
};

export const OfflineInboxCapacity = ({
  chatId,
  expanded,
  onToggle,
}: OfflineInboxCapacityProps) => {
  const [snapshot, setSnapshot] = useState<OfflineInboxCapacitySnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const result = await window.kiyeovoAPI.getOfflineInboxCapacity(chatId);
        if (!cancelled) {
          setSnapshot(result.success ? result.snapshot : null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();

    const unsubscribe = window.kiyeovoAPI.onOfflineInboxCapacityChanged((event) => {
      if (event.chatId !== chatId) {
        return;
      }
      void load();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [chatId]);

  const presentation = useMemo(() => {
    if (!snapshot) {
      return {
        ratio: 0,
        used: 0,
        limit: 0,
        label: "Loading…",
      };
    }

    if (snapshot.kind === "direct") {
      return {
        ratio: snapshot.mainRatio,
        used: snapshot.mainUsed,
        limit: snapshot.mainLimit,
        label: "Inbox usage",
      };
    }

    return {
      ratio: snapshot.mainRatio,
      used: snapshot.mainUsed,
      limit: snapshot.mainLimit,
      label: `Current epoch (v${snapshot.currentKeyVersion})`,
    };
  }, [snapshot]);

  const tone = getToneClasses(presentation.ratio);

  return (
    <div className="px-2 pb-2">
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={onToggle}
          className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border bg-card text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${expanded ? tone.badge : "border-border/70"}`}
          aria-expanded={expanded}
          aria-label="Toggle offline inbox capacity"
          title="Offline inbox capacity"
        >
          <Inbox className="h-4 w-4" />
        </button>

        <div
          className={`overflow-visible transition-[width,opacity,transform] duration-300 ease-out ${expanded ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-2 pointer-events-none"}`}
          style={{ width: expanded ? PANEL_WIDTH : "0px" }}
        >
          <div
            className={`origin-left rounded-2xl border border-border/70 bg-card/95 p-3 shadow-sm transition-transform duration-300 ease-out ${expanded ? "scale-x-100" : "scale-x-0"}`}
            style={{ width: PANEL_WIDTH }}
          >
            <div className="flex justify-between w-[99%]">
              <div className="flex items-center gap-2">
                <div className="text-[11px] font-mono uppercase tracking-wide text-foreground">
                  Offline inbox capacity
                </div>
                <Tooltip
                  content="Inbox is cleared when the recipient reads them"
                  contentClassName="w-56"
                  align="left"
                >
                  <button
                    type="button"
                    className="inline-flex items-center justify-center rounded-full p-0.5 text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    aria-label="Offline inbox capacity help"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              </div>
              <button
                type="button"
                onClick={onToggle}
                className="inline-flex items-center justify-center rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label="Close offline inbox capacity"
                title="Close"
              >
                <X className="h-3 w-3" />
              </button>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 flex items-center justify-between gap-3 text-[11px]">
                  <span className="truncate text-muted-foreground">{presentation.label}</span>
                  <span className={`shrink-0 font-mono ${tone.text}`}>
                    {loading ? "…" : `${presentation.used} / ${presentation.limit}`}
                  </span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-muted/70">
                  <div
                    className={`h-full rounded-full transition-[width] duration-300 ${tone.fill} ${loading ? "animate-pulse" : ""}`}
                    style={{ width: `${clampRatio(presentation.ratio) * 100}%` }}
                  />
                </div>
              </div>

              <Tooltip
                content={snapshot ? <DetailTooltip snapshot={snapshot} /> : "No offline inbox data yet."}
                contentClassName="w-auto max-w-none"
                align="right"
              >
                <button
                  type="button"
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/80 text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  aria-label="Offline inbox details"
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
