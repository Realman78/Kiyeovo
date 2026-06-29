import type { ApplicationMessage } from './message-envelope.js';

export type NonTextApplicationMessage = ApplicationMessage<
  'file_offer' | 'file_offer_cancel' | 'file_offer_nack'
>;

export interface InboundApplicationMessageContext {
  message: NonTextApplicationMessage;
  chatId: number;
  senderPeerId: string;
  senderUsername: string;
  timestamp: number;
  transportMessageId: string;
  route: 'direct_online' | 'direct_offline' | 'group_realtime' | 'group_offline';
}

export type InboundApplicationMessageHandler = (
  context: InboundApplicationMessageContext,
) => boolean | Promise<boolean>;

export interface TransportOwnedApplicationMessage {
  owner: 'transport';
  content: string;
  messageType: 'text' | 'file' | 'image' | 'system';
  replyToCid?: string;
}

interface SendApplicationMessageRequestBase {
  rekeyRetryHint?: boolean;
}

export type SendApplicationMessageRequest = SendApplicationMessageRequestBase & (
  | {
    message: ApplicationMessage<'text'>;
    persistence: TransportOwnedApplicationMessage;
  }
  | {
    message: ApplicationMessage<'file_offer'>;
    persistence: { owner: 'caller' };
  }
  | {
    message: ApplicationMessage<'file_offer_cancel' | 'file_offer_nack'>;
    persistence: { owner: 'none' };
  }
);

export interface ApplicationMessageSendResult {
  chatId: number;
  messageId: string;
  timestamp: number;
  messageSentStatus: 'online' | 'offline';
  warning: string | null;
  offlineBackupRetry: { chatId: number; messageId: string } | null;
}
