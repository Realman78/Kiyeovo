import { useState } from 'react';
import {
  ArrowRight,
  Loader2,
  Network,
  PhoneCall,
  RadioTower,
  Route,
  type LucideIcon,
} from 'lucide-react';
import { useSetupReadiness } from '../../../hooks/useSetupReadiness';
import { Button } from '../../ui/Button';
import { SkipSetupConfirmDialog } from './SkipSetupConfirmDialog';

type WelcomeItem = {
  title: string;
  description: string;
  icon: LucideIcon;
  optional?: boolean;
};

const FAST_ITEMS: WelcomeItem[] = [
  {
    title: 'Bootstrap servers',
    description: 'Find people, groups, and offline messages.',
    icon: RadioTower,
  },
  {
    title: 'Relay servers',
    description: 'Improve messaging reliability.',
    icon: Route,
  },
  {
    title: 'STUN/TURN servers',
    description: 'Enable audio and video calls.',
    icon: PhoneCall,
    optional: true,
  },
];

const ANONYMOUS_ITEMS = [FAST_ITEMS[0]!];

function WelcomeCard({ item }: { item: WelcomeItem }) {
  const Icon = item.icon;

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card/55 p-5 text-left">
      <div className="absolute inset-y-0 left-0 w-px bg-primary/70" aria-hidden />
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">{item.title}</h2>
            {item.optional && (
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wide text-muted-foreground">
                Optional
              </span>
            )}
          </div>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.description}</p>
        </div>
      </div>
    </div>
  );
}

type InitialSetupWelcomeProps = {
  onStart: () => void;
  onSkip: () => void;
};

export function InitialSetupWelcome({
  onStart,
  onSkip,
}: InitialSetupWelcomeProps) {
  const readiness = useSetupReadiness();
  const items = readiness?.mode === 'anonymous' ? ANONYMOUS_ITEMS : FAST_ITEMS;
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);

  return (
    <div className="relative h-full overflow-y-auto bg-sidebar-accent">
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            'radial-gradient(circle at 68% 18%, color-mix(in srgb, var(--primary) 13%, transparent), transparent 34%), radial-gradient(circle at 15% 82%, color-mix(in srgb, var(--primary) 8%, transparent), transparent 28%)',
        }}
        aria-hidden
      />
      <div className="relative mx-auto flex min-h-full w-full max-w-5xl items-center px-8 py-14">
        <div className="grid w-full gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
          <div className="text-left">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-mono uppercase tracking-widest text-primary">
              <Network className="h-3.5 w-3.5" />
              First-time setup
            </div>
            <h1 className="max-w-xl text-4xl font-semibold tracking-tight text-foreground">
              Let&apos;s get Kiyeovo connected!
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground">
              You decide which network providers to trust. This will take just a minute, and it's the most important step. Kiyeovo uses them to discover people, deliver messages, and make calls.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                onClick={onStart}
              >
                <ArrowRight />
                Start setup
              </Button>
            </div>
            <p className="mt-4 text-xs leading-5 text-muted-foreground">
              You can{' '}
              <button
                type="button"
                onClick={() => setShowSkipConfirm(true)}
                className="cursor-pointer font-medium text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground focus:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                skip this guide
              </button>
              , but messaging will remain unavailable until the required services are
              configured.
            </p>
          </div>

          <div className="space-y-3">
            {readiness === null ? (
              <div className="flex min-h-40 items-center justify-center rounded-xl border border-border bg-card/40 text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading setup requirements...
              </div>
            ) : (
              items.map((item) => <WelcomeCard key={item.title} item={item} />)
            )}
          </div>
        </div>
      </div>

      <SkipSetupConfirmDialog
        open={showSkipConfirm}
        onOpenChange={setShowSkipConfirm}
        onConfirm={onSkip}
      />
    </div>
  );
}
