import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { EventEmitter } from 'events';

interface Client {
  id: string;
  ws: WebSocket;
  subscribedChannels: Set<string>;
  channelHandlers: Map<string, (data: unknown) => void>;
}

const clients = new Map<string, Client>();
const channels = new EventEmitter();
// Channels legitimately hold one listener per client per channel subscription
channels.setMaxListeners(0);

let clientIdCounter = 0;

function generateClientId(): string {
  return `client_${++clientIdCounter}`;
}

/**
 * Handles a new WebSocket connection. Registers named event listener
 * functions so they can be properly removed on disconnect, preventing
 * the memory leak described in the issue.
 */
export function handleConnection(ws: WebSocket, req: IncomingMessage): void {
  const clientId = generateClientId();
  const client: Client = {
    id: clientId,
    ws,
    subscribedChannels: new Set(),
    channelHandlers: new Map(),
  };

  clients.set(clientId, client);

  // Use named functions so we can remove them on disconnect
  function onMessage(data: Buffer | string): void {
    try {
      const message = JSON.parse(data.toString());
      handleClientMessage(client, message);
    } catch {
      ws.send(JSON.stringify({ error: 'Invalid JSON' }));
    }
  }

  function onClose(): void {
    cleanup();
  }

  function onError(err: Error): void {
    console.error(`[ws] Client ${clientId} error:`, err.message);
    cleanup();
  }

  let cleaned = false;
  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;

    // Remove all event listeners added for this connection
    ws.removeListener('message', onMessage);
    ws.removeListener('close', onClose);
    ws.removeListener('error', onError);

    // Unsubscribe from all channels, removing only this client's handlers
    for (const channel of client.subscribedChannels) {
      const handler = client.channelHandlers.get(channel);
      if (handler) {
        channels.removeListener(channel, handler);
      }
    }
    client.channelHandlers.clear();
    client.subscribedChannels.clear();

    clients.delete(clientId);
  }

  ws.on('message', onMessage);
  ws.on('close', onClose);
  ws.on('error', onError);

  ws.send(JSON.stringify({ type: 'connected', clientId }));
}

function handleClientMessage(
  client: Client,
  message: { action: string; channel?: string; data?: unknown }
): void {
  switch (message.action) {
    case 'subscribe':
      if (message.channel) {
        // Remove existing handler for this channel if re-subscribing
        const existingHandler = client.channelHandlers.get(message.channel);
        if (existingHandler) {
          channels.removeListener(message.channel, existingHandler);
        }

        client.subscribedChannels.add(message.channel);
        const handler = (data: unknown) => {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ channel: message.channel, data }));
          }
        };
        client.channelHandlers.set(message.channel, handler);
        channels.on(message.channel!, handler);
      }
      break;

    case 'unsubscribe':
      if (message.channel) {
        const handler = client.channelHandlers.get(message.channel);
        if (handler) {
          channels.removeListener(message.channel, handler);
          client.channelHandlers.delete(message.channel);
        }
        client.subscribedChannels.delete(message.channel);
      }
      break;

    case 'broadcast':
      if (message.channel && message.data) {
        channels.emit(message.channel, message.data);
      }
      break;

    default:
      client.ws.send(JSON.stringify({ error: `Unknown action: ${message.action}` }));
  }
}

export function createWebSocketServer(port: number): WebSocketServer {
  const wss = new WebSocketServer({ port });
  wss.on('connection', handleConnection);
  return wss;
}

export function getConnectedClients(): number {
  return clients.size;
}

export { clients, channels };
