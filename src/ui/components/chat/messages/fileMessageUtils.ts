import type { FileTransferStatus } from '../../../../core/types';
import { isImageFile } from '../../../../shared/file-types';

export function shouldRenderInlineImage(params: {
  fileName: string;
  isFromCurrentUser: boolean;
  previewMediaToken?: string;
  transferStatus: FileTransferStatus | undefined;
  filePath?: string;
}): boolean {
  const { fileName, isFromCurrentUser, previewMediaToken, transferStatus, filePath } = params;
  if (!isImageFile(fileName)) return false;
  const hasSenderPreview = isFromCurrentUser && !!previewMediaToken;
  const hasCompletedImage = transferStatus === 'completed' && !!filePath;
  return hasSenderPreview || hasCompletedImage;
}

// Voice notes render as a compact inline player once bytes are locally available: on the
// sender's side that's immediately (their own upload, via previewMediaToken), on the
// receiver's side only once the pull completes (transferStatus === 'completed'). Any other
// state (pending decision, in flight, failed, offline sender, ...) reuses the same
// accept/reject/status card as a regular file offer — see FileMessage's voice-note branch.
export function shouldRenderInlineVoiceNote(params: {
  isVoiceNote: boolean | undefined;
  isFromCurrentUser: boolean;
  previewMediaToken?: string;
  transferStatus: FileTransferStatus | undefined;
  filePath?: string;
}): boolean {
  const { isVoiceNote, isFromCurrentUser, previewMediaToken, transferStatus, filePath } = params;
  if (!isVoiceNote) return false;
  const hasSenderPreview = isFromCurrentUser && !!previewMediaToken;
  const hasCompletedAudio = transferStatus === 'completed' && !!filePath;
  return hasSenderPreview || hasCompletedAudio;
}
