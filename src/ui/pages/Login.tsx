import { useState, useEffect, useRef } from "react";
import type { PasswordRequest } from "../types";
import { PasswordPrompt } from "../components/login/PasswordPrompt";
import { Logo } from "../components/icons/Logo";
import { DEFAULT_NETWORK_MODE, NETWORK_MODES } from "../../core/constants";
import type { NetworkMode } from "../../core/types";
import { NetworkModeSelector } from "../components/login/NetworkModeSelector";
import { errStr } from '../../core/utils/general-error';

function isDuplicatePasswordRequest(a: PasswordRequest | null, b: PasswordRequest): boolean {
    if (!a) return false;
    return (
        a.prompt === b.prompt &&
        a.isNewPassword === b.isNewPassword &&
        a.recoveryPhrase === b.recoveryPhrase &&
        a.prefilledPassword === b.prefilledPassword &&
        a.errorMessage === b.errorMessage &&
        a.cooldownSeconds === b.cooldownSeconds &&
        a.cooldownUntil === b.cooldownUntil &&
        a.showRecoveryOption === b.showRecoveryOption &&
        a.keychainAvailable === b.keychainAvailable
    );
}

type LoginProps = {
    initStatus: string;
}

function isTorStartupFailureStatus(status: string): boolean {
    const normalized = status.toLowerCase();
    const mentionsAnonymous = normalized.includes('anonymous mode');
    const mentionsTor = normalized.includes('tor');
    const isStartupFailure =
        normalized.includes('tor failed to start')
        || normalized.includes('anonymous mode cannot continue')
        || normalized.includes('anonymous mode requires tor startup')
        || normalized.includes('initialization aborted');
    return mentionsAnonymous && mentionsTor && isStartupFailure;
}

