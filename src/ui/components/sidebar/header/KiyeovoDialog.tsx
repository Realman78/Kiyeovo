import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "../../ui/Dialog";
import type { FC } from "react";
import { Logo } from "../../icons/Logo";
import { useSelector } from "react-redux";
import type { RootState } from "../../../state/store";

type KiyeovoDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export const KiyeovoDialog: FC<KiyeovoDialogProps> = ({ open, onOpenChange }) => {
    const isTorActive = useSelector((state: RootState) => state.user.torEnabled);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center justify-center gap-2 mb-6 text-2xl! cursor-default">
                        <div className={`w-12 h-12 rounded-full border ${isTorActive ? "border-[#5a3184] glow-border-tor" : "border-primary/50 glow-border"} flex items-center justify-center`}>
                            <Logo version="2" />
                        </div>
                        Kiyeovo
                    </DialogTitle>
                </DialogHeader>

                <DialogBody className="cursor-default space-y-6">
                    {/* Key Features */}
                    <div className="space-y-3">
                        <div className="text-justify mb-1">
                        Kiyeovo is a decentralized peer-to-peer messenger with two isolated network modes:
                        fast mode for lower-latency direct connectivity, and anonymous mode for Tor-routed communication.
                        </div>
                        <div className="text-justify mb-5">
                        Messages are end-to-end encrypted. Peer discovery and offline message delivery is done through a DHT without relying on a central server.
                        </div>
                        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Key Features</h3>
                        <div className="grid gap-2">
                            <div className="flex items-start gap-2 text-sm">
                                <span className="text-base">🔒</span>
                                <span>End-to-end encrypted direct chats with signed key exchange and rotating session keys</span>
                            </div>
                            <div className="flex items-start gap-2 text-sm">
                                <span className="text-base">🌐</span>
                                <span>Mode-scoped decentralized networking with DHT discovery and no central messaging server</span>
                            </div>
                            <div className="flex items-start gap-2 text-sm">
                                <span className="text-base">⚡</span>
                                <span>Fast mode uses relay-assisted direct connectivity enabling you to chat and call with other people</span>
                            </div>
                            <div className="flex items-start gap-2 text-sm">
                                <span className="text-base">🧅</span>
                                <span>Anonymous mode routes traffic through Tor and thus hiding your identity</span>
                            </div>
                            <div className="flex items-start gap-2 text-sm">
                                <span className="text-base">💾</span>
                                <span>Offline delivery for direct and group messaging with signed DHT-backed stores</span>
                            </div>
                            <div className="flex items-start gap-2 text-sm">
                                <span className="text-base">👥</span>
                                <span>Group chats, encrypted file transfer, and fast-mode 1:1 audio/video calling</span>
                            </div>
                        </div>
                    </div>

                    {/* Links */}
                    <div className="space-y-3">
                        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Resources</h3>
                        <div className="flex flex-wrap gap-3 text-sm">
                            <a href="https://github.com/Realman78/Kiyeovo" target="_blank" rel="noopener noreferrer"
                               className="text-primary hover:underline flex items-center gap-1">
                                💻 Source Code & Documentation
                            </a>
                            <a href="https://github.com/Realman78/Kiyeovo/issues" target="_blank" rel="noopener noreferrer"
                               className="text-primary hover:underline flex items-center gap-1">
                                🐛 Report Issue
                            </a>
                        </div>
                    </div>

                    {/* Footer */}
                    <div className="pt-4 border-t border-border text-center text-sm text-muted-foreground">
                        <p>Built by Marin Dedic</p>
                    </div>
                </DialogBody>
            </DialogContent>
        </Dialog>
    );
}
