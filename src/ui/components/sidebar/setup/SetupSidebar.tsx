import type { FC } from 'react';
import type { NetworkMode } from '../../../../core/types';
import type { SetupSection } from '../navigation';
import { Network } from 'lucide-react';

type SetupSidebarProps = {
  activeSection: SetupSection;
  networkMode: NetworkMode;
  onSelectSection: (section: SetupSection) => void;
};

const SETUP_ITEMS: Array<{
  section: SetupSection;
  title: string;
  description: string;
}> = [
  {
    section: 'bootstrap',
    title: 'Bootstrap servers',
    description: 'Discover people, groups, and offline messages',
  },
  {
    section: 'relay',
    title: 'Relay servers',
    description: 'Improve messaging reliability',
  },
  {
    section: 'ice',
    title: 'STUN/TURN servers',
    description: 'Enable audio and video calls',
  },
];

export const SetupSidebar: FC<SetupSidebarProps> = ({
  activeSection,
  networkMode,
  onSelectSection,
}) => {
  const items = networkMode === 'anonymous'
    ? SETUP_ITEMS.filter((item) => item.section === 'bootstrap')
    : SETUP_ITEMS;

  return (
    <>
      <div className="flex h-20 items-center border-b border-sidebar-border px-5 gap-2">
        <Network className="h-5 w-5 text-sidebar-foreground" />
        <h2 className="text-base font-semibold text-sidebar-foreground">Setup</h2>
      </div>

      <nav aria-label="Setup sections">
        {items.map((item) => (
          <button
            key={item.section}
            type="button"
            onClick={() => onSelectSection(item.section)}
            className={`w-full cursor-pointer border-b border-sidebar-border px-5 py-4 text-left transition-colors ${
              activeSection === item.section
                ? 'bg-sidebar-accent text-foreground'
                : 'text-sidebar-foreground hover:bg-sidebar-accent/60'
            }`}
          >
            <span className="block text-sm font-medium">{item.title}</span>
            <span className="mt-1 block text-xs leading-5 text-muted-foreground">
              {item.description}
            </span>
          </button>
        ))}
      </nav>
    </>
  );
};
