import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Settings, ChevronDown, ChevronUp, Save, RotateCcw } from 'lucide-react';
import { useToast } from '../../ui/use-toast';
import { useAppDispatch, useAppSelector } from '../../../state/hooks';
import { saveAppConfig } from '../../../state/slices/appConfigSlice';
import { errStr } from '../../../../core/utils/general-error';
import {
  CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES,
  KEY_EXCHANGE_RATE_LIMIT_DEFAULT,
  OFFLINE_MESSAGE_LIMIT,
  MAX_FILE_SIZE,
  FILE_OFFER_RATE_LIMIT,
  MAX_PENDING_FILES_PER_PEER,
  MAX_PENDING_FILES_TOTAL,
  SILENT_REJECTION_THRESHOLD_GLOBAL,
  SILENT_REJECTION_THRESHOLD_PER_PEER,
} from '../../../constants';

interface ConfigurationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface AppConfig {
  chatsToCheckForOfflineMessages: number;
  keyExchangeRateLimit: number;
  offlineMessageLimit: number;
  maxFileSize: number;
  fileOfferRateLimit: number;
  maxPendingFilesPerPeer: number;
  maxPendingFilesTotal: number;
  silentRejectionThresholdGlobal: number;
  silentRejectionThresholdPerPeer: number;
}

const DEFAULT_CONFIG: AppConfig = {
  chatsToCheckForOfflineMessages: CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES,
  keyExchangeRateLimit: KEY_EXCHANGE_RATE_LIMIT_DEFAULT,
  offlineMessageLimit: OFFLINE_MESSAGE_LIMIT,
  maxFileSize: MAX_FILE_SIZE,
  fileOfferRateLimit: FILE_OFFER_RATE_LIMIT,
  maxPendingFilesPerPeer: MAX_PENDING_FILES_PER_PEER,
  maxPendingFilesTotal: MAX_PENDING_FILES_TOTAL,
  silentRejectionThresholdGlobal: SILENT_REJECTION_THRESHOLD_GLOBAL,
  silentRejectionThresholdPerPeer: SILENT_REJECTION_THRESHOLD_PER_PEER,
};

export function ConfigurationDialog({ open, onOpenChange }: ConfigurationDialogProps) {
  const dispatch = useAppDispatch();
  const appConfig = useAppSelector((state) => state.appConfig.config);
  const saving = useAppSelector((state) => state.appConfig.saving);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    setConfig(appConfig);
  }, [open, appConfig]);

  const handleSave = async () => {
    try {
      await dispatch(saveAppConfig(config)).unwrap();
      toast.success('Configuration saved successfully');
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to save configuration:', error);
      toast.error(errStr(error, 'Failed to save configuration'));
    }
  };

  const handleReset = () => {
    setConfig(DEFAULT_CONFIG);
  };

  const parseFileSize = (value: string): number => {
    const mb = parseInt(value, 10);
    return isNaN(mb) ? DEFAULT_CONFIG.maxFileSize : mb * 1024 * 1024;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5" />
            Configuration
          </DialogTitle>
          <DialogDescription>
            Customize application behavior and performance settings
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-6 max-h-[60vh] overflow-y-auto">
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
              Basic Settings
            </h3>

            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">Maximum File Size (MB)</label>
              <Input
                type="number"
                min="1"
                max="512"
                value={Math.round(config.maxFileSize / (1024 * 1024))}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    maxFileSize: parseFileSize(e.target.value),
                  })
                }
              />
              <p className="text-xs text-muted-foreground">
                Maximum file size you can receive (1-512 MB)
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">Chats to Check on Startup</label>
              <Input
                type="number"
                min="1"
                max="50"
                value={config.chatsToCheckForOfflineMessages}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    chatsToCheckForOfflineMessages: parseInt(e.target.value, 10) || 1,
                  })
                }
              />
              <p className="text-xs text-muted-foreground">
                How many chats to check for offline messages on startup. Higher values can slow startup. (1-50)
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">Offline Message Limit</label>
              <Input
                type="number"
                min="10"
                max="500"
                value={config.offlineMessageLimit}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    offlineMessageLimit: parseInt(e.target.value, 10) || 10,
                  })
                }
              />
              <p className="text-xs text-muted-foreground">
                Maximum number of offline messages to store per chat (10-500)
              </p>
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <span className="font-semibold uppercase tracking-wider">Advanced Settings</span>
              {showAdvanced ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </button>
          </div>

          {/* Advanced Settings */}
          <div
            className={`overflow-hidden transition-all duration-300 ease-in-out ${
              showAdvanced ? 'max-h-[800px] opacity-100' : 'max-h-0 opacity-0'
            }`}
          >
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">
                  Contact Request Rate Limit
                </label>
                <Input
                  type="number"
                  min="1"
                  max="100"
                  value={config.keyExchangeRateLimit}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      keyExchangeRateLimit: parseInt(e.target.value, 10) || 1,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Maximum number of contact requests to accept per 5 minutes (1-100)
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">File Offer Rate Limit</label>
                <Input
                  type="number"
                  min="1"
                  max="20"
                  value={config.fileOfferRateLimit}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      fileOfferRateLimit: parseInt(e.target.value, 10) || 1,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Maximum file offers to accept from the same peer per minute (1-20)
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">
                  Maximum Pending Files per Peer
                </label>
                <Input
                  type="number"
                  min="1"
                  max="20"
                  value={config.maxPendingFilesPerPeer}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      maxPendingFilesPerPeer: parseInt(e.target.value, 10) || 1,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Maximum pending file offers per peer (1-20)
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">Maximum Total Pending Files</label>
                <Input
                  type="number"
                  min="1"
                  max="50"
                  value={config.maxPendingFilesTotal}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      maxPendingFilesTotal: parseInt(e.target.value, 10) || 1,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Maximum total pending file offers globally (1-50)
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">
                  Silent Rejection Threshold (Global)
                </label>
                <Input
                  type="number"
                  min="1"
                  max="100"
                  value={config.silentRejectionThresholdGlobal}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      silentRejectionThresholdGlobal: parseInt(e.target.value, 10) || 1,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  After N global rejections, stop responding to save bandwidth (1-100)
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm text-muted-foreground">
                  Silent Rejection Threshold (Per Peer)
                </label>
                <Input
                  type="number"
                  min="1"
                  max="50"
                  value={config.silentRejectionThresholdPerPeer}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      silentRejectionThresholdPerPeer: parseInt(e.target.value, 10) || 1,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  After N rejections to same peer, stop responding to save bandwidth (1-50)
                </p>
              </div>
            </div>
          </div>
        </DialogBody>

        <DialogFooter className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleReset}
            disabled={saving}
            className="flex-1"
          >
            <RotateCcw className="w-4 h-4" />
            Reset to Defaults
          </Button>
          <Button onClick={handleSave} disabled={saving} className="flex-1">
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save Configuration'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
