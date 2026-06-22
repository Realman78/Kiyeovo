import { MessageSquare } from "lucide-react";
import type { ReactNode } from "react";

type EmptyChatListProps = {
  title?: string;
  description?: string;
  action?: ReactNode;
};

export const EmptyChatList = ({
  title = "No conversations yet",
  description = "Start a new conversation by sending a message to a peer",
  action,
}: EmptyChatListProps) => {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 border-t border-sidebar-border text-center">
      <div className="w-16 h-16 rounded-full bg-muted/20 flex items-center justify-center mb-4">
        <MessageSquare className="w-8 h-8 text-muted-foreground" />
      </div>
      <h3 className="text-base font-medium text-foreground mb-2">
        {title}
      </h3>
      <p className="text-sm text-muted-foreground max-w-[250px]">
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
};
