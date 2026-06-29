import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSelector } from 'react-redux';
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
import type { RootState } from '../../../state/store';
import { Button } from '../../ui/Button';
import { SkipSetupConfirmDialog } from './SkipSetupConfirmDialog';
import { WizardRegisterStep } from './WizardRegisterStep';
import type { SetupSection } from '../navigation';

type WizardStepId = SetupSection | 'register';

type WizardStep = {
  id: WizardStepId;
  title: string;
  optional?: boolean;
};

const FAST_STEPS: WizardStep[] = [
  { id: 'bootstrap', title: 'Bootstrap' },
  { id: 'relay', title: 'Relay' },
  { id: 'register', title: 'Register', optional: true },
  { id: 'ice', title: 'Calls', optional: true },
];

const ANONYMOUS_STEPS: WizardStep[] = [
  { id: 'bootstrap', title: 'Bootstrap' },
  { id: 'register', title: 'Register', optional: true },
];

function isStepConfigured(step: WizardStep, readiness: SetupReadiness, registered: boolean): boolean {
  if (step.id === 'register') {
    return registered;
  }
  return readiness[step.id] === 'configured';
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
  const registered = useSelector((state: RootState) => state.user.registered);
  const registrationInProgress = useSelector((state: RootState) => state.user.registrationInProgress);
  const [initialUserRegistered, setInitialUserRegistered] = useState<boolean | null>(null);
  const [showingReady, setShowingReady] = useState(false);
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);
  // `register` is a wizard-local step layered on top of the network step driven by `activeSection`.
  const [registerActive, setRegisterActive] = useState(false);
  const steps = readiness?.mode === 'anonymous' ? ANONYMOUS_STEPS : FAST_STEPS;
  const activeStepId: WizardStepId = registerActive ? 'register' : activeSection;
  const activeStepIndex = Math.max(0, steps.findIndex((step) => step.id === activeStepId));
  const activeStep = steps[activeStepIndex]!;
  const registrationStateKnown = initialUserRegistered !== null || registered;
  const registeredForWizard = registered || initialUserRegistered === true;

  useEffect(() => {
    let disposed = false;
    void window.kiyeovoAPI.getUserState()
      .then((userState) => {
        if (!disposed) {
          setInitialUserRegistered(userState.isRegistered);
        }
      })
      .catch((error) => {
        console.error('[InitialSetupWizard] Failed to load user state:', error);
        if (!disposed) {
          setInitialUserRegistered(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, []);

  // Resume lands on a network section
  const initialStepDecidedRef = useRef(false);
  useEffect(() => {
    if (initialStepDecidedRef.current || !readiness || !registrationStateKnown) return;
    initialStepDecidedRef.current = true;
    if (requiredSetupComplete(readiness) && !registeredForWizard) {
      setRegisterActive(true);
    }
  }, [readiness, registeredForWizard, registrationStateKnown]);

  const goToStep = (step: WizardStep) => {
    if (step.id === 'register') {
      setRegisterActive(true);
      return;
    }
    setRegisterActive(false);
    onSelectSection(step.id);
  };

  // Lock wizard navigation while a registration triggered from the Register step is in flight
  const navLocked = saving || registrationInProgress;
  const requiredComplete = readiness ? requiredSetupComplete(readiness) : false;
  const canContinue = readiness !== null && (
    activeStepId === 'bootstrap'
      ? readiness.bootstrap === 'configured'
      : requiredComplete
  );

  const handleContinue = () => {
    if (!readiness || !canContinue) return;

    const nextIndex = activeStepIndex + 1;
    if (nextIndex >= steps.length) {
      setShowingReady(true);
      return;
    }
    goToStep(steps[nextIndex]!);
  };

  const handleBack = () => {
    if (showingReady) {
      setShowingReady(false);
      return;
    }
    const prevIndex = activeStepIndex - 1;
    if (prevIndex < 0) return;
    goToStep(steps[prevIndex]!);
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
              const configured = isStepConfigured(step, readiness, registeredForWizard);
              return (
                <div
                  key={step.id}
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
    ? isStepConfigured(activeStep, readiness, registeredForWizard)
    : false;
  const isLastStep = activeStepIndex === steps.length - 1;
  const continueLabel = !canContinue
    ? 'Complete required steps'
    : isLastStep
      ? (activeStep.optional && !activeConfigured
          ? (activeStep.id === 'register' ? 'Finish without registering' : 'Finish without calls')
          : 'Finish setup')
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
                const configured = readiness ? isStepConfigured(step, readiness, registeredForWizard) : false;
                const active = step.id === activeStepId;

                return (
                  <div key={step.id} className="flex min-w-0 flex-1 items-center">
                    <button
                      type="button"
                      onClick={() => goToStep(step)}
                      disabled={navLocked}
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
              disabled={navLocked}
              className="mr-1 cursor-pointer text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Skip setup
            </button>
            {activeStepIndex > 0 && (
              <Button variant="ghost" size="sm" onClick={handleBack} disabled={navLocked}>
                <ArrowLeft />
                Back
              </Button>
            )}
            <Button size="sm" onClick={handleContinue} disabled={!canContinue || navLocked}>
              {continueLabel}
              <ArrowRight />
            </Button>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {activeStepId === 'register' ? <WizardRegisterStep /> : children}
      </div>

      <SkipSetupConfirmDialog
        open={showSkipConfirm}
        onOpenChange={setShowSkipConfirm}
        onConfirm={onSkip}
        saving={saving}
      />
    </div>
  );
}
