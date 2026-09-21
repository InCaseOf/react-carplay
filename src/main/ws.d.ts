// Minimal ambient types for the 'ws' package (no @types/ws installed; 'ws'
// itself ships no .d.ts). Only covers what Socket.ts actually uses for the
// raw /native WebSocket endpoint - see imx6-native-client.md.
declare module 'ws' {
  import { IncomingMessage } from 'http'
  import { Duplex } from 'stream'
  import { EventEmitter } from 'events'

  export class WebSocket extends EventEmitter {
    readyState: number
    send(data: Buffer | ArrayBufferView): void
    close(code?: number, reason?: string): void
    on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): this
    on(event: 'close', listener: () => void): this
    on(event: string, listener: (...args: unknown[]) => void): this
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options: { noServer?: boolean; path?: string })
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (client: WebSocket) => void
    ): void
    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void): this
    on(event: string, listener: (...args: unknown[]) => void): this
  }
}
