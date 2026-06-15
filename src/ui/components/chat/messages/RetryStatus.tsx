import { useEffect, useMemo, useState } from "react";
import type { ChatMessage } from "../../../state/slices/chatSlice";

type RetryStatusProps = {
  message: ChatMessage;
  onRetry: (message: ChatMessage) => void;
};

export const RetryStatus = ({ message, onRetry }: RetryStatusProps) => {
  const [nowTs, setNowTs] = useState(Date.now());

  const retryState = useMemo(() => {
    if (message.localSendState !== 'failed') return null;

    const isRekeyFailure = message.failedReason === 'group_rekeying';
    const isBackupFailure = message.failedReason === 'offline_backup';
    const retryAfterTs = message.retryAfterTs ?? 0;
    const rekeyRetryRemainingMs = isRekeyFailure
      ? Math.max(0, retryAfterTs - nowTs)
      : 0;
    const isRetryBlocked = rekeyRetryRemainingMs > 0;

    return {
      isRetryBlocked,
      isBackupFailure,
      rekeyRetryRemainingMs,
    };
  }, [message.localSendState, message.failedReason, message.retryAfterTs, nowTs]);

  useEffect(() => {
    if (!retryState?.isRetryBlocked) return;
    const timer = setInterval(() => {
      setNowTs(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [retryState?.isRetryBlocked]);

  if (!retryState) return null;

  return (
    <>
      {retryState.isRetryBlocked
        ? ` • Group membership updating (${Math.ceil(retryState.rekeyRetryRemainingMs / 1000)}s)`
        : retryState.isBackupFailure
          ? " • Delivered online · offline backup failed"
          : " • Failed to send"}
      <span>•</span>
      <button
        type="button"
        className="underline underline-offset-2 hover:text-foreground"
        disabled={retryState.isRetryBlocked}
        title={retryState.isRetryBlocked
          ? 'Group is rekeying. Retry is temporarily disabled to avoid fallback-only delivery.'
          : retryState.isBackupFailure
            ? 'Online members already received this. Retry only re-stores the offline backup.'
            : undefined}
        onClick={() => { onRetry(message); }}
      >
        {retryState.isRetryBlocked
          ? `Retry in ${Math.ceil(retryState.rekeyRetryRemainingMs / 1000)}s`
          : retryState.isBackupFailure ? 'Retry offline backup' : 'Retry'}
      </button>
    </>
  );
};
