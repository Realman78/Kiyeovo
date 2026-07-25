import { AlertTriangle, X } from 'lucide-react';
import type { ServerEntryWarning } from '../../../lib/server-entry-warnings';

type ServerEntryWarningRowProps = {
  warning: ServerEntryWarning;
  onDismiss: () => void;
};

// Dismissable, non-blocking hint used across the Bootstrap/Relay/STUN-TURN
// Setup panes — mirrors the amber warning-row visual language used elsewhere
// (e.g. Toast's "warning" variant) plus the compact inline dismiss button
// pattern from OfflineBanner.
export function ServerEntryWarningRow({ warning, onDismiss }: ServerEntryWarningRowProps) {
  return (
    <div
      role="status"
      className="mt-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 leading-5">{warning.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss warning"
        className="shrink-0 rounded p-0.5 transition-colors hover:bg-warning/20"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
