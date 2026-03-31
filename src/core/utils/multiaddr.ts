import { multiaddr } from '@multiformats/multiaddr';

export function parsePeerIdFromAddress(address: string): string | null {
  try {
    return multiaddr(address).getPeerId() ?? null;
  } catch {
    return null;
  }
}
