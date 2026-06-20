import { useState, type FC, type FocusEvent as ReactFocusEvent } from 'react';
import { MessageSquare, Network, Settings, Users } from 'lucide-react';
import { Logo } from '../icons/Logo';
import { KiyeovoDialog } from './header/KiyeovoDialog';
import { useSetupReadiness, type SetupSeverity } from '../../hooks/useSetupReadiness';
import type { SidebarSection } from './navigation';

type SidebarRailProps = {
  activeSection: SidebarSection;
  onSelectSection: (section: SidebarSection) => void;
  isTorEnabled: boolean;
};

type RailItem = {
  section: SidebarSection;
  label: string;
  icon: typeof MessageSquare;
};

const PRIMARY_ITEMS: RailItem[] = [
  { section: 'chats', label: 'Chats', icon: MessageSquare },
  { section: 'groups', label: 'Groups', icon: Users },
  { section: 'setup', label: 'Setup', icon: Network },
];

const SECONDARY_ITEMS: RailItem[] = [
  // { section: 'help', label: 'Help', icon: CircleHelp },
  { section: 'settings', label: 'Settings', icon: Settings },
];

type SidebarRailButtonProps = {
  active: boolean;
  expanded: boolean;
  icon: typeof MessageSquare;
  label: string;
  onClick: () => void;
  severity?: SetupSeverity;
};

const SidebarRailButton: FC<SidebarRailButtonProps> = ({
  active,
  expanded,
  icon: Icon,
  label,
  onClick,
  severity
}) => {
  const statusLabel = !severity ? null
    : severity === 'blocked' ? 'setup blocked'
    : 'setup needs attention'
  const accessibleLabel = statusLabel ? `${label}, ${statusLabel}` : label;

  return (
    <button
      type="button"
      onClick={onClick}
      title={accessibleLabel}
      aria-label={accessibleLabel}
      className={`flex outline-0 h-12 w-full cursor-pointer items-center gap-3 overflow-hidden border px-0 transition-colors ${active
          ? 'border-transparent border-l-primary/40 border-3 bg-primary/15 text-primary shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)]'
          : 'border-transparent text-muted-foreground hover:border-sidebar-border hover:bg-sidebar-accent hover:text-foreground'
        }`}
    >
      <span className="relative flex h-full w-14 shrink-0 items-center justify-center">
        <Icon className="h-5 w-5" />
        {severity && (
          <span
            className={`absolute right-3 top-2 h-2 w-2 rounded-full ring-2 ring-sidebar-background ${
              severity === 'blocked' ? 'bg-destructive' : 'bg-warning'
            }`}
          />
        )}
      </span>
      <span className={`whitespace-nowrap text-sm font-medium transition-opacity duration-150 ${expanded ? 'opacity-100' : 'opacity-0'}`}>
        {label}
      </span>
    </button>
  );
};

export const SidebarRail: FC<SidebarRailProps> = ({
  activeSection,
  onSelectSection,
  isTorEnabled,
}) => {
  const [kiyeovoDialogOpen, setKiyeovoDialogOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const setupReadiness = useSetupReadiness();

  const openKiyeovoDialog = () => {
    setKiyeovoDialogOpen(true);
  }

  const handleBlurCapture = (event: ReactFocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }

    setExpanded(false);
  };
  return (
    <div className="relative z-50 h-full w-14 shrink-0 overflow-visible bg-sidebar-background">
      <KiyeovoDialog open={kiyeovoDialogOpen} onOpenChange={setKiyeovoDialogOpen} />

      <div
        className={`absolute inset-y-0 left-0 z-50 overflow-hidden border-r border-sidebar-border bg-sidebar-background shadow-xl transition-[width] duration-200 ease-out ${expanded ? 'w-44' : 'w-14'}`}
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
        onFocusCapture={() => setExpanded(true)}
        onBlurCapture={handleBlurCapture}
      >
        <div className="relative z-10 flex h-full flex-col justify-between pb-4 pt-4">
          <div className="flex flex-col gap-3">
            <div
              className={`mx-auto mb-4 flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border ${isTorEnabled ? "border-[#5a3184] glow-border-tor" : "border-primary/50 glow-border"}`}
              onClick={openKiyeovoDialog}
            >
              <Logo version="2" />
            </div>
            {PRIMARY_ITEMS.map((item) => (
              <SidebarRailButton
                key={item.section}
                active={activeSection === item.section}
                expanded={expanded}
                icon={item.icon}
                label={item.label}
                onClick={() => onSelectSection(item.section)}
                severity={item.section === 'setup' && setupReadiness?.severity !== 'ready'
                  ? setupReadiness?.severity ?? undefined
                  : undefined}
              />
            ))}
          </div>

          <div className="flex flex-col gap-3">
            {SECONDARY_ITEMS.map((item) => (
              <SidebarRailButton
                key={item.section}
                active={activeSection === item.section}
                expanded={expanded}
                icon={item.icon}
                label={item.label}
                onClick={() => onSelectSection(item.section)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
