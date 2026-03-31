import { useState } from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../../../state/store";
import { ContactAttemptItem } from "./ContactAttemptItem";
import type { FC } from "react";
import { ChevronDown } from "lucide-react";

interface ContactAttemptListProps {
  isLoadingContactAttempts: boolean;
  contactAttemptsError: string | null;
  handleContactAttemptExpired: (peerId: string) => void;
}
export const ContactAttemptList: FC<ContactAttemptListProps> = ({ isLoadingContactAttempts, contactAttemptsError, handleContactAttemptExpired }) => {
  const contactAttempts = useSelector((state: RootState) => state.chat.contactAttempts);
  const [isExpanded, setIsExpanded] = useState(true);

  return <div className="border-b border-sidebar-border mb-4">
    <button
      onClick={() => setIsExpanded(!isExpanded)}
      className="w-full cursor-pointer flex items-center justify-between px-4 py-2 hover:bg-sidebar-accent transition-colors"
    >
      <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
        Contact Requests
      </div>
      <div className="flex items-center gap-2">
        <div className="shrink-0 w-5 h-5 rounded-full bg-warning/80 text-warning-foreground text-xs font-bold font-mono flex items-center justify-center">
          {contactAttempts.length}
        </div>
        <ChevronDown
          className={`w-4 h-4 text-muted-foreground transition-transform duration-300 ${isExpanded ? '' : '-rotate-90'}`}
        />
      </div>
    </button>

    <div
      className={`transition-all duration-300 ease-in-out overflow-hidden ${isExpanded ? 'max-h-96' : 'max-h-0'
        }`}
    >
      {isLoadingContactAttempts ? (
        <div className="text-center text-muted-foreground py-2">Loading contact attempts...</div>
      ) : contactAttemptsError ? (
        <div className="text-center text-red-500 py-2">{contactAttemptsError}</div>
      ) : (
        contactAttempts.map(attempt => (
          <ContactAttemptItem
            key={attempt.peerId}
            attempt={attempt}
            onExpired={handleContactAttemptExpired}
          />
        ))
      )}
    </div>
  </div>
}
