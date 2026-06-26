import React, { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../ui/Button';
import { FolderOpen, X } from 'lucide-react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../../../state/store';
import type { FileTransferStatus } from '../../../../core/types';
import { isImageFile } from '../../../../shared/file-types';
import { setPendingFileStatus, updateFileTransferStatus } from '../../../state/slices/chatSlice';
import { highlightText } from '../../../utils/highlightText';
import { ImagePreviewDialog } from './ImagePreviewDialog';

interface FileMessageProps {
  fileId: string;
  chatId: number;
  fileName: string;
  searchQuery?: string;
  fileSize: number;
  filePath?: string;
  previewMediaToken?: string;
  transferStatus: FileTransferStatus;
  transferProgress?: number;
  transferError?: string;
  transferExpiresAt?: number;
  isFromCurrentUser: boolean;
}

interface InlineImageMessageProps {
  fileId: string;
  fileName: string;
  fileSizeText: string;
  searchQuery?: string;
  initialMediaToken?: string;
  canOpenFile: boolean;
  onOpenFile: () => Promise<void>;
  statusContent?: ReactNode;
  fallback: ReactNode;
}

const InlineImageMessage: React.FC<InlineImageMessageProps> = ({
  fileId,
  fileName,
  fileSizeText,
  searchQuery,
  initialMediaToken,
  canOpenFile,
  onOpenFile,
  statusContent,
  fallback,
}) => {
  const [mediaToken, setMediaToken] = useState<string | null>(initialMediaToken ?? null);
  const [imageFailed, setImageFailed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    if (initialMediaToken) return;

    let cancelled = false;

    void window.kiyeovoAPI.registerMessageMedia(fileId)
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.token) {
          setMediaToken(result.token);
          return;
        }
        setImageFailed(true);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Failed to register inline image:', error);
        setImageFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [fileId, initialMediaToken]);

  if (!mediaToken || imageFailed) {
    return fallback;
  }

  const mediaUrl = `kiyeovo-media://media/${encodeURIComponent(mediaToken)}`;

  return (
    <>
      <div className="flex w-[320px] max-w-[65vw] flex-col gap-2">
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          className="flex max-h-[320px] w-full cursor-pointer items-center justify-center overflow-hidden rounded-lg bg-background/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Preview ${fileName}`}
          title="View full size"
        >
          <img
            src={mediaUrl}
            alt={fileName}
            className="block max-h-[320px] max-w-full object-contain"
            onError={() => setImageFailed(true)}
          />
        </button>
        <div className="flex min-w-0 items-center gap-2 text-left">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{highlightText(fileName, searchQuery)}</p>
            <p className="text-xs opacity-70">{fileSizeText}</p>
          </div>
          {canOpenFile && (
            <Button
              onClick={() => void onOpenFile()}
              variant="outline"
              size="icon"
              className="shrink-0"
              aria-label={`Show ${fileName} in folder`}
              title="Show in folder"
            >
              <FolderOpen className="w-4 h-4" />
            </Button>
          )}
        </div>
        {statusContent}
      </div>
      <ImagePreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        mediaUrl={mediaUrl}
        fileName={fileName}
        canOpenFile={canOpenFile}
        onOpenFile={onOpenFile}
      />
    </>
  );
};

