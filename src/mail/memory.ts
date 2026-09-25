// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
// Postfach im Arbeitsspeicher für Tests der Engine. Kann Fehler gezielt simulieren.
import { MailovoError } from '../errors.ts';
import { dedupeKey, normalizeMessageId, type FolderHandle, type MailStore, type MessageMeta, type Quota, type StoreFolder } from './store.ts';

export interface MemoryMessage {
  uid: number;
  content: Buffer;
  flags: string[];
  date?: Date;
}

interface MemoryFolder {
  /** Simuliert UIDVALIDITY; ändern, um "Ordner neu angelegt" zu testen */
  uidValidity: string;
  delimiter: string;
  specialUse?: string;
  specialUseSource?: 'extension' | 'user' | 'name';
  noselect: boolean;
  nextUid: number;
  messages: MemoryMessage[];
}

export function makeMessage(opts: {
  id?: string;
  subject?: string;
  body?: string;
  date?: Date;
  bytes?: number;
  from?: string;
  to?: string;
  headers?: string[];
}): Buffer {
  const headers = [
    opts.id ? `Message-ID: <${opts.id}>` : null,
    `Subject: ${opts.subject ?? 'Test'}`,
    `Date: ${(opts.date ?? new Date('2026-01-01T10:00:00Z')).toUTCString()}`,
    `From: ${opts.from ?? 'sender@example.com'}`,
    opts.to ? `To: ${opts.to}` : null,
    ...(opts.headers ?? []),
  ].filter(Boolean);
  const body = opts.body ?? 'Hallo';
  const pad = opts.bytes ? 'x'.repeat(Math.max(0, opts.bytes - body.length - 200)) : '';
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}${pad}\r\n`);
}

/** "Anna <a@b.de>, c@d.de" -> Adressen mit Namen (einfacher Parser für Tests) */
function addresses(value: string): { address: string; name?: string }[] {
  return value
    .split(',')
    .map((part) => {
      const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(part);
      if (m) return { address: m[2]!.trim(), name: m[1]!.trim() || undefined };
      const a = part.trim();
      return a.includes('@') ? { address: a } : null;
    })
    .filter((x): x is { address: string; name?: string } => !!x);
}

function header(content: Buffer, name: string): string | undefined {
  const head = content.toString('utf8').split('\r\n\r\n')[0] ?? '';
  return new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(head)?.[1]?.trim();
}

export class MemoryStore implements MailStore {
  folders = new Map<string, MemoryFolder>();
  /** Gesamtplatz in Bytes; undefined = unbegrenzt */
  limitBytes?: number;
  /** Wird vor jedem append aufgerufen; kann einen Fehler werfen. */
  beforeAppend?: (path: string, content: Buffer) => void;
  /** Wird vor jedem download aufgerufen; kann einen Fehler werfen. */
  beforeDownload?: (path: string, uid: number) => void;
  maxMessageBytes?: number;
  closed = false;
  private delimiter: string;

  constructor(delimiter = '/') {
    this.delimiter = delimiter;
  }

  addFolder(
    path: string,
    opts: { specialUse?: string; specialUseSource?: 'extension' | 'user' | 'name'; noselect?: boolean; delimiter?: string } = {},
  ): this {
    if (!this.folders.has(path)) {
      this.folders.set(path, {
        uidValidity: '1',
        delimiter: opts.delimiter ?? this.delimiter,
        specialUse: opts.specialUse,
        specialUseSource: opts.specialUseSource,
        noselect: opts.noselect ?? false,
        nextUid: 1,
        messages: [],
      });
    }
    return this;
  }

  add(path: string, content: Buffer, flags: string[] = [], date?: Date): number {
    this.addFolder(path);
    const f = this.folders.get(path)!;
    const uid = f.nextUid++;
    f.messages.push({ uid, content, flags, date });
    return uid;
  }

  usedBytes(): number {
    let n = 0;
    for (const f of this.folders.values()) for (const m of f.messages) n += m.content.length;
    return n;
  }

  async listFolders(): Promise<StoreFolder[]> {
    return [...this.folders.entries()].map(([path, f]) => ({
      path,
      delimiter: f.delimiter,
      specialUse: f.specialUse,
      specialUseSource: f.specialUseSource,
      noselect: f.noselect,
      messages: f.messages.length,
    }));
  }

  async withFolder<T>(path: string, fn: (folder: FolderHandle) => Promise<T>): Promise<T> {
    const f = this.folders.get(path);
    if (!f) throw new MailovoError('INT-01', { detail: `no folder ${path}` });
    const self = this;
    return fn({
      async messages(opts = {}): Promise<MessageMeta[]> {
        return f.messages
          .filter((m) => m.uid >= (opts.minUid ?? 1))
          .filter((m) => !opts.since || (m.date ?? new Date(0)) >= opts.since)
          .map((m) => ({
            uid: m.uid,
            messageId: normalizeMessageId(header(m.content, 'Message-ID')),
            subject: header(m.content, 'Subject'),
            from: /<([^>]+)>|(\S+@\S+)/.exec(header(m.content, 'From') ?? '')?.slice(1).find(Boolean),
            fromName: /^\s*"?([^"<]+?)"?\s*</.exec(header(m.content, 'From') ?? '')?.[1],
            to: addresses([header(m.content, 'To'), header(m.content, 'Cc')].filter(Boolean).join(', ')),
            listUnsubscribe: header(m.content, 'List-Unsubscribe'),
            oneClickUnsubscribe: /one-click/i.test(header(m.content, 'List-Unsubscribe-Post') ?? ''),
            size: m.content.length,
            flags: [...m.flags],
            internalDate: m.date,
          }));
      },
      async dedupeKeys() {
        const keys = f.messages.map((m) =>
          dedupeKey({
            messageId: normalizeMessageId(header(m.content, 'Message-ID')),
            from: /<([^>]+)>|(\S+@\S+)/.exec(header(m.content, 'From') ?? '')?.slice(1).find(Boolean),
            subject: header(m.content, 'Subject'),
            internalDate: m.date,
          }),
        );
        return new Set(keys.filter((x): x is string => !!x));
      },
      uidValidity() {
        return f.uidValidity;
      },
      async totalSize(opts = {}) {
        const list = f.messages.filter((m) => !opts.since || (m.date ?? new Date(0)) >= opts.since);
        return { messages: list.length, bytes: list.reduce((n, m) => n + m.content.length, 0) };
      },
      async download(uid) {
        self.beforeDownload?.(path, uid);
        const m = f.messages.find((x) => x.uid === uid);
        if (!m) throw new MailovoError('DATA-04', { detail: `no uid ${uid}` });
        return m.content;
      },
    });
  }

  async createFolder(path: string): Promise<void> {
    this.addFolder(path);
  }

  /** Reihenfolge der Kopien (Ordner:Message-ID), nur für Tests */
  appendLog: string[] = [];

  async append(path: string, content: Buffer, flags: string[], date?: Date): Promise<void> {
    this.beforeAppend?.(path, content);
    this.appendLog.push(`${path}:${normalizeMessageId(header(content, 'Message-ID')) ?? '?'}`);
    if (!this.folders.has(path)) throw new MailovoError('INT-01', { detail: `append to missing folder ${path}` });
    if (this.maxMessageBytes && content.length > this.maxMessageBytes) throw new MailovoError('DATA-02');
    if (this.limitBytes !== undefined && this.usedBytes() + content.length > this.limitBytes) throw new MailovoError('CAP-02');
    this.add(path, content, flags, date);
  }

  async quota(): Promise<Quota | null> {
    return this.limitBytes === undefined ? null : { usedBytes: this.usedBytes(), limitBytes: this.limitBytes };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
