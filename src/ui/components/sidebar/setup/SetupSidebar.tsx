import type { FC } from 'react';
import type { NetworkMode } from '../../../../core/types';
import type { SetupSection } from '../navigation';
import {
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

export const SetupSidebar: FC<SetupSidebarProps> = ({
  activeSection,
  networkMode,
  onSelectSection,
  collapsed = false,
}) => {
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
          className={`whitespace-nowrap text-base font-semibold text-sidebar-foreground transition-[opacity,transform] duration-150 ${
            collapsed
              ? '-translate-x-2 opacity-0'
              : 'translate-x-0 opacity-100 delay-150'
          }`}
        >
          Setup
        </h2>
      </div>

      <nav aria-label="Setup sections">
        {items.map((item) => {
          const Icon = item.icon;

          return (
            <button
              key={item.section}
              type="button"
              onClick={() => onSelectSection(item.section)}
              title={collapsed ? item.title : undefined}
              aria-label={item.title}
              className={`flex min-h-20 w-96 cursor-pointer items-center border-b border-sidebar-border text-left transition-colors ${
                activeSection === item.section
                  ? 'border-l-2 border-l-primary! bg-sidebar-accent text-foreground'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent/60'
              }`}
            >
              <span className="flex h-full w-16 shrink-0 items-center justify-center">
                <Icon className="h-5 w-5" />
              </span>
              <span
                className={`min-w-0 flex-1 pr-5 transition-[opacity,transform] duration-150 ${
                  collapsed
                    ? '-translate-x-2 opacity-0'
                    : 'translate-x-0 opacity-100 delay-150'
                }`}
              >
                <span className="block whitespace-nowrap text-sm font-medium">{item.title}</span>
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
