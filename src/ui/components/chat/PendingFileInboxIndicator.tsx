import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, FileWarning, Loader2, Trash2, X, XCircle } from "lucide-react";
import type {
  PendingFileInboxOffer,
  PendingFileInboxSenderSummary,
  PendingFileInboxSnapshot,
} from "../../../core/types";
import { setPendingFileStatus, updateFileTransferStatus } from "../../state/slices/chatSlice";
import { useDispatch } from "react-redux";
import { Button } from "../ui/Button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/Dialog";
import { Tooltip } from "../ui/Tooltip";
import { useToast } from "../ui/use-toast";

type PendingFileInboxIndicatorProps = {
  chatId: number;
  chatType: 'direct' | 'group';
  peerId?: string;
  attention: boolean;
  expanded: boolean;
  onToggle: () => void;
  onClearAttention: () => void;
};

const PANEL_WIDTH = "min(27rem, calc(100vw - 6rem))";

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
};

const formatAge = (timestamp: number) => {
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const getOldestOfferAge = (offers: PendingFileInboxOffer[]) => {
  if (offers.length === 0) return null;
  const oldest = Math.min(...offers.map((offer) => offer.offeredAt));
  return formatAge(oldest);
};

const CapacityBar = ({
  count,
  limit,
  label,
}: {
  count: number;
  limit: number;
  label: string;
}) => {
  const ratio = limit > 0 ? Math.min(1, count / limit) : 0;
  const full = count >= limit;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className={`font-mono ${full ? "text-destructive" : "text-amber-300"}`}>
          {count} / {limit}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted/70">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${full ? "bg-destructive" : "bg-amber-500"}`}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
};

const OfferRow = ({
  offer,
  busyKey,
  onAccept,
  onReject,
}: {
  offer: PendingFileInboxOffer;
  busyKey: string | null;
  onAccept: (offer: PendingFileInboxOffer) => void;
  onReject: (offer: PendingFileInboxOffer) => void;
}) => {
  const accepting = busyKey === `accept:${offer.fileId}`;
  const rejecting = busyKey === `reject:${offer.fileId}`;
  const disabled = busyKey !== null;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-background/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground">{offer.filename}</div>
        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span>{formatBytes(offer.size)}</span>
          <span>•</span>
          <span>{offer.chatName}</span>
          <span>•</span>
          <span>{formatAge(offer.offeredAt)}</span>
          {!offer.countsTowardCapacity && offer.transferError && (
            <>
              <span>•</span>
              <span className="text-amber-300">{offer.transferError}</span>
            </>
          )}
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onAccept(offer)}
        disabled={disabled}
      >
        {accepting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        Accept
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => onReject(offer)}
        disabled={disabled}
      >
        {rejecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
        Reject
      </Button>
    </div>
  );
};

