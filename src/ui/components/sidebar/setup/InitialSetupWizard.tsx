import { useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Circle,
  MessageSquare,
  Network,
  ShieldCheck,
} from 'lucide-react';
import { useSetupReadiness, type SetupReadiness } from '../../../hooks/useSetupReadiness';
import { Button } from '../../ui/Button';
import { SkipSetupConfirmDialog } from './SkipSetupConfirmDialog';
import type { SetupSection } from '../navigation';

type WizardStep = {
  section: SetupSection;
  title: string;
  optional?: boolean;
};

const FAST_STEPS: WizardStep[] = [
  { section: 'bootstrap', title: 'Bootstrap' },
  { section: 'relay', title: 'Relay' },
  { section: 'ice', title: 'Calls', optional: true },
];

const ANONYMOUS_STEPS: WizardStep[] = [
  { section: 'bootstrap', title: 'Bootstrap' },
];

function isConfigured(section: SetupSection, readiness: SetupReadiness): boolean {
  return readiness[section] === 'configured';
}

function requiredSetupComplete(readiness: SetupReadiness): boolean {
  if (readiness.bootstrap !== 'configured') return false;
  return readiness.mode === 'anonymous' || readiness.relay === 'configured';
}

type InitialSetupWizardProps = {
  activeSection: SetupSection;
  onSelectSection: (section: SetupSection) => void;
  onSkip: () => Promise<void>;
  onFinish: () => Promise<void>;
  saving: boolean;
  children: ReactNode;
};

