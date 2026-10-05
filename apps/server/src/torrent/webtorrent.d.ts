// WebTorrent ships no types. engine.ts is the only importer and narrows it to what it uses.
declare module 'webtorrent' {
  const WebTorrent: unknown;
  export default WebTorrent;
}
