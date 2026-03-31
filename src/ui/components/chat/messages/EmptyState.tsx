import { MessageSquare } from "lucide-react";

export const EmptyState = () => {
  return (
    <div className="flex-1 flex items-center justify-center bg-background">
      <div className="text-center">
        <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center mx-auto mb-4">
          <MessageSquare className="w-8 h-8 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-medium text-foreground mb-2">No chat selected</h3>
        <p className="text-sm text-muted-foreground">
          Select a conversation to start messaging
        </p>
      </div>
    </div>
  );
};
