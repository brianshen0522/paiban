// These ship no types. metainfo.ts and torrent/engine.ts are the only importers and check what they get.
declare module 'parse-torrent' {
  const parseTorrent: (id: string | Uint8Array) => Promise<unknown>;
  export default parseTorrent;
}
declare module 'bencode' {
  const bencode: { encode(value: unknown): Uint8Array; decode(data: Uint8Array): unknown };
  export default bencode;
}
declare module 'memory-chunk-store' {
  const MemoryChunkStore: unknown;
  export default MemoryChunkStore;
}
