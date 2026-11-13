import type { HostProcess, ProcessSpawner } from '../../native/manager';

interface SubprocessModule {
  call(options: {
    command: string;
    arguments?: string[];
    stderr?: 'ignore' | 'stdout' | 'pipe';
    environment?: Record<string, string>;
  }): Promise<SubprocessHandle>;
}

interface SubprocessPipe {
  read(): Promise<ArrayBuffer>;
  write(buffer: Uint8Array | ArrayBuffer | string): Promise<void>;
  close(): Promise<void> | void;
}

interface SubprocessHandle {
  stdin: SubprocessPipe;
  stdout: SubprocessPipe;
  stderr: SubprocessPipe;
  wait(): Promise<{ exitCode: number | null }>;
  kill(timeout?: number): Promise<{ exitCode: number | null }>;
}

export function loadSubprocess(): SubprocessModule {
  const module = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs') as {
    Subprocess?: SubprocessModule;
  };
  if (!module.Subprocess) {
    throw new Error('ENGINE_START_FAILED');
  }
  return module.Subprocess;
}

class ZoteroProcess implements HostProcess {
  constructor(private readonly handle: SubprocessHandle) {}

  write(chunk: Uint8Array): Promise<void> {
    return Promise.resolve(this.handle.stdin.write(chunk));
  }

  async read(): Promise<Uint8Array | null> {
    try {
      const buffer = await this.handle.stdout.read();
      if (!buffer || buffer.byteLength === 0) {
        return null;
      }
      return new Uint8Array(buffer);
    }
    catch {
      return null;
    }
  }

  async readStderr(): Promise<Uint8Array | null> {
    try {
      const buffer = await this.handle.stderr.read();
      if (!buffer || buffer.byteLength === 0) {
        return null;
      }
      return new Uint8Array(buffer);
    }
    catch {
      return null;
    }
  }

  async closeStdin(): Promise<void> {
    await Promise.resolve(this.handle.stdin.close());
  }

  wait(): Promise<{ exitCode: number | null }> {
    return this.handle.wait();
  }

  kill(): Promise<{ exitCode: number | null }> {
    return this.handle.kill();
  }
}

/**
 * Spawns the helper with an absolute path and an argument array, never through a
 * shell. Subprocess creates the process with a hidden window, which the G0 probe
 * confirmed on this machine.
 */
export class ZoteroProcessSpawner implements ProcessSpawner {
  constructor(private readonly subprocess: SubprocessModule = loadSubprocess()) {}

  async spawn(command: string, args: string[]): Promise<HostProcess> {
    const handle = await this.subprocess.call({
      command,
      arguments: args,
      stderr: 'pipe',
    });
    return new ZoteroProcess(handle);
  }
}
