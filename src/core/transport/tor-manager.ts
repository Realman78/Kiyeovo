import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { log } from '../../shared/logger.js';

/**
 * Manages bundled Tor lifecycle for Kiyeovo
 *
 * Responsibilities:
 * - Spawn bundled Tor binary with custom torrc
 * - Wait for Tor to bootstrap (connect to network)
 * - Create hidden service via control port (ADD_ONION)
 * - Persist hidden service key for consistent .onion address
 * - Graceful shutdown
 */

// Ports chosen to avoid conflicts with system Tor (9050/9051) and Tor Browser (9150/9151)
export const BUNDLED_TOR_SOCKS_PORT = 9550;
export const BUNDLED_TOR_CONTROL_PORT = 9551;

export interface TorManagerConfig {
  dataDir: string;
  libp2pPort: number;
  torBinaryPath: string; // Path to the bundled Tor binary
  onStatus?: ((message: string, stage: TorStage) => void) | undefined;
}

export type TorStage = 'starting' | 'bootstrapping' | 'creating_hidden_service' | 'ready' | 'error';

export interface TorManagerState {
  isRunning: boolean;
  onionAddress: string | null;
  socksPort: number;
  controlPort: number;
  bootstrapProgress: number;
}

export class TorManager {
  private config: TorManagerConfig;
  private torProcess: ChildProcess | null = null;
  private onionAddress: string | null = null;
  private hiddenServiceKey: string | null = null;
  private isRunning = false;
  private controlSocket: net.Socket | null = null;

  constructor(config: TorManagerConfig) {
    this.config = config;
  }