export const Login = ({ initStatus }: LoginProps) => {
    const [passwordRequest, setPasswordRequest] = useState<PasswordRequest | null>(null);
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [rememberMe, setRememberMe] = useState(false)
    const [networkMode, setNetworkMode] = useState<NetworkMode>(DEFAULT_NETWORK_MODE);
    const [isModeLoading, setIsModeLoading] = useState(true);
    const [isModeSaving, setIsModeSaving] = useState(false);
    const [modeError, setModeError] = useState<string | null>(null);
    const [isSwitchingMode, setIsSwitchingMode] = useState(false);
    const [requiresNetworkModeSelection, setRequiresNetworkModeSelection] = useState(false);
    const previousPasswordRequestRef = useRef<PasswordRequest | null>(null);
    const isTorStartupFailure = isTorStartupFailureStatus(initStatus);

    useEffect(() => {
        let isMounted = true;

        const loadNetworkMode = async () => {
            try {
                const result = await window.kiyeovoAPI.getNetworkMode();
                if (!isMounted) return;
                if (result.success) {
                    setNetworkMode(result.mode);
                    setModeError(null);
                } else {
                    setModeError(result.error || 'Failed to load network mode');
                }
            } catch (error) {
                if (!isMounted) return;
                setModeError(errStr(error, 'Failed to load network mode'));
            } finally {
                if (isMounted) {
                    setIsModeLoading(false);
                }
            }
        };

        const restorePendingPasswordRequest = async () => {
            try {
                const initState = await window.kiyeovoAPI.getInitState();
                if (!isMounted) return;
                setRequiresNetworkModeSelection(Boolean(initState.requiresNetworkModeSelection));
                if (initState.pendingPasswordRequest) {
                    setPasswordRequest(initState.pendingPasswordRequest);
                    previousPasswordRequestRef.current = initState.pendingPasswordRequest;
                    setIsSubmitting(false);
                }
            } catch {
                // ignore and rely on live password events
            }
        };
        void loadNetworkMode();
        void restorePendingPasswordRequest();

        const unsubscribe = window.kiyeovoAPI.onPasswordRequest((request) => {
            const previousRequest = previousPasswordRequestRef.current;
            const modeChanged = previousRequest?.isNewPassword !== request.isNewPassword;
            const isRetryWithError = Boolean(request.errorMessage);
            const isDuplicate = isDuplicatePasswordRequest(previousRequest, request);

            // Keep typed password on failed retries and duplicate requests
            // (duplicate = same logical request arriving from both init snapshot + IPC event).
            if ((!isRetryWithError || modeChanged) && !isDuplicate) {
                setPassword('');
                setConfirmPassword('');
            }
            setPasswordRequest(request);
            setIsSubmitting(false);
            previousPasswordRequestRef.current = request;
        });

        return () => {
            isMounted = false;
            unsubscribe();
        };
    }, []);

    const handleNetworkModeChange = async (nextMode: NetworkMode) => {
        if (isModeSaving) {
            return;
        }
        if (!requiresNetworkModeSelection && nextMode === networkMode) {
            return;
        }

        const previousMode = networkMode;
        setNetworkMode(nextMode);
        setIsModeSaving(true);
        setModeError(null);

        try {
            const result = await window.kiyeovoAPI.setNetworkMode(nextMode);
            if (!result.success) {
                setNetworkMode(previousMode);
                setModeError(result.error || 'Failed to save network mode');
                return;
            }

            if (requiresNetworkModeSelection) {
                const initResult = await window.kiyeovoAPI.startInitialization();
                if (!initResult.success) {
                    setModeError(initResult.error || 'Failed to start initialization');
                    setNetworkMode(previousMode);
                    return;
                }
                setRequiresNetworkModeSelection(false);
            }
        } catch (error) {
            setNetworkMode(previousMode);
            setModeError(errStr(error, 'Failed to save network mode'));
        } finally {
            setIsModeSaving(false);
        }
    };

    const handleSwitchNetworkMode = async (targetMode: NetworkMode): Promise<void> => {
        if (isSwitchingMode) return;

        setIsSwitchingMode(true);
        setModeError(null);
        try {
            const setResult = await window.kiyeovoAPI.setNetworkMode(targetMode);
            if (!setResult.success) {
                setModeError(setResult.error || 'Failed to switch network mode');
                setIsSwitchingMode(false);
                return;
            }
            setNetworkMode(targetMode);
            await window.kiyeovoAPI.restartApp();
        } catch (error) {
            setModeError(errStr(error, 'Failed to switch network mode'));
            setIsSwitchingMode(false);
        }
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        setIsSubmitting(true);
        window.kiyeovoAPI.submitPassword(password, rememberMe);
    };

    if (requiresNetworkModeSelection) {
        return <div className="w-full h-full flex justify-center items-center flex-col bg-background cyber-grid">
            <div className={`w-16 h-16 mb-6 rounded-full border ${networkMode === NETWORK_MODES.ANONYMOUS ? "border-[#5a3184] glow-border-tor" : "border-primary/50 glow-border"} flex items-center justify-center`}>
                <Logo version="2" _isTorActive={networkMode === NETWORK_MODES.ANONYMOUS} />
            </div>
            <div className="text-center w-3/4">
                <h1 className="text-xl font-mono font-semibold tracking-wide text-foreground">Choose Network Mode</h1>
                <p className="text-sm text-muted-foreground">Select how Kiyeovo should connect before unlocking your identity.</p>
            </div>
            <div className="flex justify-center flex-col items-center mt-6">
                <NetworkModeSelector
                    loading={isModeLoading}
                    saving={isModeSaving}
                    error={modeError}
                    onChange={handleNetworkModeChange}
                />
            </div>
            <div className="text-xs text-muted-foreground">
                {isModeSaving ? `Applying ${networkMode === NETWORK_MODES.ANONYMOUS ? 'Anonymous' : 'Fast'} mode...` : ''}
            </div>
        </div>;
    }

    return <div className="w-full h-full flex justify-center items-center flex-col bg-background cyber-grid">
        <div className={`w-16 h-16 mb-6 rounded-full border ${networkMode === NETWORK_MODES.ANONYMOUS ? "border-[#5a3184] glow-border-tor" : "border-primary/50 glow-border"} flex items-center justify-center`}>
            <Logo version="2" _isTorActive={networkMode === NETWORK_MODES.ANONYMOUS}/>
        </div>
        {!!passwordRequest ? <PasswordPrompt
            passwordRequest={passwordRequest}
            handleSubmit={handleSubmit}
            password={password}
            setPassword={setPassword}
            confirmPassword={confirmPassword}
            setConfirmPassword={setConfirmPassword}
            rememberMe={rememberMe}
            setRememberMe={setRememberMe}
            isSubmitting={isSubmitting}
            initStatus={initStatus}
            networkMode={networkMode}
            onSwitchNetworkMode={handleSwitchNetworkMode}
            isSwitchingNetworkMode={isSwitchingMode}
            modeSwitchError={modeError}
        />
            : isTorStartupFailure ? (
                <div className="w-96 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-center">
                    <p className="text-sm font-semibold text-destructive">{initStatus}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                        Install Tor dependencies with <div className="font-mono">npm run setup</div> if you want Anonymous mode.
                    </p>
                    <button
                        type="button"
                        disabled={isSwitchingMode}
                        onClick={() => { void handleSwitchNetworkMode(NETWORK_MODES.FAST); }}
                        className="mt-4 cursor-pointer rounded-md border border-primary/40 bg-primary/15 px-3 py-2 text-sm text-primary transition-colors hover:bg-primary/25 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {isSwitchingMode ? 'Switching to Fast Mode...' : 'Switch to Fast Mode'}
                    </button>
                    {modeError ? <p className="mt-2 text-xs text-destructive">{modeError}</p> : null}
                </div>
            ) : <div>{initStatus}</div>}
    </div>
}
