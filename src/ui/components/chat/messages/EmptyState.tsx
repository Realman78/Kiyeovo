import type { ReactNode } from "react";
import {
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Network,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useSelector } from "react-redux";
import type { RootState } from "../../../state/store";
import { Button } from "../../ui/Button";
import { useSetupReadiness } from "../../../hooks/useSetupReadiness";
import {
  requestOpenRegisterDialog,
  requestOpenSetup,
  requestSidebarAction,
} from "../../../utils/uiSignals";

function Hero({
  icon: Icon,
  title,
  body,
  primary,
  secondary,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  primary: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <div className="flex-1 flex items-center justify-center bg-background p-8">
      <div className="max-w-md text-center">
        <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/25 flex items-center justify-center mx-auto mb-5 text-primary">
          <Icon className="w-8 h-8" />
        </div>
        <h3 className="text-xl font-semibold text-foreground mb-2">{title}</h3>
        <p className="text-sm leading-6 text-muted-foreground mb-6">{body}</p>
        <div className="flex flex-col items-center gap-3">{primary}{secondary}</div>
      </div>
    </div>
  );
}

export const EmptyState = () => {
  const isRegistered = useSelector((state: RootState) => state.user.registered);
  const hasChats = useSelector((state: RootState) => state.chat.chats.length > 0);
  const readiness = useSetupReadiness();

  // Niche, prerequisite-bound path (needs a profile file a contact exported and
  // sent you), so it's always a quiet text link rather than a competing CTA.
  const addUserFromFileLink = (
    <button
      type="button"
      onClick={() => requestSidebarAction('import-trusted-user')}
      className="text-sm text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground focus:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      Have a profile file from a contact? Add them
    </button>
  );

  // Returning user who simply deselected a conversation.
  if (hasChats) {
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
  }

  // Registered, no conversations yet: straight to the first chat (independent of setup state).
  if (isRegistered) {
    return (
      <Hero
        icon={MessageSquarePlus}
        title="Start your first conversation"
        body="Reach someone by their username or Peer ID. Messages are end-to-end encrypted."
        primary={
          <Button size="lg" onClick={() => requestSidebarAction('new-conversation')}>
            <MessageSquarePlus />
            Start a conversation
          </Button>
        }
        secondary={
          <>
            <Button variant="ghost" size="sm" onClick={() => requestSidebarAction('new-group')}>
              <Users />
              New group
            </Button>
            {addUserFromFileLink}
          </>
        }
      />
    );
  }

  // Unregistered, still resolving setup state: avoid flashing the wrong CTA.
  if (readiness === null) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Unregistered + no bootstrap configured: registration would dead-end (it needs
  // a live connection), so route to setup first.
  if (readiness.severity === 'blocked') {
    return (
      <Hero
        icon={Network}
        title="Finish setting up to connect"
        body="Kiyeovo needs at least one bootstrap server before you can register or reach anyone."
        primary={
          <Button size="lg" onClick={() => requestOpenSetup()}>
            <Network />
            Finish setup
          </Button>
        }
        secondary={addUserFromFileLink}
      />
    );
  }

  // Unregistered + connectable: claim a username.
  return (
    <Hero
      icon={UserPlus}
      title="Pick a username to get started"
      body="Registering publishes a username others can find you by, and lets you start new conversations. You can change it later."
      primary={
        <Button size="lg" onClick={requestOpenRegisterDialog}>
          <UserPlus />
          Choose a username
        </Button>
      }
      secondary={addUserFromFileLink}
    />
  );
};
