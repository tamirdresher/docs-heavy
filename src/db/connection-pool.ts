/**
 * Database connection pool management.
 *
 * Provides a configurable pool of database connections with:
 *  - Min/max pool size constraints
 *  - Idle connection reaping
 *  - Prepared statement caching per connection
 *  - Wait queue with configurable timeout on pool exhaustion
 *
 * In production, back this with pg.Pool, mysql2, or a similar driver.
 * This implementation provides the interface and in-memory simulation
 * for testing and demonstration.
 */

export interface PoolOptions {
  /** Minimum number of idle connections to maintain. Default: 2. */
  minSize?: number;
  /** Maximum number of connections. Default: 10. */
  maxSize?: number;
  /** Idle timeout in ms before a connection is reaped. Default: 30000. */
  idleTimeoutMs?: number;
  /** Timeout in ms to wait for a connection when pool is exhausted. Default: 5000. */
  acquireTimeoutMs?: number;
  /** Connection string / DSN. */
  connectionString?: string;
}

export interface DatabaseConnection {
  /** Unique connection identifier. */
  id: string;
  /** Execute a raw SQL query with parameterized values. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Execute a prepared statement (cached per connection). */
  execute<T = Record<string, unknown>>(name: string, sql: string, params?: unknown[]): Promise<T[]>;
  /** Begin a transaction. */
  beginTransaction(): Promise<void>;
  /** Commit the current transaction. */
  commit(): Promise<void>;
  /** Rollback the current transaction. */
  rollback(): Promise<void>;
  /** Whether this connection is in a transaction. */
  inTransaction: boolean;
  /** Release back to pool. */
  release(): void;
}

interface PooledConnection {
  connection: DatabaseConnection;
  createdAt: number;
  lastUsedAt: number;
  idle: boolean;
}

let nextConnectionId = 0;

/**
 * Create an in-memory simulated database connection.
 * In production, replace with actual driver connection.
 */
function createInMemoryConnection(
  store: Map<string, Map<string, Record<string, unknown>>>,
  onRelease: (conn: DatabaseConnection) => void,
): DatabaseConnection {
  const id = `conn-${++nextConnectionId}`;
  let txActive = false;
  const preparedCache = new Map<string, string>();

  const conn: DatabaseConnection = {
    id,
    inTransaction: false,

    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      // Simulate parameterized query execution against in-memory store
      return simulateQuery<T>(store, sql, params);
    },

    async execute<T>(name: string, sql: string, params?: unknown[]): Promise<T[]> {
      // Cache the prepared statement SQL
      if (!preparedCache.has(name)) {
        preparedCache.set(name, sql);
      }
      return simulateQuery<T>(store, preparedCache.get(name)!, params);
    },

    async beginTransaction(): Promise<void> {
      if (txActive) throw new Error('Transaction already active');
      txActive = true;
      conn.inTransaction = true;
    },

    async commit(): Promise<void> {
      if (!txActive) throw new Error('No active transaction');
      txActive = false;
      conn.inTransaction = false;
    },

    async rollback(): Promise<void> {
      if (!txActive) throw new Error('No active transaction');
      txActive = false;
      conn.inTransaction = false;
    },

    release(): void {
      if (txActive) {
        // Auto-rollback abandoned transactions to avoid leaving
        // dangling locks in a real database driver.
        conn.rollback().catch(() => {});
        txActive = false;
        conn.inTransaction = false;
      }
      onRelease(conn);
    },
  };

  return conn;
}

/**
 * Simulate query execution against in-memory tables.
 * Supports basic SELECT, INSERT patterns for testing.
 */
function simulateQuery<T>(
  store: Map<string, Map<string, Record<string, unknown>>>,
  sql: string,
  _params?: unknown[],
): T[] {
  // Minimal SQL simulation for testing repository layer
  const normalized = sql.trim().toUpperCase();
  if (normalized.startsWith('SELECT')) {
    // Return all rows from referenced table
    for (const [tableName, rows] of store) {
      if (normalized.includes(tableName.toUpperCase())) {
        return Array.from(rows.values()) as T[];
      }
    }
  }
  return [];
}

/**
 * Connection pool with configurable size and idle reaping.
 */
