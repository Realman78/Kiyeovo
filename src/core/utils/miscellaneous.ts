import os from 'os';
import path from 'path';
import fs from 'fs';

import type { PeerInfo } from '@libp2p/interface';
import type { Component, Multiaddr } from '@multiformats/multiaddr';

/**
 * Remove all addresses except for onion v3 addresses
 */
export const filterOnionAddressesMapper = (peer: PeerInfo): PeerInfo => {
    peer.multiaddrs = peer.multiaddrs.filter((ma: Multiaddr) =>
        ma.getComponents().some((c: Component) => c.code === 445)); // 445 is /onion3
    return peer;
};

export function isOnionMultiaddr(address: string): boolean {
    return address.includes('/onion3/');
};

export const ensureAppDataDir = (): string => {
    const platform = process.platform;
    const home = os.homedir();
    let appDataDir = '';

    switch (platform) {
        case 'win32':
            appDataDir = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'kiyeovo');
            break;
        case 'darwin':
            appDataDir = path.join(home, 'Library', 'Application Support', 'kiyeovo');
            break;
        case 'linux':
            appDataDir = path.join(home, '.config', 'kiyeovo');
            break;
        default:
            appDataDir = path.join('.kiyeovo');
            break;
    }
    if (!fs.existsSync(appDataDir)) {
        fs.mkdirSync(appDataDir, { recursive: true });
    }
    return appDataDir;
};

export const formatCopyTimestamp = (date: Date): string => {
    const MM = String(date.getMonth() + 1).padStart(2, '0');
    const DD = String(date.getDate()).padStart(2, '0');
    const HH = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const SS = String(date.getSeconds()).padStart(2, '0');
    const centiseconds = String(Math.floor(date.getMilliseconds() / 10)).padStart(2, '0');
    return `${MM}${DD}_${HH}${mm}${SS}_${centiseconds}`;
};

/**
* Convert buffer to base64url (URL-safe base64)
* Replaces / with -, + with _, and removes = padding
*/
export function toBase64Url(buffer: Uint8Array): string {
    return Buffer.from(buffer)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

/**
 * Convert base64url to buffer
 */
export function fromBase64Url(base64url: string): Uint8Array {
    // Add back padding if needed
    let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
        base64 += '=';
    }
    return Buffer.from(base64, 'base64');
}
