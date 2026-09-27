// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
// Das Versprechen an die Kundschaft, als Test: Das alte Postfach wird beim Umzug nur gelesen.
// Jeder Zugriff wird aufgezeichnet, und das Postfach ist hinterher Byte für Byte dasselbe wie vorher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, migrate, totalsOf } from '../src/engine/migrate.ts';
import { MemoryStore, makeMessage } from '../src/mail/memory.ts';
import type { FolderHandle, MailStore } from '../src/mail/store.ts';

/** Alle erlaubten Zugriffe auf das alte Postfach: Ordner auflisten, Ordner lesend öffnen, Mails lesen */
const READ_ONLY = new Set(['listFolders', 'withFolder', 'folder.messages', 'folder.uidValidity', 'folder.download', 'folder.dedupeKeys', 'folder.totalSize', 'folder.newest']);

/** Postfach, das jeden Aufruf mitschreibt, auch an geöffneten Ordnern */
function recorded(store: MailStore) {
  const calls: string[] = [];
  const wrapFolder = (h: FolderHandle): FolderHandle =>
    new Proxy(h, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(`folder.${String(key)}`);
          return value.apply(target, args);
        };
      },
    });
  const proxy = new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(key));
        if (key === 'withFolder') {
          const [path, fn] = args as [string, (f: FolderHandle) => Promise<unknown>];
          return target.withFolder(path, (f) => fn(wrapFolder(f)));
        }
        return value.apply(target, args);
      };
    },
  });
  return { store: proxy as MailStore, calls };
}

/** Alles, was im Postfach steht: Ordner, UIDs, Markierungen, Inhalt */
const snapshot = (s: MemoryStore) =>
  JSON.stringify([...s.folders].map(([path, f]) => [path, f.uidValidity, f.messages.map((m) => [m.uid, [...m.flags].sort(), m.date?.toISOString(), m.content.toString('base64')])]));

test('Das alte Postfach bleibt unangetastet: nur lesen, nichts löschen, verschieben oder markieren', async () => {
  const old = new MemoryStore('/');
  old.addFolder('INBOX').addFolder('Gesendet', { specialUse: '\\Sent' }).addFolder('Papierkorb', { specialUse: '\\Trash' }).addFolder('Rechnungen/2025');
  old.add('INBOX', makeMessage({ id: 'ungelesen@x', subject: 'Noch nicht gelesen' }), [], new Date('2026-09-01'));
  old.add('INBOX', makeMessage({ id: 'wichtig@x', subject: 'Wichtig' }), ['\\Seen', '\\Flagged'], new Date('2026-08-01'));
  old.add('Gesendet', makeMessage({ id: 'gesendet@x' }), ['\\Seen'], new Date('2026-07-01'));
  old.add('Papierkorb', makeMessage({ id: 'weg@x' }), ['\\Seen', '\\Deleted'], new Date('2026-06-01'));
  old.add('Rechnungen/2025', makeMessage({ id: 'rechnung@x', subject: 'Rechnung' }), ['\\Seen'], new Date('2025-12-01'));
  const target = new MemoryStore('/');
  target.addFolder('INBOX').addFolder('Sent', { specialUse: '\\Sent' }).addFolder('Trash', { specialUse: '\\Trash' });

  const before = snapshot(old);
  const { store: source, calls } = recorded(old);
  const state = emptyState();

  // Erster Lauf, unterbrochen und fortgesetzt
  let n = 0;
  await migrate(source, target, state, { includeTrash: true, includeJunk: false }, { onProgress: () => void n++, shouldStop: () => n >= 2 });
  await migrate(source, target, state, { includeTrash: true, includeJunk: false });
  assert.equal(totalsOf(state).copied, 5);
  assert.equal(snapshot(old), before, 'altes Postfach nach dem Umzug unverändert');

  // Nachsendung: neue Mail kommt an, wird kopiert, das alte Postfach bleibt trotzdem, wie es ist
  old.add('INBOX', makeMessage({ id: 'neu@x', subject: 'Nach dem Umzug' }), [], new Date('2026-09-20'));
  const withNew = snapshot(old);
  await migrate(source, target, state, { includeTrash: true, includeJunk: false });
  assert.equal(totalsOf(state).copied, 6);
  assert.equal(snapshot(old), withNew, 'altes Postfach nach der Nachsendung unverändert');

  // Nur lesende Zugriffe
  const other = [...new Set(calls)].filter((c) => !READ_ONLY.has(c));
  assert.deepEqual(other, [], `unerwartete Zugriffe auf das alte Postfach: ${other.join(', ')}`);
  assert.ok(calls.includes('folder.download'), 'Mails wurden gelesen');
});