export class ConnectionPool {
  private readonly options: Required<PoolOptions>;
  private readonly connections: PooledConnection[] = [];
  private readonly store: Map<string, Map<string, Record<string, unknown>>>;
  private readonly waitQueue: Array<{
    resolve: (conn: DatabaseConnection) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private closed = false;
  private reaperInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: PoolOptions = {}) {
    this.options = {
      minSize: options.minSize ?? 2,
      maxSize: options.maxSize ?? 10,
      idleTimeoutMs: options.idleTimeoutMs ?? 30_000,
      acquireTimeoutMs: options.acquireTimeoutMs ?? 5_000,
      connectionString: options.connectionString ?? 'memory://',
    };

    if (this.options.minSize < 0) throw new Error('minSize must be non-negative');
    if (this.options.maxSize < 1) throw new Error('maxSize must be at least 1');
    if (this.options.minSize > this.options.maxSize) {
      throw new Error('minSize cannot exceed maxSize');
    }

    // Shared in-memory store for simulated connections
    this.store = new Map();
  }

  /**
   * Initialize the pool, creating minimum connections.
   */
  async initialize(): Promise<void> {
    if (this.closed) throw new Error('Pool is closed');

    for (let i = this.connections.length; i < this.options.minSize; i++) {
      this.addConnection();
    }

    // Start idle reaper
    this.reaperInterval = setInterval(() => this.reapIdle(), this.options.idleTimeoutMs);
  }

  /**
   * Acquire a connection from the pool.
   * Creates a new one if all are busy and pool isn't at max capacity.
   * When pool is exhausted, waits up to acquireTimeoutMs for a connection.
   */
  async acquire(): Promise<DatabaseConnection> {
    if (this.closed) throw new Error('Pool is closed');

    // Find an idle connection
    const idle = this.connections.find((c) => c.idle);
    if (idle) {
      idle.idle = false;
      idle.lastUsedAt = Date.now();
      return idle.connection;
    }

    // Create new connection if under max
    if (this.connections.length < this.options.maxSize) {
      const pooled = this.addConnection();
      pooled.idle = false;
      pooled.lastUsedAt = Date.now();
      return pooled.connection;
    }

    // Pool exhausted — queue the request with a timeout
    return new Promise<DatabaseConnection>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waitQueue.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waitQueue.splice(idx, 1);
        reject(new Error('Connection pool exhausted'));
      }, this.options.acquireTimeoutMs);

      this.waitQueue.push({ resolve, reject, timer });
    });
  }

  /**
   * Close all connections, drain the wait queue, and stop the reaper.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = null;
    }

    // Reject all waiting acquires
    for (const waiter of this.waitQueue) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Pool is closed'));
    }
    this.waitQueue.length = 0;

    this.connections.length = 0;
  }

  /** Current pool size. */
  get size(): number {
    return this.connections.length;
  }

  /** Number of idle connections. */
  get idleCount(): number {
    return this.connections.filter((c) => c.idle).length;
  }

  /** Number of requests waiting for a connection. */
  get waitQueueSize(): number {
    return this.waitQueue.length;
  }

  /** Whether the pool is closed. */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Get the shared in-memory store (for repository testing).
   */
  getStore(): Map<string, Map<string, Record<string, unknown>>> {
    return this.store;
  }

  private addConnection(): PooledConnection {
    const pooled: PooledConnection = {
      connection: createInMemoryConnection(this.store, (conn) => {
        // When a connection is released, check the wait queue first
        const waiter = this.waitQueue.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          const entry = this.connections.find((c) => c.connection.id === conn.id);
          if (entry) {
            entry.idle = false;
            entry.lastUsedAt = Date.now();
          }
          waiter.resolve(conn);
          return;
        }

        const entry = this.connections.find((c) => c.connection.id === conn.id);
        if (entry) {
          entry.idle = true;
          entry.lastUsedAt = Date.now();
        }
      }),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      idle: true,
    };
    this.connections.push(pooled);
    return pooled;
  }

  private reapIdle(): void {
    const now = Date.now();
    const threshold = this.options.idleTimeoutMs;

    // Keep at least minSize connections
    let i = this.connections.length - 1;
    while (i >= 0 && this.connections.length > this.options.minSize) {
      const c = this.connections[i];
      if (c.idle && now - c.lastUsedAt > threshold) {
        this.connections.splice(i, 1);
      }
      i--;
    }
  }
}
