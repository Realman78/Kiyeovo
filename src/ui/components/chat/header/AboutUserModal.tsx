import { type FC, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from "../../ui/Dialog";
import { Button } from "../../ui/Button";
import { Copy, Check, User, MessageSquare, Shield, BadgeInfo, CircleUser } from "lucide-react";

type UserInfo = {
  username: string;
  peerId: string;
  userSince: Date;
  chatCreated?: Date;
  trustedOutOfBand: boolean;
  messageCount: number;
  muted: boolean;
  blocked: boolean;
  blockedAt?: Date;
  blockReason?: string | null;
};

type AboutUserModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  peerId: string;
  chatId: number;
};

export const AboutUserModal: FC<AboutUserModalProps> = ({
  open,
  onOpenChange,
  peerId,
  chatId,
}) => {
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    if (open && peerId && chatId) {
      loadUserInfo();
    }
  }, [open, peerId, chatId]);

  const loadUserInfo = async () => {
    setLoading(true);
    try {
      const result = await window.kiyeovoAPI.getUserInfo(peerId, chatId);
      if (result.success && result.userInfo) {
        setUserInfo(result.userInfo);
      }
    } catch (error) {
      console.error("Failed to load user info:", error);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  const copyAllInfo = async () => {
    if (!userInfo) return;

    const allInfo = `
Username: ${userInfo.username}
Peer ID: ${userInfo.peerId}
User Since: ${new Date(userInfo.userSince).toLocaleString()}
Chat Created: ${userInfo.chatCreated ? new Date(userInfo.chatCreated).toLocaleString() : "N/A"}
Connection Type: ${userInfo.trustedOutOfBand ? "Out-of-band profile import" : "DHT key exchange"}
Message Count: ${userInfo.messageCount}
Muted: ${userInfo.muted ? "Yes" : "No"}
Blocked: ${userInfo.blocked ? "Yes" : "No"}${userInfo.blocked && userInfo.blockedAt
        ? `\nBlocked At: ${new Date(userInfo.blockedAt).toLocaleString()}`
        : ""
      }${userInfo.blocked && userInfo.blockReason
        ? `\nBlock Reason: ${userInfo.blockReason}`
        : ""
      }
    `.trim();

    await copyToClipboard(allInfo, "all");
  };

  const formatDate = (date: Date | undefined) => {
    if (!date) return "N/A";
    return new Date(date).toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  if (loading || !userInfo) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>About User</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex items-center justify-center py-8">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </DialogBody>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-156!">
        <DialogHeader>
          <DialogTitle>About {userInfo.username}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {/* Basic Information */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <CircleUser className="w-4 h-4 text-primary" />
              User Information
            </h3>
            <div className="flex items-center gap-2 text-sm m-0">
              <User className="w-4 h-4 text-primary" />
              <span className="text-muted-foreground min-w-[100px]">Username:</span>
              <span className="font-mono font-medium flex-1">{userInfo.username}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => copyToClipboard(userInfo.username, "username")}
              >
                {copiedField === "username" ? (
                  <Check className="w-3 h-3 text-green-500" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
              </Button>
            </div>

            <div className="flex items-center gap-2 text-sm">
              <Shield className="w-4 h-4 text-primary" />
              <span className="text-muted-foreground min-w-[100px]">Peer ID:</span>
              <span className="font-mono text-xs flex-1 truncate">{userInfo.peerId}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => copyToClipboard(userInfo.peerId, "peerId")}
              >
                {copiedField === "peerId" ? (
                  <Check className="w-3 h-3 text-green-500" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
              </Button>
            </div>
          </div>

          {/* Chat Information */}
          <div className="border-t border-border pt-4 space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-primary" />
              Chat Information
            </h3>
            <div className="space-y-2 pl-6">
              <div className="flex items-center text-sm">
                <span className="text-muted-foreground min-w-[140px]">Chat Created:</span>
                <span className="font-mono text-xs">{formatDate(userInfo.chatCreated)}</span>
              </div>
              <div className="flex items-center text-sm">
                <span className="text-muted-foreground min-w-[140px]">Connection Type:</span>
                <span className="text-xs">
                  {userInfo.trustedOutOfBand
                    ? "Out-of-band profile import"
                    : "DHT key exchange"}
                </span>
              </div>
              <div className="flex items-center text-sm">
                <span className="text-muted-foreground min-w-[140px]">Message Count:</span>
                <span className="font-mono">{userInfo.messageCount}</span>
              </div>
            </div>
          </div>

          {/* Status Section */}
          <div className="border-t border-border pt-4 space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <BadgeInfo className="w-4 h-4 text-primary" />
              Status
            </h3>
            <div className="space-y-2 pl-6">
              <div className="flex items-center text-sm">
                <span className="text-muted-foreground min-w-[100px]">Muted:</span>
                <span
                  className={`px-2 py-0.5 rounded text-xs font-medium ${userInfo.muted
                    ? "bg-yellow-500/20 text-yellow-500"
                    : "bg-green-500/20 text-green-500"
                    }`}
                >
                  {userInfo.muted ? "Yes" : "No"}
                </span>
              </div>
              <div className="flex items-center text-sm">
                <span className="text-muted-foreground min-w-[100px]">Blocked:</span>
                <span
                  className={`px-2 py-0.5 rounded text-xs font-medium ${userInfo.blocked
                    ? "bg-red-500/20 text-red-500"
                    : "bg-green-500/20 text-green-500"
                    }`}
                >
                  {userInfo.blocked ? "Yes" : "No"}
                </span>
              </div>
              {userInfo.blocked && userInfo.blockedAt && (
                <div className="flex items-center text-sm">
                  <span className="text-muted-foreground min-w-[100px]">Blocked At:</span>
                  <span className="font-mono text-xs">{formatDate(userInfo.blockedAt)}</span>
                </div>
              )}
              {userInfo.blocked && userInfo.blockReason && (
                <div className="flex items-start text-sm">
                  <span className="text-muted-foreground min-w-[100px]">Reason:</span>
                  <span className="text-xs flex-1">{userInfo.blockReason}</span>
                </div>
              )}
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={copyAllInfo}>
            {copiedField === "all" ? (
              <>
                <Check className="w-4 h-4 mr-2" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="w-4 h-4 mr-2" />
                Copy All Info
              </>
            )}
          </Button>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
