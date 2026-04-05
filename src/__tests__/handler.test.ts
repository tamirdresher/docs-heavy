/**
 * Tests for WebSocket handler — verifies that the memory leak fix
 * properly cleans up event listeners on disconnect.
 */
import { handleConnection, clients, channels } from '../ws/handler.js';

// Minimal mock that satisfies the WebSocket interface used by handleConnection
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  private listeners: Map<string, Function[]> = new Map();
  sent: string[] = [];

  on(event: string, fn: Function): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(fn);
  }

  removeListener(event: string, fn: Function): void {
    const fns = this.listeners.get(event);
    if (fns) {
      const idx = fns.indexOf(fn);
      if (idx !== -1) fns.splice(idx, 1);
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  emit(event: string, ...args: any[]): void {
    // Snapshot listeners to avoid mutation during iteration
    const fns = [...(this.listeners.get(event) ?? [])];
    for (const fn of fns) {
      fn(...args);
    }
  }
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    console.error(`  ✗ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function resetState(): void {
  clients.clear();
  channels.removeAllListeners();
}

const fakeReq = {} as any;

console.log('WebSocket handler tests:');

test('handleConnection registers client and sends connected message', () => {
  resetState();
  const ws = new MockWebSocket();
  handleConnection(ws as any, fakeReq);

  assert(clients.size === 1, 'Should have 1 client');
  assert(ws.sent.length === 1, 'Should send connected message');
  const msg = JSON.parse(ws.sent[0]);
  assert(msg.type === 'connected', 'Message type should be connected');
});

test('Listeners are cleaned up on close event', () => {
  resetState();
  const ws = new MockWebSocket();
  handleConnection(ws as any, fakeReq);

  assert(ws.listenerCount('message') === 1, 'Should have message listener');
  assert(ws.listenerCount('close') === 1, 'Should have close listener');
  assert(ws.listenerCount('error') === 1, 'Should have error listener');

  ws.emit('close');

  assert(ws.listenerCount('message') === 0, 'message listener should be removed');
  assert(ws.listenerCount('close') === 0, 'close listener should be removed');
  assert(ws.listenerCount('error') === 0, 'error listener should be removed');
  assert(clients.size === 0, 'Client should be removed from map');
});

test('Channel subscriptions are cleaned up on disconnect', () => {
  resetState();
  const ws = new MockWebSocket();
  handleConnection(ws as any, fakeReq);

  // Subscribe to a channel via a message
  const subscribeMsg = JSON.stringify({ action: 'subscribe', channel: 'news' });
  ws.emit('message', subscribeMsg);

  assert(channels.listenerCount('news') === 1, 'Channel should have 1 listener');

  // Disconnect
  ws.emit('close');

  assert(channels.listenerCount('news') === 0, 'Channel listener should be removed');
  assert(clients.size === 0, 'Client should be removed');
});

test('Error then close (double-fire) does not throw or double-delete', () => {
  resetState();
  const ws = new MockWebSocket();
  handleConnection(ws as any, fakeReq);

  // Subscribe to a channel
  ws.emit('message', JSON.stringify({ action: 'subscribe', channel: 'alerts' }));
  assert(channels.listenerCount('alerts') === 1, 'Should have channel listener');

  // Error fires first, then close follows (Node ws behavior)
  ws.emit('error', new Error('connection reset'));
  ws.emit('close');

  assert(ws.listenerCount('message') === 0, 'No message listeners');
  assert(ws.listenerCount('close') === 0, 'No close listeners');
  assert(ws.listenerCount('error') === 0, 'No error listeners');
  assert(channels.listenerCount('alerts') === 0, 'Channel listener cleaned');
  assert(clients.size === 0, 'Client removed');
});

test('Multiple connect/disconnect cycles do not leak listeners', () => {
  resetState();
  const channelName = 'stress-test';

  for (let i = 0; i < 100; i++) {
    const ws = new MockWebSocket();
    handleConnection(ws as any, fakeReq);

    // Subscribe to the same channel each time
    ws.emit('message', JSON.stringify({ action: 'subscribe', channel: channelName }));

    // Disconnect
    ws.emit('close');

    assert(ws.listenerCount('message') === 0, `ws listener leak on iteration ${i}`);
    assert(channels.listenerCount(channelName) === 0, `Channel listener leak on iteration ${i}`);
  }

  assert(clients.size === 0, 'All clients should be cleaned up');
});

test('Re-subscribing to same channel replaces handler (no accumulation)', () => {
  resetState();
  const ws = new MockWebSocket();
  handleConnection(ws as any, fakeReq);

  ws.emit('message', JSON.stringify({ action: 'subscribe', channel: 'updates' }));
  ws.emit('message', JSON.stringify({ action: 'subscribe', channel: 'updates' }));
  ws.emit('message', JSON.stringify({ action: 'subscribe', channel: 'updates' }));

  assert(channels.listenerCount('updates') === 1, 'Should have exactly 1 listener after re-subscribing');

  ws.emit('close');
  assert(channels.listenerCount('updates') === 0, 'Channel cleaned up after close');
});

test('Unsubscribe removes channel listener', () => {
  resetState();
  const ws = new MockWebSocket();
  handleConnection(ws as any, fakeReq);

  ws.emit('message', JSON.stringify({ action: 'subscribe', channel: 'chat' }));
  assert(channels.listenerCount('chat') === 1, 'Should have listener');

  ws.emit('message', JSON.stringify({ action: 'unsubscribe', channel: 'chat' }));
  assert(channels.listenerCount('chat') === 0, 'Listener removed after unsubscribe');
});

console.log('\nAll tests passed!');
