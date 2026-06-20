import type { FC } from 'react';
import type { NetworkMode } from '../../../../core/types';
import {
  useSetupReadiness,
  type SetupReadiness,
  type SetupSeverity,
} from '../../../hooks/useSetupReadiness';
import type { SetupSection } from '../navigation';
import {
  Dot,
  Network,
  PhoneCall,
  RadioTower,
  Route,
  type LucideIcon,
} from 'lucide-react';

type SetupSidebarProps = {
  activeSection: SetupSection;
  networkMode: NetworkMode;
  onSelectSection: (section: SetupSection) => void;
  collapsed?: boolean;
};

const SETUP_ITEMS: Array<{
  section: SetupSection;
  title: string;
  description: string;
  icon: LucideIcon;
}> = [
    {
      section: 'bootstrap',
      title: 'Bootstrap servers',
      description: 'Discover people, groups, and offline messages',
      icon: RadioTower,
    },
    {
      section: 'relay',
      title: 'Relay servers',
      description: 'Improve messaging reliability',
      icon: Route,
    },
    {
      section: 'ice',
      title: 'STUN/TURN servers',
      description: 'Enable audio and video calls',
      icon: PhoneCall,
    },
  ];

type SetupItemStatus = {
  label: 'Not configured' | 'Status unavailable';
  severity: Exclude<SetupSeverity, 'ready'>;
};

function getItemStatus(
  section: SetupSection,
  readiness: SetupReadiness | null,
): SetupItemStatus | null {
  if (!readiness) return null;

  const status = readiness[section];
  if (status === 'missing') {
    return {
      label: 'Not configured',
      severity: section === 'bootstrap' ? 'blocked' : 'warning',
    };
  }
  if (status === 'unknown') {
    return {
      label: 'Status unavailable',
      severity: section === 'bootstrap' ? 'blocked' : 'warning',
    };
  }
  return null;
}

export const SetupSidebar: FC<SetupSidebarProps> = ({
  activeSection,
  networkMode,
  onSelectSection,
  collapsed = false,
}) => {
  const setupReadiness = useSetupReadiness();
  const items = networkMode === 'anonymous'
    ? SETUP_ITEMS.filter((item) => item.section === 'bootstrap')
    : SETUP_ITEMS;

  return (
    <div className="h-full w-96 shrink-0">
      <div className="flex h-20 w-96 items-center border-b border-sidebar-border">
        <span className="flex h-full w-16 shrink-0 items-center justify-center">
          <Network className="h-5 w-5 text-sidebar-foreground" />
        </span>
        <h2
          className={`whitespace-nowrap text-base font-semibold text-sidebar-foreground transition-opacity ${collapsed
            ? 'opacity-0 duration-75'
            : 'opacity-100 delay-150 duration-150'
            }`}
        >
          Setup
        </h2>
      </div>

      <nav aria-label="Setup sections">
        {items.map((item) => {
          const Icon = item.icon;
          const status = getItemStatus(item.section, setupReadiness);
          const accessibleLabel = status
            ? `${item.title}, ${status.label.toLowerCase()}`
            : item.title;

          return (
            <button
              key={item.section}
              type="button"
              onClick={() => onSelectSection(item.section)}
              title={collapsed ? accessibleLabel : undefined}
              aria-label={accessibleLabel}
              className={`flex min-h-20 w-96 cursor-pointer items-center border-b border-sidebar-border text-left transition-colors ${activeSection === item.section
                ? 'border-l-2 border-l-primary! bg-sidebar-accent text-foreground'
                : 'text-sidebar-foreground hover:bg-sidebar-accent/60'
                }`}
            >
              <span className="relative flex h-full w-16 shrink-0 items-center justify-center">
                <Icon className="h-5 w-5" />
                {status && (
                  <span
                    className={`absolute right-4 bottom-4 h-2 w-2 rounded-full ring-2 ring-sidebar-background ${status.severity === 'blocked' ? 'bg-destructive' : 'bg-warning'
                      }`}
                    aria-hidden
                  />
                )}
              </span>
              <span
                className={`min-w-0 flex-1 pr-5 transition-opacity ${collapsed
                  ? 'opacity-0 duration-75'
                  : 'opacity-100 delay-150 duration-150'
                  }`}
              >
                <span className="flex items-center gap-0 whitespace-nowrap text-sm font-medium">
                  <span className="flex items-center">
                    {item.title}
                    {status && <span className={`mt-0.5 flex items-center text-xs ${status.severity === 'blocked' ? 'text-destructive' : 'text-warning'}`}> <Dot /></span>}
                  </span>
                  {status && (
                    <span
                      className={`mt-1 text-[11px] font-normal ${status.severity === 'blocked' ? 'text-destructive' : 'text-warning'
                        }`}
                    >
                      {status.label}
                    </span>
                  )}
                </span>
                <span className="mt-1 block whitespace-nowrap text-xs leading-5 text-muted-foreground">
                  {item.description}
                </span>
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
};
