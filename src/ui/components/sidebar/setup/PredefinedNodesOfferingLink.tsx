import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import {
  PREDEFINED_NODES_README_URL,
  PREDEFINED_NODES_EXTERNAL_CONFIRM_TITLE,
  PREDEFINED_NODES_EXTERNAL_CONFIRM_BODY,
  PREDEFINED_NODES_EXTERNAL_CONFIRM_OPEN_LABEL,
  PREDEFINED_NODES_EXTERNAL_CONFIRM_CANCEL_LABEL,
} from '../../../../core/predefined-nodes';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/Dialog';
import { Button } from '../../ui/Button';

/**
 * The predefined-nodes offering link, shared by the Bootstrap / Relay /
 * STUN-TURN setup surfaces (each passes its own per-kind label). Opens the
 * README in the external browser via the window-open allowlist path.
 *
 * `confirmBeforeOpen` (anonymous mode): privacy-sensitive users may not want
 * to leave the app — a github.com page opens in their regular browser,
 * outside Tor — so the click first shows a confirmation dialog instead of
 * opening directly.
 */
export const PredefinedNodesOfferingLink = ({
  label,
  confirmBeforeOpen = false,
}: {
  label: string;
  confirmBeforeOpen?: boolean;
}) => {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const openReadme = () => {
    window.open(PREDEFINED_NODES_README_URL, '_blank', 'noopener,noreferrer');
  };

  return (
    <>
      <a
        href={PREDEFINED_NODES_README_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={confirmBeforeOpen ? (event) => {
          event.preventDefault();
          setConfirmOpen(true);
        } : undefined}
        className="mt-1 inline-flex items-center gap-1.5 text-sm text-primary hover:underline text-left"
      >
        {label}
        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
      </a>

      {confirmBeforeOpen && (
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{PREDEFINED_NODES_EXTERNAL_CONFIRM_TITLE}</DialogTitle>
              <DialogDescription>{PREDEFINED_NODES_EXTERNAL_CONFIRM_BODY}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmOpen(false)}>
                {PREDEFINED_NODES_EXTERNAL_CONFIRM_CANCEL_LABEL}
              </Button>
              <Button
                onClick={() => {
                  setConfirmOpen(false);
                  openReadme();
                }}
              >
                {PREDEFINED_NODES_EXTERNAL_CONFIRM_OPEN_LABEL}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
};
