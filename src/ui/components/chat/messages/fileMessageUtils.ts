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
