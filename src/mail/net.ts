// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
// Schutz vor SSRF: Nutzer können einen eigenen IMAP-Server angeben. Verbindungen nur zu öffentlichen Adressen und
// IMAP-Ports; die Verbindung geht genau an die geprüfte Adresse (kein DNS-Rebinding).
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { MailovoError } from '../errors.ts';

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/** IPv6 in acht Gruppen ausschreiben (::, eingebettetes IPv4); null bei Unsinn */
export function expandV6(ip: string): number[] | null {
  let v = ip.toLowerCase().split('%')[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (v4) {
    const p = v4[1]!.split('.').map(Number);
    v = v.slice(0, -v4[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const [head, tail] = v.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  if (fill < 0) return null;
  const groups = [...h, ...Array(fill).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

function isPrivateV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true;
  const zeroHead = g.slice(0, 5).every((x) => x === 0);
  // IPv4 eingebettet: ::ffff:a.b.c.d (auch in Hex-Schreibweise), ::a.b.c.d, NAT64 64:ff9b::/96
  if ((zeroHead && (g[5] === 0xffff || g[5] === 0)) || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))) {
    if (zeroHead && g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true; // :: und ::1
    return isPrivateV4(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`);
  }
  const first = g[0]!;
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 eindeutig lokal
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-lokal
    (first & 0xff00) === 0xff00 || // Multicast
    first === 0x2002 || // 6to4 (kann private IPv4 einbetten)
    (first === 0x2001 && g[1] === 0x0db8) // Dokumentation
  );
}

/** Ist diese Adresse öffentlich erreichbar (kein internes Netz, kein localhost)? */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !isPrivateV4(address);
  if (family === 6) return !isPrivateV6(address);
  return false;
}

export const ALLOWED_IMAP_PORTS = new Set([993, 143]);

/**
 * Nur öffentliche Adressen und IMAP-Ports; sonst CONF-02. Gibt die geprüfte Adresse zurück: Die Verbindung soll
 * genau dorthin gehen, sonst könnte eine zweite DNS-Antwort auf ein internes Ziel zeigen (DNS-Rebinding).
 * In der Entwicklung abschaltbar.
 */
export async function assertPublicImapHost(host: string, port: number, allowPrivate = false): Promise<string> {
  // Nur in der Entwicklung: lokale Testserver auf beliebigen Ports
  if (allowPrivate) return host;
  if (!ALLOWED_IMAP_PORTS.has(port)) throw new MailovoError('CONF-02', { detail: `port ${port} not allowed` });
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new MailovoError('CONF-02', { detail: `host ${host} not resolvable` });
  for (const a of addrs) {
    if (!isPublicAddress(a.address)) {
      throw new MailovoError('CONF-02', { detail: `host ${host} resolves to private address` });
    }
  }
  return addrs[0]!.address;
}

/** Hostname auflösen und nur öffentliche Ziele zulassen (für Abrufe wie Autoconfig) */
export async function isPublicHost(host: string): Promise<boolean> {
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  return addrs.length > 0 && addrs.every((a) => isPublicAddress(a.address));
}
