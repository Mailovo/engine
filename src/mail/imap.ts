// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
import { ImapFlow, type ListResponse } from 'imapflow';
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
          if (!client.mailbox || client.mailbox.exists === 0) return [];
          let range: string | number[] = `${Math.max(1, opts.minUid ?? 1)}:*`;
          if (opts.since) {
            const found = await client.search({ since: opts.since }, { uid: true });
            const uids = (found || []).filter((u) => u >= (opts.minUid ?? 1));
            if (!uids.length) return [];
            range = uids;
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
          return out.sort((a, b) => a.uid - b.uid);
        } catch (err) {
          throw toError(err, 'read');
        }
      },
      async dedupeKeys() {
        const keys = new Set<string>();
        try {
          if (!client.mailbox || client.mailbox.exists === 0) return keys;
          for await (const m of client.fetch('1:*', { uid: true, envelope: true, internalDate: true, headers: ['subject'] })) {
            const key = dedupeKey({
              messageId: normalizeMessageId(m.envelope?.messageId),
              from: m.envelope?.from?.[0]?.address,
              // gleich dekodiert wie in messages(), sonst passt der Fingerabdruck nicht zusammen
              subject: repairHeader(m.envelope?.subject, m.headers && rawHeader(m.headers, 'subject')),
              internalDate: m.internalDate ? new Date(m.internalDate) : undefined,
            });
            if (key) keys.add(key);
          }
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
          if (!client.mailbox || client.mailbox.exists === 0) return { messages: 0, bytes: 0 };
          let range: string | number[] = '1:*';
          if (opts.since) {
            const found = await client.search({ since: opts.since }, { uid: true });
            if (!found || !found.length) return { messages: 0, bytes: 0 };
            range = found;
          }
          let messages = 0;
          let bytes = 0;
          for await (const m of client.fetch(range, { uid: true, size: true }, { uid: !!opts.since })) {
            messages++;
            bytes += m.size ?? 0;
          }
          return { messages, bytes };
        } catch (err) {
          throw toError(err, 'read');
        }
      },
      async download(uid) {
        try {
          const m = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
          if (!m || !m.source) throw Object.assign(new Error('message vanished'), { code: 'EMISSING' });
          return m.source;
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
      await this.client.mailboxCreate(path);
    } catch (err) {
      const e = err as { serverResponseCode?: string; responseText?: string };
      if (e.serverResponseCode === 'ALREADYEXISTS' || /already exists|exists/i.test(e.responseText ?? '')) return;
      throw this.toError(err, 'create');
    }
  }

  async append(path: string, content: Buffer, flags: string[], date?: Date): Promise<void> {
    try {
      const res = await this.client.append(path, content, flags.filter(keepFlag), date);
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
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    }
  }
}