export const PendingFileInboxIndicator = ({
  chatId,
  chatType,
  peerId,
  attention,
  expanded,
  onToggle,
  onClearAttention,
}: PendingFileInboxIndicatorProps) => {
  const dispatch = useDispatch();
  const { toast } = useToast();
  const [snapshot, setSnapshot] = useState<PendingFileInboxSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [manageOpen, setManageOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [groupMemberPeerIds, setGroupMemberPeerIds] = useState<Set<string>>(new Set());
  const lastSyncedChatIds = useRef<Set<number>>(new Set());

  const syncPendingFlags = useCallback((nextSnapshot: PendingFileInboxSnapshot) => {
    const nextChatIds = new Set(nextSnapshot.offers.map((offer) => offer.chatId));
    const touchedChatIds = new Set([...lastSyncedChatIds.current, ...nextChatIds]);
    for (const pendingChatId of touchedChatIds) {
      dispatch(setPendingFileStatus({
        chatId: pendingChatId,
        hasPendingFile: nextChatIds.has(pendingChatId),
      }));
    }
    lastSyncedChatIds.current = nextChatIds;
  }, [dispatch]);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.kiyeovoAPI.getPendingFileInbox();
      if (result.success && result.snapshot) {
        setSnapshot(result.snapshot);
        syncPendingFlags(result.snapshot);
      } else {
        setSnapshot(null);
      }
    } catch (error) {
      console.error("[PendingFileInboxIndicator] Failed to load pending files:", error);
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, [syncPendingFlags]);

  useEffect(() => {
    void loadSnapshot();
  }, [chatId, loadSnapshot]);

  useEffect(() => {
    let cancelled = false;

    const loadGroupMembers = async () => {
      if (chatType !== "group") {
        setGroupMemberPeerIds(new Set());
        return;
      }
      try {
        const result = await window.kiyeovoAPI.getGroupMembers(chatId);
        if (cancelled) return;
        setGroupMemberPeerIds(new Set(
          result.success
            ? result.members
              .filter((member) => member.status !== "pending")
              .map((member) => member.peerId)
            : [],
        ));
      } catch (error) {
        console.error("[PendingFileInboxIndicator] Failed to load group members:", error);
        if (!cancelled) {
          setGroupMemberPeerIds(new Set());
        }
      }
    };

    void loadGroupMembers();
    return () => {
      cancelled = true;
    };
  }, [chatId, chatType]);

  useEffect(() => {
    if (attention || expanded || manageOpen) {
      void loadSnapshot();
    }
  }, [attention, expanded, manageOpen, loadSnapshot]);

  const directChatFullSender = useMemo(
    () => chatType === "direct" && peerId
      ? snapshot?.senders.find((sender) => sender.full && sender.senderPeerId === peerId) ?? null
      : null,
    [chatType, peerId, snapshot],
  );
  const groupMemberFullSender = useMemo(
    () => chatType === "group"
      ? snapshot?.senders.find((sender) => sender.full && groupMemberPeerIds.has(sender.senderPeerId)) ?? null
      : null,
    [chatType, groupMemberPeerIds, snapshot],
  );
  const isRelevant = attention || !!snapshot?.full || !!directChatFullSender || !!groupMemberFullSender;
  const visible = isRelevant || expanded || manageOpen;
  const fullSender = directChatFullSender ?? groupMemberFullSender ?? (snapshot?.full
    ? snapshot.senders.find((sender) => sender.full) ?? null
    : null);
  const oldestAge = snapshot ? getOldestOfferAge(snapshot.offers) : null;

  useEffect(() => {
    if (!loading && expanded && !manageOpen && !isRelevant && snapshot) {
      onToggle();
    }
  }, [expanded, isRelevant, loading, manageOpen, onToggle, snapshot]);

  const handleToggle = () => {
    if (!expanded) {
      void loadSnapshot();
    }
    if (attention) {
      onClearAttention();
    }
    onToggle();
  };

  const refreshAfterAction = async () => {
    await loadSnapshot();
  };

  const acceptOffer = async (offer: PendingFileInboxOffer) => {
    setBusyKey(`accept:${offer.fileId}`);
    try {
      const result = await window.kiyeovoAPI.acceptFile(offer.fileId);
      if (!result.success) {
        toast.error(result.error || "Failed to accept file");
        return;
      }
      dispatch(updateFileTransferStatus({
        messageId: offer.fileId,
        status: "in_progress",
      }));
      await refreshAfterAction();
    } finally {
      setBusyKey(null);
    }
  };

  const rejectOffer = async (offer: PendingFileInboxOffer) => {
    setBusyKey(`reject:${offer.fileId}`);
    try {
      const result = await window.kiyeovoAPI.rejectFile(offer.fileId);
      if (!result.success) {
        toast.error(result.error || "Failed to reject file");
        return;
      }
      dispatch(updateFileTransferStatus({
        messageId: offer.fileId,
        status: "rejected",
        transferError: "Offer rejected",
      }));
      await refreshAfterAction();
    } finally {
      setBusyKey(null);
    }
  };

  const rejectSenderOffers = async (sender: PendingFileInboxSenderSummary, actionKey: string) => {
    setBusyKey(actionKey);
    try {
      for (const offer of sender.offers) {
        const result = await window.kiyeovoAPI.rejectFile(offer.fileId);
        if (!result.success) {
          toast.error(result.error || `Failed to reject ${offer.filename}`);
          return;
        }
        dispatch(updateFileTransferStatus({
          messageId: offer.fileId,
          status: "rejected",
          transferError: "Offer rejected",
        }));
      }
      toast.info(`Rejected ${sender.offers.length} file offer${sender.offers.length === 1 ? "" : "s"} from ${sender.senderUsername}`);
      await refreshAfterAction();
    } finally {
      setBusyKey(null);
    }
  };

  if (!visible) {
    return null;
  }

  return (
    <div className="px-2 pb-2">
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={handleToggle}
          className={`relative inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-xl border bg-card text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${expanded || attention ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-border/70"}`}
          aria-expanded={expanded}
          aria-label="Toggle pending files"
          title="Pending files"
        >
          <FileWarning className="h-4 w-4" />
          {attention && (
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-destructive ring-2 ring-background" />
          )}
        </button>

        <div
          className={`overflow-visible transition-[width,opacity,transform] duration-300 ease-out ${expanded ? "translate-x-0 opacity-100" : "pointer-events-none -translate-x-2 opacity-0"}`}
          style={{ width: expanded ? PANEL_WIDTH : "0px" }}
        >
          <div
            className={`origin-left rounded-2xl border border-destructive/35 bg-card/95 p-3 shadow-sm transition-transform duration-300 ease-out ${expanded ? "scale-x-100" : "scale-x-0"}`}
            style={{ width: PANEL_WIDTH }}
          >
            <div className="flex justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wide text-foreground">
                  Pending files
                  <Tooltip
                    content="Pending file offers consume local slots across direct and group chats until accepted or rejected."
                    contentClassName="w-56"
                    align="left"
                  >
                    <span className="inline-flex text-muted-foreground">
                      <AlertTriangle className="h-3.5 w-3.5" />
                    </span>
                  </Tooltip>
                </div>
                <div className="mt-1 text-[10px] leading-4 text-muted-foreground">
                  Pending file slots are shared across direct and group chats. Clear older offers, then check missed messages to recover skipped group file offers.
                </div>
              </div>
              <button
                type="button"
                onClick={handleToggle}
                className="inline-flex items-center justify-center rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label="Close pending files"
                title="Close"
              >
                <X className="h-3 w-3" />
              </button>
            </div>

            <div className="mt-3 space-y-3">
              <CapacityBar
                label="Total pending"
                count={snapshot?.total ?? 0}
                limit={snapshot?.totalLimit ?? 0}
              />
              {fullSender && (
                <CapacityBar
                  label={`${fullSender.senderUsername} across all chats`}
                  count={fullSender.count}
                  limit={fullSender.limit}
                />
              )}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 text-[10px] leading-4 text-muted-foreground">
                  {loading
                    ? "Checking pending files…"
                    : oldestAge
                      ? `Oldest pending offer: ${oldestAge}`
                      : "No pending file offers."}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (attention) {
                      onClearAttention();
                    }
                    setManageOpen(true);
                  }}
                  disabled={loading}
                >
                  Manage
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Manage pending files</DialogTitle>
            <DialogDescription>
              Accept files you want to download, or reject old offers to free pending-file slots.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="max-h-[65vh] overflow-y-auto">
            {loading && !snapshot ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading pending files…
              </div>
            ) : !snapshot || snapshot.offers.length === 0 ? (
              <div className="rounded-lg border border-border/60 bg-background/60 px-4 py-6 text-center text-sm text-muted-foreground">
                No pending file offers.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
                  Capacity: {snapshot.total} / {snapshot.totalLimit} total
                  {snapshot.hasFullSender && " • at least one sender is full"}
                </div>
                {snapshot.senders.map((sender, senderIndex) => {
                  const rejectAllActionKey = `reject-sender:${sender.senderPeerId}:${senderIndex}`;
                  return (
                    <div key={`${sender.senderPeerId}:${senderIndex}`} className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-foreground">
                            {sender.senderUsername}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {sender.count} / {sender.limit} slots used
                            {sender.full && <span className="ml-2 text-destructive">full</span>}
                          </div>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            void rejectSenderOffers(sender, rejectAllActionKey);
                          }}
                          disabled={busyKey !== null || sender.offers.length === 0}
                        >
                          {busyKey === rejectAllActionKey
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Trash2 className="h-4 w-4" />}
                          Reject all
                        </Button>
                      </div>
                      <div className="space-y-2">
                        {sender.offers.map((offer) => (
                          <OfferRow
                            key={offer.fileId}
                            offer={offer}
                            busyKey={busyKey}
                            onAccept={(nextOffer) => {
                              void acceptOffer(nextOffer);
                            }}
                            onReject={(nextOffer) => {
                              void rejectOffer(nextOffer);
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void loadSnapshot();
              }}
              disabled={busyKey !== null}
            >
              Refresh
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setManageOpen(false)}
              disabled={busyKey !== null}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