  /**
   * Start the bundled Tor daemon
   */
  async start(): Promise<string> {
    if (this.isRunning) {
      throw new Error('Tor is already running');
    }

    this.sendStatus('Starting Tor daemon...', 'starting');

    const torDir = path.join(this.config.dataDir, 'tor');
    const torDataDir = path.join(torDir, 'data');

    fs.mkdirSync(torDataDir, { recursive: true });

    const keyPath = path.join(torDir, 'hidden_service_key');
    if (fs.existsSync(keyPath)) {
      this.hiddenServiceKey = fs.readFileSync(keyPath, 'utf-8').trim();
      log('[TorManager] Loaded existing hidden service key');
    }

    const torrcPath = path.join(torDir, 'torrc');
    const torrcContent = this.generateTorrc(torDataDir);
    fs.writeFileSync(torrcPath, torrcContent);
    log('[TorManager] Generated torrc at:', torrcPath);

    const torBinaryPath = this.config.torBinaryPath;
    log('[TorManager] Tor binary path:', torBinaryPath);

    if (!fs.existsSync(torBinaryPath)) {
      throw new Error(`Tor binary not found at: ${torBinaryPath}. Please ensure Tor is bundled with the application.`);
    }

    // Make sure binary is executable (Unix only)
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(torBinaryPath, 0o755);
      } catch (err) {
        console.warn('[TorManager] Could not set executable permission:', err);
      }
    }

    this.torProcess = spawn(torBinaryPath, ['-f', torrcPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    this.torProcess.on('error', (err) => {
      console.error('[TorManager] Tor process error:', err);
      this.sendStatus(`Tor error: ${err.message}`, 'error');
    });

    this.torProcess.on('exit', (code, signal) => {
      log(`[TorManager] Tor process exited with code ${code}, signal ${signal}`);
      this.isRunning = false;
      this.torProcess = null;
    });

    try {
      await this.waitForBootstrap();

      this.sendStatus('Creating hidden service...', 'creating_hidden_service');
      this.onionAddress = await this.createHiddenService();

      if (this.hiddenServiceKey) {
        fs.writeFileSync(keyPath, this.hiddenServiceKey, { mode: 0o600 });
        log('[TorManager] Saved hidden service key');
      }

      this.isRunning = true;
      this.sendStatus('Tor ready', 'ready');

      log(`[TorManager] Tor started successfully. Onion address: ${this.onionAddress}`);
      return this.onionAddress;
    } catch (error) {
      // Bootstrap/create-onion failure can leave a live Tor process; always clean it up.
      await this.stop();
      throw error;
    }
  }

  /**
   * Stop the Tor daemon gracefully
   */
  async stop(): Promise<void> {
    if (!this.torProcess) {
      return;
    }

    log('[TorManager] Stopping Tor daemon...');

    if (this.controlSocket) {
      this.controlSocket.destroy();
      this.controlSocket = null;
    }

    this.torProcess.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.torProcess) {
          log('[TorManager] Tor did not exit gracefully, sending SIGKILL');
          this.torProcess.kill('SIGKILL');
        }
        resolve();
      }, 5000);

      if (this.torProcess) {
        this.torProcess.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      } else {
        clearTimeout(timeout);
        resolve();
      }
    });

    this.isRunning = false;
    this.torProcess = null;
    this.onionAddress = null;
    log('[TorManager] Tor daemon stopped');
  }

  /**
   * Get the current state
   */
  getState(): TorManagerState {
    return {
      isRunning: this.isRunning,
      onionAddress: this.onionAddress,
      socksPort: BUNDLED_TOR_SOCKS_PORT,
      controlPort: BUNDLED_TOR_CONTROL_PORT,
      bootstrapProgress: this.isRunning ? 100 : 0,
    };
  }

  /**
   * Get the onion address (null if not started)
   */
  getOnionAddress(): string | null {
    return this.onionAddress;
  }

  /**
   * Get the SOCKS port
   */
  getSocksPort(): number {
    return BUNDLED_TOR_SOCKS_PORT;
  }

  /**
   * Generate the multiaddr announce address for libp2p
   */
  getAnnounceAddress(peerId: string): string | null {
    if (!this.onionAddress) {
      return null;
    }
    // Remove .onion suffix for multiaddr format
    const onionHost = this.onionAddress.replace('.onion', '');
    return `/onion3/${onionHost}:${this.config.libp2pPort}/p2p/${peerId}`;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private methods
  // ─────────────────────────────────────────────────────────────────────────────

  private sendStatus(message: string, stage: TorStage): void {
    log(`[TorManager] ${message}`);
    this.config.onStatus?.(message, stage);
  }

  /**
   * Generate torrc configuration
   */
  private generateTorrc(dataDir: string): string {
    return `# Auto-generated by Kiyeovo
# Do not edit manually - changes will be overwritten

# SOCKS proxy for outgoing connections
SocksPort ${BUNDLED_TOR_SOCKS_PORT}

# Control port for dynamic hidden service creation
ControlPort ${BUNDLED_TOR_CONTROL_PORT}

# Data directory
DataDirectory ${dataDir}

# Performance tuning
CircuitBuildTimeout 30
NumEntryGuards 3

# Logging (to stdout, captured by Node.js)
Log notice stdout

# Disable some features we don't need
AvoidDiskWrites 1
`;
  }

  /**
   * Wait for Tor to bootstrap (connect to network)
   */
  private async waitForBootstrap(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.torProcess || !this.torProcess.stdout || !this.torProcess.stderr) {
        reject(new Error('Tor process not started'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Tor bootstrap timeout (5 minutes)'));
      }, 300_000);

      let lastProgress = 0;

      const checkLine = (line: string) => {
        // Parse bootstrap progress: "Bootstrapped 45% (loading_descriptors): Loading relay descriptors"
        const bootstrapMatch = line.match(/Bootstrapped (\d+)%/);
        if (bootstrapMatch && bootstrapMatch[1]) {
          const progress = parseInt(bootstrapMatch[1], 10);
          if (progress !== lastProgress) {
            lastProgress = progress;
            this.sendStatus(`Bootstrapping Tor: ${progress}%`, 'bootstrapping');
          }

          if (progress === 100) {
            clearTimeout(timeout);
            resolve();
          }
        }

        // Check for errors
        if (line.includes('[err]') || line.includes('[warn]')) {
          console.warn('[TorManager] Tor warning/error:', line);
        }
      };

      this.torProcess.stdout.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        lines.forEach(checkLine);
      });

      this.torProcess.stderr.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        lines.forEach((line) => {
          if (line.trim()) {
            console.error('[TorManager] Tor stderr:', line);
          }
        });
      });

      this.torProcess.once('exit', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`Tor process exited with code ${code}`));
        }
      });
    });
  }

  /**
   * Create hidden service via Tor control port
   */
  private async createHiddenService(): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(BUNDLED_TOR_CONTROL_PORT, '127.0.0.1');
      this.controlSocket = socket;

      let buffer = '';
      let authenticated = false;
      let onionAddress: string | null = null;

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Control port timeout'));
      }, 10000);

      socket.on('connect', () => {
        log('[TorManager] Connected to control port');
        // Authenticate (no password for local control port)
        socket.write('AUTHENTICATE\r\n');
      });

      socket.on('data', (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\r\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line) continue;

          log('[TorManager] Control response:', line);

          if (line.startsWith('250 OK') && !authenticated) {
            authenticated = true;
            // Now create the hidden service
            const addOnionCmd = this.buildAddOnionCommand();
            log('[TorManager] Sending ADD_ONION command');
            socket.write(addOnionCmd + '\r\n');
          } else if (line.startsWith('250-ServiceID=')) {
            onionAddress = line.replace('250-ServiceID=', '') + '.onion';
          } else if (line.startsWith('250-PrivateKey=')) {
            // Save the private key for future use
            this.hiddenServiceKey = line.replace('250-PrivateKey=', '');
          } else if (line === '250 OK' && authenticated && onionAddress) {
            clearTimeout(timeout);
            resolve(onionAddress);
          } else if (line.startsWith('5')) {
            // Error response
            clearTimeout(timeout);
            reject(new Error(`Tor control error: ${line}`));
          }
        }
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Control socket error: ${err.message}`));
      });

      socket.on('close', () => {
        if (!onionAddress) {
          clearTimeout(timeout);
          reject(new Error('Control socket closed before getting onion address'));
        }
      });
    });
  }

  /**
   * Build the ADD_ONION command
   */
  private buildAddOnionCommand(): string {
    const port = this.config.libp2pPort;

    if (this.hiddenServiceKey) {
      // Use existing key for persistent .onion address
      return `ADD_ONION ${this.hiddenServiceKey} Port=${port},127.0.0.1:${port}`;
    } else {
      // Generate new key
      return `ADD_ONION NEW:ED25519-V3 Port=${port},127.0.0.1:${port}`;
    }
  }
}

/**
 * Check if a port is in use
 */
export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });

    server.once('listening', () => {
      server.close();
      resolve(false);
    });

    server.listen(port, '127.0.0.1');
  });
}

/**
 * Create a TorManager instance with standard configuration
 */
export function createTorManager(
  dataDir: string,
  libp2pPort: number,
  torBinaryPath: string,
  onStatus?: (message: string, stage: TorStage) => void
): TorManager {
  return new TorManager({
    dataDir,
    libp2pPort,
    torBinaryPath,
    onStatus,
  });
}

/**
 * Get the path to the bundled Tor binary based on platform/arch
 * This should be called from Electron main process where app paths are available
 */
export function getTorBinaryPath(resourcesPath: string, appPath: string, isPackaged: boolean): string {
  const platform = process.platform;
  const arch = process.arch;

  let binaryName: string;
  let platformDir: string;

  switch (platform) {
    case 'win32':
      binaryName = 'tor.exe';
      platformDir = 'win32-x64';
      break;
    case 'darwin':
      binaryName = 'tor';
      platformDir = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
      break;
    case 'linux':
      binaryName = 'tor';
      platformDir = 'linux-x64';
      break;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }

  // In development, look in resources/tor
  // In production (packaged), look in resources folder (unpacked from asar)
  let basePath: string;

  if (isPackaged) {
    // Production: use resources folder (unpacked)
    basePath = path.join(resourcesPath, 'tor', platformDir);
  } else {
    // Development: use project resources folder
    basePath = path.join(appPath, 'resources', 'tor', platformDir);
  }

  return path.join(basePath, binaryName);
}
