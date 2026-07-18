import React, { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../ui/Button';
import { FolderOpen, Mic, X } from 'lucide-react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../../../state/store';
import type { FileTransferStatus } from '../../../../core/types';
import { isImageFile } from '../../../../shared/file-types';
import { setPendingFileStatus, updateFileTransferStatus } from '../../../state/slices/chatSlice';
import { highlightText } from '../../../utils/highlightText';
import { ImagePreviewDialog } from './ImagePreviewDialog';
import { shouldRenderInlineImage, shouldRenderInlineVoiceNote } from './fileMessageUtils';
import { InlineVoiceNoteMessage } from './VoiceNoteMessage';

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
  fileGroupDownloadTotal?: number;
  fileGroupDownloadCompleted?: number;
  isFromCurrentUser: boolean;
  isVoiceNote?: boolean;
  voiceDurationMs?: number;
}

function formatVoiceNoteDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '--:--';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

interface InlineImageMessageProps {
  fileId: string;
  fileName: string;
  fileSizeText: string;
  searchQuery?: string;
  initialMediaToken?: string;
  canOpenFile: boolean;
  onOpenFile: () => Promise<void>;
  canCopyImage: boolean;
  onCopyImage: () => Promise<boolean>;
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
  canCopyImage,
  onCopyImage,
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
        canCopyImage={canCopyImage}
        onCopyImage={onCopyImage}
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
  fileGroupDownloadTotal,
  fileGroupDownloadCompleted,
  isFromCurrentUser,
  isVoiceNote,
  voiceDurationMs,
}) => {
  const dispatch = useDispatch();
  const messages = useSelector((state: RootState) => state.chat.messages);
  const chat = useSelector((state: RootState) => state.chat.chats.find((item) => item.id === chatId));
  const isGroupChat = chat?.type === 'group';
  const isAwaitingApproval = transferStatus === 'awaiting_acceptance';
  const isIncomingPendingDecision = transferStatus === 'incoming_pending_user';
  const isOutgoingPendingOffer = isFromCurrentUser && isAwaitingApproval;
  const isGroupSenderOffer = isFromCurrentUser
    && isGroupChat
    && fileGroupDownloadTotal !== undefined
    && fileGroupDownloadTotal > 0;
  const showsDecisionStatus = isAwaitingApproval || isIncomingPendingDecision;
  const showsGroupSenderStandaloneStatus = isGroupSenderOffer
    && (
      transferStatus === 'in_progress'
      || transferStatus === 'completed'
      || transferStatus === 'partially_completed'
      || transferStatus === 'cancelled'
    );
  const [isCancelling, setIsCancelling] = useState(false);

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
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
            m.transferStatus === 'incoming_pending_user',
        );
        dispatch(setPendingFileStatus({ chatId, hasPendingFile: hasOtherPending }));
      } else {
        console.error('Failed to accept file:', result.error);
        dispatch(updateFileTransferStatus({
          messageId: fileId,
          status: 'incoming_pending_user',
          transferError: result.error || 'Failed to accept file'
        }));
      }
    } catch (error) {
      console.error('Error accepting file:', error);
      dispatch(updateFileTransferStatus({
        messageId: fileId,
        status: 'incoming_pending_user',
        transferError: error instanceof Error ? error.message : 'Failed to accept file'
      }));
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
            m.transferStatus === 'incoming_pending_user',
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

  const handleCancelOffer = async () => {
    if (isCancelling) return;

    setIsCancelling(true);
    try {
      const result = await window.kiyeovoAPI.cancelFileOffer(fileId);
      if (!result.success) {
        console.error('Failed to cancel file offer:', result.error);
        return;
      }
    } catch (error) {
      console.error('Error canceling file offer:', error);
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

  const canCopyImage = isImageFile(fileName) && transferStatus === 'completed' && !!filePath;

  const handleCopyImage = async (): Promise<boolean> => {
    if (!canCopyImage) return false;

    try {
      const result = await window.kiyeovoAPI.copyImageToClipboard(fileId);
      if (!result.success) {
        console.error('Failed to copy image:', result.error);
        return false;
      }
      return true;
    } catch (error) {
      console.error('Error copying image:', error);
      return false;
    }
  };

  const getStatusText = () => {
    if (isGroupSenderOffer) {
      if (transferStatus === 'completed') {
        return 'Completed';
      }
      if (transferStatus === 'cancelled') {
        return 'Cancelled';
      }
      if (
        transferStatus === 'awaiting_acceptance'
        || transferStatus === 'in_progress'
        || transferStatus === 'partially_completed'
      ) {
        const completed = Math.max(0, Math.min(fileGroupDownloadCompleted ?? 0, fileGroupDownloadTotal));
        return `Downloaded by ${completed}/${fileGroupDownloadTotal}`;
      }
    }

    switch (transferStatus) {
      case 'connecting':
        return 'Connecting...';
      case 'awaiting_acceptance':
        return isGroupChat ? 'Group file offered' : 'File offered';
      case 'incoming_pending_user':
        return 'Waiting for your decision';
      case 'in_progress':
        if (isFromCurrentUser && transferProgress >= 100) {
          return 'Awaiting recipient confirmation';
        }
        return `${transferProgress}%`;
      case 'completed':
        return 'Completed';
      case 'partially_completed':
        return 'Partially completed';
      case 'failed':
        return 'Failed';
      case 'rejected':
        return 'Offer rejected';
      case 'cancelled':
        return 'Offer cancelled';
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
    if (transferError?.toLowerCase().includes('offer cancelled')) {
      return 'Offer cancelled';
    }
    // File transfer delivers the offer even while the sender is offline, but the bytes only
    // come across once both sides are online — surface that honestly instead of a bare
    // "Sender offline", especially for voice notes where there's no filename to fall back on.
    if (transferError?.toLowerCase().includes('sender offline')) {
      return isVoiceNote
        ? 'Voice message will be available when the sender is back online'
        : 'File will be available when the sender is back online';
    }
    return transferError;
  };

  const transferStatusContent = (
    <>
      {transferStatus === 'in_progress' && !isGroupSenderOffer && (
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

      {showsGroupSenderStandaloneStatus && (
        <div className="text-xs opacity-70">
          {getStatusText()}
        </div>
      )}

      {transferStatus === 'failed' && (
        <div className="text-xs">
          {specificErrorText() || 'Transfer failed'}
        </div>
      )}

      {(transferStatus === 'rejected' || (transferStatus === 'cancelled' && !isGroupSenderOffer)) && (
        <div className="text-xs opacity-70">
          {getStatusText()}
        </div>
      )}

      {transferStatus === 'connecting' && (
        <div className="text-xs opacity-70">
          {getStatusText()}
        </div>
      )}

      {showsDecisionStatus && (
        <div className="text-xs opacity-70">
          <div>{getStatusText()}</div>
          {isIncomingPendingDecision && transferError && (
            <div className="mt-1">{specificErrorText()}</div>
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

      {isOutgoingPendingOffer && (
        <Button
          onClick={handleCancelOffer}
          size="sm"
          variant="outline"
          disabled={isCancelling}
        >
          Cancel offer
        </Button>
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

  const voiceCard = (
    <div className="flex flex-col gap-2 w-[250px]">
      <div className="flex items-center justify-between gap-3">
        <div className={`text-2xl ${isFromCurrentUser ? 'bg-background/50' : ''} rounded-md p-1`}>
          <Mic className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0 text-left">
          <p className="text-sm font-medium truncate">Voice message</p>
          <p className="text-xs opacity-70">{formatVoiceNoteDuration(voiceDurationMs)}</p>
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

  const hasSenderPreview = isImageFile(fileName) && isFromCurrentUser && !!previewMediaToken;
  const hasSenderVoicePreview = isVoiceNote && isFromCurrentUser && !!previewMediaToken;

  if (isVoiceNote) {
    if (shouldRenderInlineVoiceNote({ isVoiceNote, isFromCurrentUser, previewMediaToken, transferStatus, filePath })) {
      return (
        <InlineVoiceNoteMessage
          key={`${fileId}:${previewMediaToken ?? filePath}`}
          fileId={fileId}
          initialMediaToken={hasSenderVoicePreview ? previewMediaToken : undefined}
          fallback={voiceCard}
        />
      );
    }
    return voiceCard;
  }

  if (shouldRenderInlineImage({ fileName, isFromCurrentUser, previewMediaToken, transferStatus, filePath })) {
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
        canCopyImage={canCopyImage}
        onCopyImage={handleCopyImage}
        statusContent={transferStatusContent}
        fallback={fileCard}
      />
    );
  }

  return fileCard;
};
