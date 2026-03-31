import type { QueryEvent } from '@libp2p/kad-dht';
import type { ChatNode } from '../../types.js';

interface PutJsonToDHTOptions {
  warnOnQueryError?: boolean;
  warnPrefix?: string;
}

export async function putJsonToDHT(
  node: ChatNode,
  dhtKey: string,
  data: object,
  options?: PutJsonToDHTOptions,
): Promise<void> {
  if (node.getConnections().length === 0) {
    throw new Error('No connected peers for DHT publish');
  }

  const keyBytes = new TextEncoder().encode(dhtKey);
  const valueBytes = new TextEncoder().encode(JSON.stringify(data));
  let successCount = 0;

  for await (const event of node.services.dht.put(keyBytes, valueBytes) as AsyncIterable<QueryEvent>) {
    if (event.name === 'QUERY_ERROR' && options?.warnOnQueryError) {
      const prefix = options.warnPrefix ?? 'GROUP';
      console.warn(`[${prefix}] DHT put error for ${dhtKey}:`, event);
    }
    if (event.name === 'PEER_RESPONSE') {
      successCount++;
    }
  }

  if (successCount === 0) {
    throw new Error(`No successful DHT peer responses for ${dhtKey.slice(0, 60)}`);
  }
}

