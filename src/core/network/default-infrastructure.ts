export const DEFAULT_BOOTSTRAP_NODES: string[] = [];

export const DEFAULT_FAST_RELAY_MULTIADDRS: string[] = [];

export type DefaultIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export const DEFAULT_WEBRTC_ICE_SERVERS: DefaultIceServer[] = [];
