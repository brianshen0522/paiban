/**
 * Which BitTorrent program a peer runs, for the download page's peer list. The extended handshake's
 * `v` ("qBittorrent/4.6.3") wins when present; otherwise the Azureus-style peer id ("-qB4630-…")
 * is decoded. Unknown ids give null.
 */
const CLIENTS: Record<string, string> = {
  qB: 'qBittorrent',
  TR: 'Transmission',
  UT: 'µTorrent',
  UM: 'µTorrent Mac',
  UW: 'µTorrent Web',
  LT: 'libtorrent',
  lt: 'rTorrent',
  DE: 'Deluge',
  BI: 'BiglyBT',
  AZ: 'Vuze',
  WW: 'WebTorrent',
  WD: 'WebTorrent Desktop',
  KT: 'KTorrent',
  FD: 'Free Download Manager',
  BT: 'BitTorrent',
  BC: 'BitComet',
  XL: 'Xunlei',
  SD: 'Thunder',
  FW: 'FrostWire',
  PI: 'PicoTorrent',
  TL: 'Tribler',
  AG: 'Ares',
  'A~': 'Ares',
  HL: 'Halite',
  BW: 'BitWombat',
  MO: 'MonoTorrent',
  TT: 'TuoTu',
  XF: 'Xfplay',
};

export function clientName(peerIdHex: string | null, version: string | null): string | null {
  const v = version?.replace(/[^\p{L}\p{N} ._/()+-]/gu, '').trim();
  if (v) return v.slice(0, 40);
  if (!peerIdHex || !/^[0-9a-f]{16,}$/i.test(peerIdHex)) return null;
  const id = Buffer.from(peerIdHex.slice(0, 16), 'hex').toString('latin1');
  const m = /^-([A-Za-z~]{2})([0-9A-Za-z]{4})-$/.exec(id);
  if (!m?.[1] || !m[2]) return null;
  const name = CLIENTS[m[1]];
  if (!name) return null;
  const digits = m[2].replace(/[^0-9]/g, '');
  // WebTorrent writes two digits per part ("0201" = 2.1); most others one ("4630" = 4.6.3).
  const parts =
    m[1] === 'WW' || m[1] === 'WD'
      ? (digits.match(/\d{2}/g) ?? []).map((d) => String(Number(d)))
      : digits.split('');
  while (parts.length > 1 && parts[parts.length - 1] === '0') parts.pop();
  while (parts.length > 1 && parts[0] === '0') parts.shift();
  const number = parts.join('.');
  return number ? `${name} ${number}` : name;
}
