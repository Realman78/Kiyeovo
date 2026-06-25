const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'avif',
]);

export const ACCEPTED_IMAGE_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

export function isImageFile(fileName: string): boolean {
  const extension = fileName.split('.').pop()?.toLowerCase();
  return !!extension && IMAGE_EXTENSIONS.has(extension);
}
