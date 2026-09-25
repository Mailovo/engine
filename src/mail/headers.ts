// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
// Robuste Dekodierung von Kopfzeilen. imapflow liest Envelope-Texte als UTF-8. Ältere Mailprogramme
// schicken aber Umlaute als rohe 8-Bit-Bytes in Latin-1/Windows-1252 ohne MIME-Kodierung; dann wird aus
// "für" ein "f�r". In diesem Fall lesen wir die rohen Bytes der Kopfzeile und dekodieren sie selbst.

const utf8 = new TextDecoder('utf-8', { fatal: true });
const cp1252 = new TextDecoder('windows-1252');

/** Bytes als UTF-8, wenn gültig, sonst als Windows-1252 (Obermenge von Latin-1, kennt auch €). */
export function decodeBytes(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    return cp1252.decode(bytes);
  }
}

function decoderFor(charset: string): TextDecoder | null {
  try {
    // RFC 2231: "utf-8*de" trägt eine Sprachangabe
    return new TextDecoder(charset.split('*')[0]!.trim().toLowerCase());
  } catch {
    return null;
  }
}

/** MIME-Wörter nach RFC 2047 (=?utf-8?Q?f=C3=BCr?=), benachbarte Wörter ohne Leerraum dazwischen. */
export function decodeWords(text: string): string {
  return text.replace(/=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=(?:\s+(?==\?[^?\s]+\?[BbQq]\?))?/g, (_, charset: string, enc: string, data: string) => {
    const bytes =
      enc.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64')
        : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
    return decoderFor(charset)?.decode(bytes) ?? decodeBytes(bytes);
  });
}

/** Wert einer Kopfzeile als rohe Bytes aus einem Kopfbereich (gefaltete Zeilen werden zusammengeführt). */
export function rawHeader(block: Uint8Array, name: string): Buffer | undefined {
  // latin1 hält jedes Byte unverändert, damit die spätere Dekodierung die Originalbytes sieht
  const text = Buffer.from(block).toString('latin1').replace(/\r?\n[ \t]+/g, ' ');
  const prefix = `${name.toLowerCase()}:`;
  const line = text.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(prefix));
  return line === undefined ? undefined : Buffer.from(line.slice(prefix.length).trim(), 'latin1');
}

/** Nimmt den Text von imapflow, außer er enthält Ersatzzeichen; dann aus den rohen Bytes neu dekodieren. */
export function repairHeader(decoded: string | undefined, raw: Uint8Array | undefined): string | undefined {
  if (decoded === undefined || !decoded.includes('�') || !raw) return decoded;
  return decodeWords(decodeBytes(raw)).replace(/\s+/g, ' ').trim();
}
