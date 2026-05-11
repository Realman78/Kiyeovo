import type { KiyeovoAPI } from './src/shared/kiyeovo-api';

declare global {
  interface Window {
    kiyeovoAPI: KiyeovoAPI;
  }
}

export {};
