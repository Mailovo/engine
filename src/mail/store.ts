// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
// Schmale Schnittstelle zwischen Kopier-Engine und Postfach.
// ImapStore (imap.ts) spricht echtes IMAP, MemoryStore (memory.ts) dient den Tests.
// Es gibt bewusst keinen Befehl zum Löschen, Verschieben oder Ändern von Markierungen: Das alte Postfach wird nur
// gelesen, ins neue kommen nur neue Ordner und Mails dazu (test/readonly.test.ts, test/safety.test.ts).

export type AuthKind = 'password' | 'app-password' | 'oauth-microsoft';

export interface ImapSettings {
  host: string;
  port: number;
  /** true = TLS direkt (993), false = STARTTLS (143) */
  secure: boolean;
}

export interface StoreFolder {
  path: string;
  delimiter: string;
  /** z. B. '\\Sent', '\\Trash' */
  specialUse?: string;
  /** Woher die Kennzeichnung stammt; "name" = nur am Namen vermutet (nicht verbindlich) */
  specialUseSource?: 'extension' | 'user' | 'name';
  /** Ordner ohne eigene Nachrichten (\Noselect) */
  noselect: boolean;
  messages: number;
}

export interface MessageMeta {
  uid: number;
  messageId?: string;
  /** Für den Abgleich gegen Doppelte und den Bericht (zu große Mails) */
  subject?: string;
  /** Absenderadresse (Kopfzeile From) für die Adress-Checkliste */
  from?: string;
  /** Anzeigename des Absenders, z. B. "Deutsche Bahn" */
  fromName?: string;
  /** Empfänger (To und Cc), nur für "Kontakte benachrichtigen" aus dem Ordner Gesendet */
  to?: { address: string; name?: string }[];
  /** Kopfzeile List-Unsubscribe (Newsletter abbestellen) */
  listUnsubscribe?: string;
  /** Abbestellen mit einem Klick nach RFC 8058 möglich */
  oneClickUnsubscribe?: boolean;
  size: number;
  flags: string[];
  internalDate?: Date;
}

export interface Quota {
  usedBytes: number;
  limitBytes: number;
}

export interface FolderHandle {
  /** Metadaten aller Nachrichten ab minUid, optional nur ab einem Datum; aufsteigend nach UID. */
  messages(opts?: { since?: Date; minUid?: number }): Promise<MessageMeta[]>;
  /** Duplikat-Schlüssel aller Mails im Ordner (Message-ID, sonst Fingerabdruck). */
  dedupeKeys(): Promise<Set<string>>;
  /** UIDVALIDITY des Ordners; ändert sie sich, sind alte UIDs ungültig. */
  uidValidity(): string | undefined;
  /** Vollständige Nachricht (RFC 822); wird unverändert ins neue Postfach übertragen, nie ausgewertet. */
  download(uid: number): Promise<Buffer>;
  /** Summe der Nachrichtengrößen in Bytes, optional ab Datum (für die Zusammenfassung vor dem Start). */
  totalSize(opts?: { since?: Date }): Promise<{ messages: number; bytes: number }>;
}

export interface MailStore {
  listFolders(): Promise<StoreFolder[]>;
  withFolder<T>(path: string, fn: (folder: FolderHandle) => Promise<T>): Promise<T>;
  /** Legt einen Ordner an; existiert er schon, passiert nichts. */
  createFolder(path: string): Promise<void>;
  append(path: string, content: Buffer, flags: string[], date?: Date): Promise<void>;
  quota(): Promise<Quota | null>;
  close(): Promise<void>;
}

export function normalizeMessageId(id: string | undefined | null): string | undefined {
  const v = id?.trim().replace(/^<|>$/g, '').toLowerCase();
  return v ? v : undefined;
}

/**
 * Schlüssel, an dem dieselbe Mail in beiden Postfächern erkannt wird: die Message-ID, und wo sie
 * fehlt ein Fingerabdruck aus Absender, Betreff und Eingangsdatum.
 */
export function dedupeKey(m: { messageId?: string; from?: string; subject?: string; internalDate?: Date }): string | undefined {
  if (m.messageId) return m.messageId;
  if (!m.internalDate || Number.isNaN(m.internalDate.getTime())) return undefined;
  const from = (m.from ?? '').trim().toLowerCase();
  const subject = (m.subject ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return `fp:${from}|${subject}|${Math.floor(m.internalDate.getTime() / 1000)}`;
}
