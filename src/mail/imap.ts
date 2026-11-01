// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
import { ImapFlow, type ListResponse, type MailboxObject } from 'imapflow';
import { classify, type ClassifyContext } from '../errors.ts';
import { rawHeader, repairHeader } from './headers.ts';
import { dedupeKey, normalizeMessageId, type AuthKind, type FolderHandle, type ImapSettings, type MailStore, type MessageMeta, type Quota, type StoreFolder } from './store.ts';
import { assertPublicImapHost } from './net.ts';

export interface AccountAccess {
  imap: ImapSettings;
  username: string;
  password?: string;
  accessToken?: string;
  auth: AuthKind;
}

const KEEP_FLAGS = new Set(['\\Seen', '\\Answered', '\\Flagged', '\\Draft']);

/**
 * Ist die Verbindung weg, liefert imapflow bei fetch, fetchOne und search still "nichts" statt eines Fehlers.
 * Das darf nie als leerer Ordner oder gelöschte Mail gelten, sondern muss als Netzfehler (NET-01) wiederholt werden.
 */
function assertOpen(client: ImapFlow): asserts client is ImapFlow & { mailbox: MailboxObject } {
  if (!client.usable || !client.mailbox) throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
}

/**
 * UIDs als kurze Bereichsliste ("1:5,7,9:12"). imapflow hängt eine Liste sonst einzeln mit Kommas an: bei 158 000 Mails
 * eine Befehlszeile von rund 1 MB, die Server wie Dovecot (64 KB) ablehnen.
 */
