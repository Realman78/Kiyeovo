import type { FC } from "react";
import { Phone, PhoneOff } from "lucide-react";
import { Button } from "../../ui/Button";

type ChatHeaderCallControlsProps = {
  canShowCallButtons: boolean;
  hasActiveCallWithThisPeer: boolean;
  startCallDisabled: boolean;
  callButtonTitle: string;
  onCallClick: () => void;
};

export const ChatHeaderCallControls: FC<ChatHeaderCallControlsProps> = ({
  canShowCallButtons,
  hasActiveCallWithThisPeer,
  startCallDisabled,
  callButtonTitle,
  onCallClick,
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
        onClick={onCallClick}
        title="Hang up"
      >
        <PhoneOff className="w-4 h-4" />
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="text-muted-foreground hover:text-foreground"
      onClick={onCallClick}
      title={callButtonTitle}
      disabled={startCallDisabled}
    >
      <Phone className="w-4 h-4" />
    </Button>
  );
};
