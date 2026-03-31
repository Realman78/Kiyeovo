import type { FC } from "react";
import { Phone, PhoneOff, Video } from "lucide-react";
import { Button } from "../../ui/Button";

type ChatHeaderCallControlsProps = {
  canShowCallButtons: boolean;
  hasActiveCallWithThisPeer: boolean;
  startCallDisabled: boolean;
  audioCallButtonTitle: string;
  videoCallButtonTitle: string;
  onAudioCallClick: () => void;
  onVideoCallClick: () => void;
};

export const ChatHeaderCallControls: FC<ChatHeaderCallControlsProps> = ({
  canShowCallButtons,
  hasActiveCallWithThisPeer,
  startCallDisabled,
  audioCallButtonTitle,
  videoCallButtonTitle,
  onAudioCallClick,
  onVideoCallClick,
}) => {
  if (!canShowCallButtons) {
    return null;
  }

  if (hasActiveCallWithThisPeer) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-foreground"
        onClick={onAudioCallClick}
        title="Hang up"
      >
        <PhoneOff className="w-4 h-4" />
      </Button>
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-foreground"
        onClick={onAudioCallClick}
        title={audioCallButtonTitle}
        disabled={startCallDisabled}
      >
        <Phone className="w-4 h-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-foreground"
        onClick={onVideoCallClick}
        title={videoCallButtonTitle}
        disabled={startCallDisabled}
      >
        <Video className="w-4 h-4" />
      </Button>
    </>
  );
};
