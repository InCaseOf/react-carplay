// Socket.io event names shared between the main process (src/main/Socket.ts),
// the renderer's CarPlay worker, and the standalone remote viewer page
// (src/renderer/src/remote). Kept in its own dependency-free module so the
// renderer/worker/remote-page bundles never have to pull in main-process-only
// code (http, fs, node-carplay/node, socketmost, ...) just to reference an
// event name.
export enum MessageNames {
  Connection = 'connection',
  GetSettings = 'getSettings',
  SaveSettings = 'saveSettings',
  Stream = 'stream',
  // Relayed between the local CarPlay renderer worker and any remote LAN
  // viewers - see remote-carplay.md. The socket.io server itself doesn't
  // interpret these, it just rebroadcasts them to every other connected
  // socket.
  VideoChunk = 'videoChunk',
  AudioChunk = 'audioChunk',
  TouchEvent = 'touchEvent',
  MicChunk = 'micChunk'
}

export type RemoteAudioChunk = {
  decodeType: number
  audioType: number
  // Sent (and received) as a plain ArrayBuffer of Int16 PCM samples - see
  // the comments in CarPlay.worker.ts's 'audio' handling for why.
  data: ArrayBuffer
}

export type RemoteTouchEvent = {
  x: number
  y: number
  action: number
}
