// JSON Lines framing. Every frame is one UTF-8 line ending in a bare LF; the
// decoder tolerates CRLF and holds partial UTF-8 sequences across chunks.

export const MAX_FRAME_BYTES = 1024 * 1024;

export class FrameTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`protocol frame exceeds ${MAX_FRAME_BYTES} bytes`);
    this.name = 'FrameTooLargeError';
  }
}

export class LineDecoder {
  private readonly decoder = new TextDecoder('utf-8');
  private pending = '';
  private pendingBytes = 0;

  push(chunk: Uint8Array): string[] {
    const text = this.decoder.decode(chunk, { stream: true });
    this.pending += text;
    this.pendingBytes += chunk.byteLength;

    const lines: string[] = [];
    let index = this.pending.indexOf('\n');
    while (index >= 0) {
      const line = this.pending.slice(0, index).replace(/\r$/, '');
      this.pending = this.pending.slice(index + 1);
      this.pendingBytes = this.pending.length;
      if (line.trim().length > 0) {
        lines.push(line);
      }
      index = this.pending.indexOf('\n');
    }
    if (this.pendingBytes > MAX_FRAME_BYTES) {
      throw new FrameTooLargeError(this.pendingBytes);
    }
    return lines;
  }

  /** Returns whatever is left when the stream ends (defensive; frames are LF terminated). */
  flush(): string | null {
    this.pending += this.decoder.decode();
    const rest = this.pending.trim();
    this.pending = '';
    this.pendingBytes = 0;
    return rest.length > 0 ? rest : null;
  }
}

export function encodeFrame(frame: Record<string, unknown>): Uint8Array {
  const json = JSON.stringify(frame);
  if (json.includes('\n')) {
    throw new Error('protocol frames must not contain raw newlines');
  }
  const bytes = new TextEncoder().encode(json + '\n');
  if (bytes.byteLength > MAX_FRAME_BYTES) {
    throw new FrameTooLargeError(bytes.byteLength);
  }
  return bytes;
}