export function InitialSetupWizard({
  activeSection,
  onSelectSection,
  onSkip,
  onFinish,
  saving,
  children,
}: InitialSetupWizardProps) {
  const readiness = useSetupReadiness();
  const [showingReady, setShowingReady] = useState(false);
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);
  const steps = readiness?.mode === 'anonymous' ? ANONYMOUS_STEPS : FAST_STEPS;
  const activeStepIndex = steps.findIndex((step) => step.section === activeSection);
  const activeStep = activeStepIndex >= 0 ? steps[activeStepIndex]! : steps[0]!;

  const handleContinue = () => {
    if (!readiness) return;

    if (activeSection === 'bootstrap') {
      if (readiness.bootstrap !== 'configured') return;
      if (readiness.mode === 'anonymous') {
        setShowingReady(true);
      } else {
        onSelectSection('relay');
      }
      return;
    }

    if (activeSection === 'relay') {
      if (!requiredSetupComplete(readiness)) return;
      onSelectSection('ice');
      return;
    }

    if (requiredSetupComplete(readiness)) {
      setShowingReady(true);
    }
  };

  const handleBack = () => {
    if (showingReady) {
      setShowingReady(false);
      return;
    }

    if (activeSection === 'ice') {
      onSelectSection('relay');
    } else if (activeSection === 'relay') {
      onSelectSection('bootstrap');
    }
  };

  if (showingReady && readiness) {
    return (
      <div className="relative flex h-full items-center justify-center overflow-y-auto bg-sidebar-accent px-8 py-12">
        <div className="w-full max-w-2xl rounded-2xl border border-primary/25 bg-card/55 p-9 text-center shadow-[0_20px_80px_rgba(0,0,0,0.18)]">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-success/35 bg-success/10 text-success">
            <ShieldCheck className="h-8 w-8" />
          </div>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-foreground">
            You&apos;re ready to use Kiyeovo
          </h1>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-muted-foreground">
            Your required network services are configured. You can change providers at any time
            from the Setup tab.
          </p>

          <div className="mx-auto mt-7 grid max-w-lg gap-2 text-left">
            {steps.map((step) => {
              const configured = isConfigured(step.section, readiness);
              return (
                <div
                  key={step.section}
                  className="flex items-center justify-between rounded-lg border border-border bg-background/45 px-4 py-3"
                >
                  <span className="flex items-center gap-3 text-sm text-foreground">
                    {configured ? (
                      <CheckCircle2 className="h-4 w-4 text-success" />
                    ) : (
                      <Circle className="h-4 w-4 text-muted-foreground" />
                    )}
                    {step.title}
                  </span>
                  <span className={`text-xs ${configured ? 'text-success' : 'text-muted-foreground'}`}>
                    {configured ? 'Configured' : step.optional ? 'Skipped' : 'Not configured'}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="mt-8 flex items-center justify-center gap-3">
            <Button variant="outline" onClick={handleBack} disabled={saving}>
              <ArrowLeft />
              Back
            </Button>
            <Button onClick={() => { void onFinish(); }} disabled={saving}>
              <MessageSquare />
              {saving ? 'Saving...' : 'Start chatting'}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const activeConfigured = readiness
    ? isConfigured(activeStep.section, readiness)
    : false;
  const requiredComplete = readiness ? requiredSetupComplete(readiness) : false;
  const earlierRequiredComplete = readiness
    ? activeSection === 'bootstrap'
      || (
        readiness.bootstrap === 'configured'
        && (activeSection !== 'ice' || readiness.relay === 'configured')
      )
    : false;
  const canContinue = readiness !== null && (
    activeSection === 'bootstrap'
      ? readiness.bootstrap === 'configured'
      : requiredComplete
  );
  const continueLabel = !earlierRequiredComplete
    ? 'Complete required steps'
    : activeStep.section === 'ice' && !activeConfigured
      ? 'Finish without calls'
      : activeStepIndex === steps.length - 1
        ? 'Finish setup'
        : 'Continue';

  return (
    <div className="flex h-full flex-col bg-sidebar-accent">
      <div className="shrink-0 border-b border-sidebar-border bg-background/55 px-6 py-4 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-6">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-left">
              <Network className="h-4 w-4 text-primary" />
              <span className="text-xs font-mono uppercase tracking-widest text-primary">
                Guided setup
              </span>
            </div>

            <div className="mt-3 flex items-center">
              {steps.map((step, index) => {
                const configured = readiness ? isConfigured(step.section, readiness) : false;
                const active = step.section === activeSection;

                return (
                  <div key={step.section} className="flex min-w-0 flex-1 items-center">
                    <button
                      type="button"
                      onClick={() => onSelectSection(step.section)}
                      disabled={saving}
                      aria-current={active ? 'step' : undefined}
                      aria-label={`${step.title} setup${step.optional ? ', optional' : ''}${configured ? ', configured' : ''}`}
                      className="group flex min-w-0 cursor-pointer items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs ${
                          configured
                            ? 'border-success/45 bg-success/10 text-success'
                            : active
                              ? 'border-primary bg-primary/15 text-primary'
                              : 'border-border text-muted-foreground group-hover:border-primary/50 group-hover:text-foreground'
                        }`}
                      >
                        {configured ? <Check className="h-3.5 w-3.5" /> : index + 1}
                      </span>
                      <span className="min-w-0">
                        <span className={`block truncate text-xs font-medium transition-colors ${active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'}`}>
                          {step.title}
                        </span>
                        {step.optional && (
                          <span className="block text-[10px] text-muted-foreground">Optional</span>
                        )}
                      </span>
                    </button>
                    {index < steps.length - 1 && (
                      <span className="mx-3 h-px min-w-4 flex-1 bg-border" aria-hidden />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 border-l border-border pl-5">
            <button
              type="button"
              onClick={() => setShowSkipConfirm(true)}
              disabled={saving}
              className="mr-1 cursor-pointer text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Skip setup
            </button>
            {activeStepIndex > 0 && (
              <Button variant="ghost" size="sm" onClick={handleBack} disabled={saving}>
                <ArrowLeft />
                Back
              </Button>
            )}
            <Button size="sm" onClick={handleContinue} disabled={!canContinue || saving}>
              {continueLabel}
              <ArrowRight />
            </Button>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1">{children}</div>

      <SkipSetupConfirmDialog
        open={showSkipConfirm}
        onOpenChange={setShowSkipConfirm}
        onConfirm={onSkip}
        saving={saving}
      />
    </div>
  );
}