export function uidRange(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j > i ? `${sorted[i]}:${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(',');
}

function keepFlag(flag: string): boolean {
  // Systemflags außer \Recent/\Deleted übernehmen, eigene Schlagwörter (z. B. $Forwarded) ebenfalls
  if (flag.startsWith('\\')) return KEEP_FLAGS.has(flag);
  return /^[\w$.-]+$/.test(flag);
}

/** Echte IMAP-Verbindung über imapflow. Fehler kommen immer als MailovoError mit Katalog-Code. */
export class ImapStore implements MailStore {
  private client: ImapFlow;
  private access: AccountAccess;
  private connected = false;
  private keepalive?: NodeJS.Timeout;

  /** So oft ein NOOP, solange die Verbindung wartet (z. B. die alte, während das neue Postfach gelesen wird) */
  static keepaliveMs = 2 * 60_000;

  /** Nur Entwicklung und Tests: Server im lokalen Netz erlauben (sonst nur geprüfte öffentliche Adressen) */
  static allowPrivateHosts = false;

  private constructor(access: AccountAccess, address: string) {
    this.access = access;
    this.client = new ImapFlow({
      host: address,
      // TLS prüft das Zertifikat weiter gegen den Hostnamen, auch wenn wir zur geprüften IP verbinden
      ...(address !== access.imap.host ? { servername: access.imap.host } : {}),
      port: access.imap.port,
      secure: access.imap.secure,
      auth: access.accessToken
        ? { user: access.username, accessToken: access.accessToken }
        : { user: access.username, pass: access.password ?? '' },
      logger: false,
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 5 * 60_000,
      disableAutoIdle: true,
      clientInfo: { name: 'Mailovo', vendor: 'Mailovo' },
    });
    // Unbehandelte 'error'-Events würden den Prozess beenden; Fehler kommen über die Aufrufe.
    this.client.on('error', () => {});
  }

  static async connect(access: AccountAccess, ctx: Partial<ClassifyContext> = {}): Promise<ImapStore> {
    // Bei jeder Verbindung neu auflösen und prüfen, dann genau diese Adresse nutzen (kein DNS-Rebinding)
    const address = await assertPublicImapHost(access.imap.host, access.imap.port, ImapStore.allowPrivateHosts);
    const store = new ImapStore(access, address);
    try {
      await store.client.connect();
      store.connected = true;
      // Ohne Befehl schließt imapflow die Verbindung nach socketTimeout (5 Min.), und Anbieter melden untätige Sitzungen
      // ab. Das traf beim Fortsetzen das alte Postfach, während das neue für den Abgleich minutenlang gelesen wurde.
      store.keepalive = setInterval(() => {
        if (store.client.usable) store.client.noop().catch(() => {});
      }, ImapStore.keepaliveMs);
      store.keepalive.unref();
      return store;
    } catch (err) {
      // Halb offene Verbindung nach fehlgeschlagener Anmeldung nicht liegen lassen
      store.client.close();
      throw classify(err, { stage: 'connect', auth: access.auth, ...ctx });
    }
  }

  private toError(err: unknown, stage: ClassifyContext['stage']) {
    return classify(err, { stage, auth: this.access.auth, hadConnected: this.connected });
  }

  get capabilities(): string[] {
    return [...this.client.capabilities.keys()];
  }

  async listFolders(): Promise<StoreFolder[]> {
    let list: ListResponse[];
    try {
      list = await this.client.list({ statusQuery: { messages: true } });
    } catch (err) {
      throw this.toError(err, 'list');
    }
    return list.map((f) => ({
      path: f.path,
      delimiter: f.delimiter || '/',
      specialUse: f.specialUse,
      specialUseSource: f.specialUseSource,
      noselect: f.flags.has('\\Noselect') || f.flags.has('\\NonExistent'),
      messages: f.status?.messages ?? 0,
    }));
  }

  async withFolder<T>(path: string, fn: (folder: FolderHandle) => Promise<T>): Promise<T> {
    let lock;
    try {
      lock = await this.client.getMailboxLock(path, { readOnly: true });
    } catch (err) {
      throw this.toError(err, 'read');
    }
    const client = this.client;
    const toError = this.toError.bind(this);
    const handle: FolderHandle = {
      async messages(opts = {}) {
        try {
          assertOpen(client);
          if (client.mailbox.exists === 0) return [];
          let range = `${Math.max(1, opts.minUid ?? 1)}:*`;
          if (opts.since) {
            const found = await client.search({ since: opts.since }, { uid: true });
            assertOpen(client);
            // imapflow verschluckt ein NO des Servers und liefert false: der Ordner wäre sonst still "leer"
            if (!Array.isArray(found)) throw Object.assign(new Error('search failed'), { code: 'ESEARCH' });
            const uids = found.filter((u) => u >= (opts.minUid ?? 1));
            if (!uids.length) return [];
            range = uidRange(uids);
          }
          const out: MessageMeta[] = [];
          // Rohkopf "Subject" zusätzlich, um falsch kodierte Umlaute reparieren zu können (headers.ts)
          const query = { uid: true, size: true, flags: true, internalDate: true, envelope: true, headers: ['subject', 'list-unsubscribe', 'list-unsubscribe-post'] };
          for await (const m of client.fetch(range, query, { uid: true })) {
            // "N:*" liefert bei leerem Rest die letzte Nachricht, auch wenn deren UID < N ist
            if (m.uid < (opts.minUid ?? 1)) continue;
            out.push({
              uid: m.uid,
              messageId: normalizeMessageId(m.envelope?.messageId),
              subject: repairHeader(m.envelope?.subject, m.headers && rawHeader(m.headers, 'subject')),
              from: m.envelope?.from?.[0]?.address,
              fromName: m.envelope?.from?.[0]?.name || undefined,
              to: [...(m.envelope?.to ?? []), ...(m.envelope?.cc ?? [])]
                .filter((a) => a.address)
                .map((a) => ({ address: a.address!, name: a.name || undefined })),
              listUnsubscribe: m.headers ? rawHeader(m.headers, 'list-unsubscribe')?.toString('latin1') : undefined,
              oneClickUnsubscribe: m.headers ? /one-click/i.test(rawHeader(m.headers, 'list-unsubscribe-post')?.toString('latin1') ?? '') : false,
              size: m.size ?? 0,
              flags: [...(m.flags ?? [])],
              internalDate: m.internalDate ? new Date(m.internalDate) : undefined,
            });
          }
          // Mittendrin abgebrochen: lieber neu lesen als mit einer halben Liste weitermachen
          assertOpen(client);
          return out.sort((a, b) => a.uid - b.uid);
        } catch (err) {
          throw toError(err, 'read');
        }
      },
      async dedupeKeys(opts = {}) {
        const keys = new Set<string>();
        try {
          assertOpen(client);
          if (client.mailbox.exists === 0) return keys;
          let range = '1:*';
          if (opts.since) {
            const found = await client.search({ since: opts.since }, { uid: true });
            assertOpen(client);
            // Nur eine Abkürzung: verweigert der Server die Suche, wie bisher den ganzen Ordner lesen
            if (Array.isArray(found)) {
              if (!found.length) return keys;
              range = uidRange(found);
            }
          }
          for await (const m of client.fetch(range, { uid: true, envelope: true, internalDate: true, size: true, headers: ['subject'] }, { uid: true })) {
            const key = dedupeKey({
              messageId: normalizeMessageId(m.envelope?.messageId),
              from: m.envelope?.from?.[0]?.address,
              // gleich dekodiert wie in messages(), sonst passt der Fingerabdruck nicht zusammen
              subject: repairHeader(m.envelope?.subject, m.headers && rawHeader(m.headers, 'subject')),
              internalDate: m.internalDate ? new Date(m.internalDate) : undefined,
              size: m.size,
            });
            if (key) keys.add(key);
          }
          // Halbe Liste hieße: schon vorhandene Mails würden doppelt abgelegt
          assertOpen(client);
          return keys;
        } catch (err) {
          throw toError(err, 'read');
        }
      },
      uidValidity() {
        const uv = client.mailbox ? client.mailbox.uidValidity : undefined;
        return uv === undefined ? undefined : String(uv);
      },
      async totalSize(opts = {}) {
        try {
          assertOpen(client);
          if (client.mailbox.exists === 0) return { messages: 0, bytes: 0 };
          let range = '1:*';
          if (opts.since) {
            const found = await client.search({ since: opts.since }, { uid: true });
            assertOpen(client);
            if (!Array.isArray(found)) throw Object.assign(new Error('search failed'), { code: 'ESEARCH' });
            if (!found.length) return { messages: 0, bytes: 0 };
            range = uidRange(found);
          }
          let messages = 0;
          let bytes = 0;
          for await (const m of client.fetch(range, { uid: true, size: true }, { uid: !!opts.since })) {
            messages++;
            bytes += m.size ?? 0;
          }
          assertOpen(client);
          return { messages, bytes };
        } catch (err) {
          throw toError(err, 'read');
        }
      },
      async download(uid) {
        try {
          assertOpen(client);
          const m = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
          if (m && m.source) return m.source;
          // Nur "gelöscht", wenn der Server auf offener Verbindung bestätigt, dass es die UID nicht mehr gibt.
          // Ohne Verbindung kommt hier kein Ergebnis; das hielt am 01.11.2026 150 000 Mails fälschlich für gelöscht.
          assertOpen(client);
          const still = await client.search({ uid: String(uid) }, { uid: true });
          // Verbindung steht, aber der Server verweigert die Suche: diese eine Mail gilt als nicht lesbar, nicht als gelöscht
          if (!Array.isArray(still)) throw Object.assign(new Error(`no search result for uid ${uid}`), { code: 'EUNREADABLE' });
          if (still.includes(uid)) throw Object.assign(new Error(`message ${uid} has no content`), { code: 'EUNREADABLE' });
          throw Object.assign(new Error('message vanished'), { code: 'EMISSING' });
        } catch (err) {
          throw toError(err, 'read');
        }
      },
      async newest(n) {
        try {
          assertOpen(client);
          const exists = client.mailbox.exists;
          if (!exists) return [];
          const out: { uid: number; messageId?: string }[] = [];
          for await (const m of client.fetch(`${Math.max(1, exists - n + 1)}:*`, { uid: true, envelope: true })) {
            out.push({ uid: m.uid, messageId: normalizeMessageId(m.envelope?.messageId) });
          }
          // Halbe Liste hieße: der Abgleich "altes und neues Postfach sind dasselbe" schlägt nicht an
          assertOpen(client);
          return out.sort((a, b) => a.uid - b.uid).slice(-n);
        } catch (err) {
          throw toError(err, 'read');
        }
      },
    };
    try {
      return await fn(handle);
    } finally {
      lock.release();
    }
  }

  async createFolder(path: string): Promise<void> {
    try {
      // Ohne Verbindung antwortet imapflow mit "nichts"; das darf nicht als angelegt gelten
      const res = await this.client.mailboxCreate(path);
      if (!res && !this.client.usable) throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
    } catch (err) {
      const e = err as { serverResponseCode?: string; responseText?: string };
      if (e.serverResponseCode === 'ALREADYEXISTS' || /already exists|exists/i.test(e.responseText ?? '')) return;
      throw this.toError(err, 'create');
    }
  }

  async append(path: string, content: Buffer, flags: string[], date?: Date): Promise<void> {
    try {
      // Ohne geöffneten Ordner (zusätzliche Verbindung nur zum Ablegen) weiß niemand, welche eigenen Schlagwörter der
      // Server annimmt; ein abgelehntes APPEND wäre schlimmer als ein fehlendes Schlagwort: dann nur Systemmarkierungen
      const keep = flags.filter((f) => keepFlag(f) && (this.client.mailbox || KEEP_FLAGS.has(f)));
      // imapflow lässt beim Hinzufügen nur Markierungen durch, die der gerade geöffnete Ordner als dauerhaft meldet. Offen
      // ist hier ein lesend geöffneter Ordner (Duplikat-Abgleich), und dafür melden viele Server PERMANENTFLAGS () (Dovecot,
      // Gmail): dann kämen alle Mails ungelesen und ohne Stern an. Für APPEND gilt diese Liste nicht; Systemmarkierungen
      // nimmt jeder Server an, eigene Schlagwörter nur, wenn der Server sie erlaubt.
      const open = this.client.mailbox;
      if (open && open.readOnly && open.permanentFlags && !open.permanentFlags.has('\\*')) {
        for (const f of keep) if (KEEP_FLAGS.has(f)) open.permanentFlags.add(f);
      }
      const res = await this.client.append(path, content, keep, date);
      if (res === false && !this.client.usable) throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
      if (res === false) throw Object.assign(new Error('append rejected'), { responseText: 'append rejected' });
    } catch (err) {
      throw this.toError(err, 'append');
    }
  }

  async quota(): Promise<Quota | null> {
    try {
      const q = await this.client.getQuota('INBOX');
      if (!q || !q.storage) return null;
      // imapflow rechnet KiB schon in Bytes um; das Feld heißt zur Laufzeit "usage" (Typ sagt "used").
      const s = q.storage as { used?: number; usage?: number; limit?: number };
      const used = s.usage ?? s.used;
      if (used == null || !s.limit) return null;
      return { usedBytes: used, limitBytes: s.limit };
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    clearInterval(this.keepalive);
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    }
  }
}