export const FileMessage: React.FC<FileMessageProps> = ({
  fileId,
  chatId,
  fileName,
  searchQuery,
  fileSize,
  filePath,
  previewMediaToken,
  transferStatus,
  transferProgress = 0,
  transferError,
  transferExpiresAt,
  isFromCurrentUser
}) => {
  const dispatch = useDispatch();
  const messages = useSelector((state: RootState) => state.chat.messages);
  const isAwaitingApproval =
    transferStatus === 'awaiting_acceptance' ||
    (transferStatus === 'pending' && isFromCurrentUser);
  const isIncomingPendingDecision =
    transferStatus === 'incoming_pending_user' ||
    (transferStatus === 'pending' && !isFromCurrentUser);
  const showsDecisionDeadline = isAwaitingApproval || isIncomingPendingDecision;
  const [timeLeftMs, setTimeLeftMs] = useState(() => {
    if (showsDecisionDeadline && transferExpiresAt) {
      return Math.max(0, transferExpiresAt - Date.now());
    }
    return 0;
  });
  const [isCancelling, setIsCancelling] = useState(false);

  useEffect(() => {
    if (!showsDecisionDeadline || !transferExpiresAt) {
      return;
    }

    const tick = () => {
      const remaining = Math.max(0, transferExpiresAt - Date.now());
      setTimeLeftMs(remaining);
      if (remaining === 0 && isIncomingPendingDecision) {
        dispatch(updateFileTransferStatus({
          messageId: fileId,
          status: 'expired',
          transferError: 'Offer expired'
        }));
        const hasOtherPending = messages.some(
          (m) =>
            m.chatId === chatId &&
            m.id !== fileId &&
            (m.transferStatus === 'incoming_pending_user' || m.transferStatus === 'pending'),
        );
        dispatch(setPendingFileStatus({ chatId, hasPendingFile: hasOtherPending }));
      }
    };

    tick();
    const intervalId = setInterval(tick, 1000);
    return () => clearInterval(intervalId);
  }, [showsDecisionDeadline, transferExpiresAt, isIncomingPendingDecision, fileId, chatId, messages, dispatch]);

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const formatTimeLeft = (ms: number): string => {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleAccept = async () => {
    try {
      const result = await window.kiyeovoAPI.acceptFile(fileId);
      if (result.success) {
        dispatch(updateFileTransferStatus({
          messageId: fileId,
          status: 'in_progress'
        }));
        const hasOtherPending = messages.some(
          (m) =>
            m.chatId === chatId &&
            m.id !== fileId &&
            (m.transferStatus === 'incoming_pending_user' || m.transferStatus === 'pending'),
        );
        dispatch(setPendingFileStatus({ chatId, hasPendingFile: hasOtherPending }));
      } else {
        console.error('Failed to accept file:', result.error);
      }
    } catch (error) {
      console.error('Error accepting file:', error);
    }
  };

  const handleReject = async () => {
    try {
      const result = await window.kiyeovoAPI.rejectFile(fileId);
      if (result.success) {
        dispatch(updateFileTransferStatus({
          messageId: fileId,
          status: 'rejected',
          transferError: 'Offer rejected'
        }));
        const hasOtherPending = messages.some(
          (m) =>
            m.chatId === chatId &&
            m.id !== fileId &&
            (m.transferStatus === 'incoming_pending_user' || m.transferStatus === 'pending'),
        );
        dispatch(setPendingFileStatus({ chatId, hasPendingFile: hasOtherPending }));
      } else {
        console.error('Failed to reject file:', result.error);
      }
    } catch (error) {
      console.error('Error rejecting file:', error);
    }
  };

  const handleCancelDownload = async () => {
    if (isCancelling) return;

    setIsCancelling(true);
    try {
      const result = await window.kiyeovoAPI.cancelFileDownload(fileId);
      if (!result.success) {
        console.error('Failed to cancel file download:', result.error);
        return;
      }

      dispatch(updateFileTransferStatus({
        messageId: fileId,
        status: 'failed',
        transferError: 'Download canceled by user'
      }));
    } catch (error) {
      console.error('Error canceling file download:', error);
    } finally {
      setIsCancelling(false);
    }
  };

  const handleOpenFile = async () => {
    if (filePath && transferStatus === 'completed') {
      const result = await window.kiyeovoAPI.openFileLocation(filePath);
      if (!result.success) {
        console.error('Failed to open file location:', result.error);
      }
    }
  };

  const getStatusText = () => {
    switch (transferStatus) {
      case 'connecting':
        return 'Connecting...';
      case 'awaiting_acceptance':
        return 'Waiting for approval';
      case 'incoming_pending_user':
        return 'Waiting for your decision';
      case 'pending':
        return isFromCurrentUser ? 'Waiting for approval' : 'Waiting for your decision';
      case 'in_progress':
        if (isFromCurrentUser && transferProgress >= 100) {
          return 'Awaiting recipient confirmation';
        }
        return `${transferProgress}%`;
      case 'completed':
        return 'Completed';
      case 'failed':
        return 'Failed';
      case 'expired':
        return 'Offer expired';
      case 'rejected':
        return 'Offer rejected';
      default:
        return '';
    }
  };

  const getIcon = () => {
    const extension = fileName.split('.').pop()?.toLowerCase();

    const iconMap: Record<string, string> = {
      pdf: '📄',
      doc: '📝',
      docx: '📝',
      txt: '📝',
      jpg: '🖼️',
      jpeg: '🖼️',
      png: '🖼️',
      gif: '🖼️',
      mp4: '🎬',
      mp3: '🎵',
      zip: '📦',
      rar: '📦',
    };

    return iconMap[extension || ''] || '📎';
  };

  const specificErrorText = () => {
    if (transferError?.includes('dial request has no valid addresses')) {
      return 'User offline or not reachable';
    }
    if (transferError?.toLowerCase().includes('download canceled by user')) {
      return 'Download canceled';
    }
    return transferError;
  };

  const transferStatusContent = (
    <>
      {transferStatus === 'in_progress' && (
        <div className="w-full">
          <div className="flex items-center gap-2">
            <div className="flex-1 bg-background/20 rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-primary h-full transition-all duration-300"
                style={{ width: `${transferProgress}%` }}
              />
            </div>
            {!isFromCurrentUser && (
              <Button
                onClick={handleCancelDownload}
                variant="ghost"
                size="icon"
                className="h-6 w-6 p-0 shrink-0"
                title="Cancel download"
                aria-label="Cancel download"
                disabled={isCancelling}
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
          <p className="text-xs opacity-70 mt-1">{getStatusText()}</p>
        </div>
      )}

      {transferStatus === 'failed' && (
        <div className="text-xs">
          {specificErrorText() || 'Transfer failed'}
        </div>
      )}

      {(transferStatus === 'expired' || transferStatus === 'rejected') && (
        <div className="text-xs opacity-70">
          {getStatusText()}
        </div>
      )}

      {transferStatus === 'connecting' && (
        <div className="text-xs opacity-70">
          {getStatusText()}
        </div>
      )}

      {showsDecisionDeadline && (
        <div className="text-xs opacity-70">
          <div>{getStatusText()}</div>
          {transferExpiresAt && (
            <div>Expires in {formatTimeLeft(timeLeftMs)}</div>
          )}
        </div>
      )}

      {isIncomingPendingDecision && (
        <div className="flex gap-2">
          <Button
            onClick={handleAccept}
            size="sm"
            className="flex-1"
          >
            Accept
          </Button>
          <Button
            onClick={handleReject}
            size="sm"
            variant="outline"
            className="flex-1"
          >
            Reject
          </Button>
        </div>
      )}
    </>
  );

  const fileCard = (
    <div className="flex flex-col gap-2 w-[250px]">
      <div className="flex items-center justify-between gap-3">
        <div className={`text-2xl ${isFromCurrentUser ? 'bg-background/50' : ''} rounded-md p-1`}>{getIcon()}</div>
        <div className="flex-1 min-w-0 text-left">
          <p className="text-sm font-medium truncate" title={fileName}>{highlightText(fileName, searchQuery)}</p>
          <p className="text-xs opacity-70">{formatFileSize(fileSize)}</p>
        </div>
        {transferStatus === 'completed' && !!filePath ? (
          <Button
            onClick={handleOpenFile}
            variant="outline"
            size="icon"
          >
            <FolderOpen className="w-4 h-4" />
          </Button>
        ) : <div />}
      </div>
      {transferStatusContent}
    </div>
  );

  const isImage = isImageFile(fileName);
  const hasSenderPreview =
    isImage &&
    isFromCurrentUser &&
    !!previewMediaToken;
  const hasCompletedImage =
    isImage &&
    transferStatus === 'completed' &&
    !!filePath;

  if (hasSenderPreview || hasCompletedImage) {
    return (
      <InlineImageMessage
        key={`${fileId}:${previewMediaToken ?? filePath}`}
        fileId={fileId}
        fileName={fileName}
        fileSizeText={formatFileSize(fileSize)}
        searchQuery={searchQuery}
        initialMediaToken={hasSenderPreview ? previewMediaToken : undefined}
        canOpenFile={transferStatus === 'completed' && !!filePath}
        onOpenFile={handleOpenFile}
        statusContent={transferStatusContent}
        fallback={fileCard}
      />
    );
  }

  return fileCard;
};
