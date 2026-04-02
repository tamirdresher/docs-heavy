import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { EventEmitter } from 'events';

interface Client {
  id: string;
  ws: WebSocket;
  subscribedChannels: Set<string>;
}

const clients = new Map<string, Client>();
const channels = new EventEmitter();

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

  function cleanup(): void {
    // Remove all event listeners added for this connection
    ws.removeListener('message', onMessage);
    ws.removeListener('close', onClose);
    ws.removeListener('error', onError);

    // Unsubscribe from all channels
    for (const channel of client.subscribedChannels) {
      channels.removeAllListeners(channel);
    }
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
        client.subscribedChannels.add(message.channel);
        const handler = (data: unknown) => {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ channel: message.channel, data }));
          }
        };
        channels.on(message.channel!, handler);
      }
      break;

    case 'unsubscribe':
      if (message.channel) {
        client.subscribedChannels.delete(message.channel);
        channels.removeAllListeners(message.channel);
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
