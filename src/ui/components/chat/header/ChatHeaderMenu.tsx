import type { FC, ReactNode } from "react";
import { Ban, Bell, BellOff, Info, LogOut, MoreVertical, Pencil, RefreshCw, Trash2, UserCheck, UserMinus, UserPlus } from "lucide-react";
import { Button } from "../../ui/Button";
import { DropdownMenu, DropdownMenuItem } from "../../ui/DropdownMenu";

type ChatHeaderMenuProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isGroup: boolean;
  activeChatMuted?: boolean;
  groupStatus?: string;
  activeChatStatus?: string;
  isBlocked: boolean;
  canRequestGroupUpdate: boolean;
  isRequestingGroupUpdate: boolean;
  isCurrentUserGroupCreator: boolean;
  kickableMembersCount: number;
  canShowLeaveOrDisband: boolean;
  canDeleteGroupChat: boolean;
  onAboutGroup: () => void;
  onAboutUser: () => void;
  onEditUsername: () => void;
  onToggleMute: () => void;
  onCheckMissedGroupMessages: () => void;
  onCheckMissedDirectMessages: () => void;
  onRequestGroupUpdate: () => void;
  onInviteUsers: () => void;
  onKickMember: () => void;
  onLeaveGroup: () => void;
  onDeleteGroupChat: () => void;
  onToggleBlock: () => void;
  onDeleteAllMessages: () => void;
  onDeleteChatAndUser: () => void;
};

type MenuActionItem = {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
};

export const ChatHeaderMenu: FC<ChatHeaderMenuProps> = ({
  open,
  onOpenChange,
  isGroup,
  activeChatMuted,
  groupStatus,
  activeChatStatus,
  isBlocked,
  canRequestGroupUpdate,
  isRequestingGroupUpdate,
  isCurrentUserGroupCreator,
  kickableMembersCount,
  canShowLeaveOrDisband,
  canDeleteGroupChat,
  onAboutGroup,
  onAboutUser,
  onEditUsername,
  onToggleMute,
  onCheckMissedGroupMessages,
  onCheckMissedDirectMessages,
  onRequestGroupUpdate,
  onInviteUsers,
  onKickMember,
  onLeaveGroup,
  onDeleteGroupChat,
  onToggleBlock,
  onDeleteAllMessages,
  onDeleteChatAndUser,
}) => {
  const groupItems: MenuActionItem[] = [
    {
      key: 'about-group',
      label: 'About group',
      icon: <Info className="w-4 h-4" />,
      onClick: onAboutGroup,
    },
    ...(groupStatus === 'active'
      ? [{
          key: 'toggle-mute',
          label: activeChatMuted ? 'Enable notifications' : 'Disable notifications',
          icon: activeChatMuted ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />,
          onClick: onToggleMute,
        }]
      : []),
    ...(groupStatus === 'active'
      ? [{
          key: 'check-missed',
          label: 'Check missed messages',
          icon: <RefreshCw className="w-4 h-4" />,
          onClick: onCheckMissedGroupMessages,
        }]
      : []),
    ...(canRequestGroupUpdate
      ? [{
          key: 'request-update',
          label: isRequestingGroupUpdate ? 'Requesting update...' : 'Request group update',
          icon: <RefreshCw className="w-4 h-4" />,
          onClick: onRequestGroupUpdate,
        }]
      : []),
    ...(groupStatus === 'active' && isCurrentUserGroupCreator
      ? [{
          key: 'invite-users',
          label: 'Invite users',
          icon: <UserPlus className="w-4 h-4" />,
          onClick: onInviteUsers,
        }]
      : []),
    ...(groupStatus === 'active' && isCurrentUserGroupCreator && kickableMembersCount > 0
      ? [{
          key: 'remove-member',
          label: 'Remove member',
          icon: <UserMinus className="w-4 h-4" />,
          onClick: onKickMember,
        }]
      : []),
    ...(canShowLeaveOrDisband
      ? [{
          key: 'leave-or-disband',
          label: isCurrentUserGroupCreator ? 'Disband group' : 'Leave group',
          icon: <LogOut className="w-4 h-4" />,
          onClick: onLeaveGroup,
        }]
      : []),
    ...(canDeleteGroupChat
      ? [{
          key: 'delete-group-chat',
          label: 'Delete chat',
          icon: <Trash2 className="w-4 h-4" />,
          onClick: onDeleteGroupChat,
        }]
      : []),
  ];

  const directItems: MenuActionItem[] = [
    {
      key: 'about-user',
      label: 'About user',
      icon: <Info className="w-4 h-4" />,
      onClick: onAboutUser,
    },
    {
      key: 'edit-username',
      label: 'Edit username',
      icon: <Pencil className="w-4 h-4" />,
      onClick: onEditUsername,
    },
    {
      key: 'toggle-mute',
      label: activeChatMuted ? 'Enable notifications' : 'Disable notifications',
      icon: activeChatMuted ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />,
      onClick: onToggleMute,
    },
    ...(activeChatStatus === 'active'
      ? [{
          key: 'check-missed',
          label: 'Check missed messages',
          icon: <RefreshCw className="w-4 h-4" />,
          onClick: onCheckMissedDirectMessages,
        }]
      : []),
    {
      key: 'toggle-block',
      label: isBlocked ? 'Unblock user' : 'Block user',
      icon: isBlocked ? <UserCheck className="w-4 h-4" /> : <Ban className="w-4 h-4" />,
      onClick: onToggleBlock,
    },
    {
      key: 'delete-all-messages',
      label: 'Clear messages',
      icon: <Trash2 className="w-4 h-4" />,
      onClick: onDeleteAllMessages,
    },
    {
      key: 'delete-chat-and-user',
      label: 'Delete chat & User',
      icon: <Trash2 className="w-4 h-4" />,
      onClick: onDeleteChatAndUser,
    },
  ];

  const items = isGroup ? groupItems : directItems;

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={onOpenChange}
        trigger={(
          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
            <MoreVertical className="w-4 h-4" />
          </Button>
        )}
      >
        {items.map((item) => (
          <DropdownMenuItem
            key={item.key}
            icon={item.icon}
            onClick={item.onClick}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenu>
    </>
  );
};
