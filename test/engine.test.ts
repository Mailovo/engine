// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MailovoError } from '../src/errors.ts';
import { migrate, emptyState, totalsOf } from '../src/engine/migrate.ts';
import { planFolders } from '../src/engine/plan.ts';
import { MemoryStore, makeMessage } from '../src/mail/memory.ts';

function gmxLike() {
  const s = new MemoryStore('/');
  s.addFolder('INBOX');
  s.addFolder('Gesendet', { specialUse: '\\Sent' });
  s.addFolder('Entwürfe', { specialUse: '\\Drafts' });
  s.addFolder('Papierkorb', { specialUse: '\\Trash' });
  s.addFolder('Spamverdacht', { specialUse: '\\Junk' });
  s.addFolder('Rechnungen');
  s.addFolder('Rechnungen/2025');
  return s;
}

function gmailLike() {
  const s = new MemoryStore('/');
  s.addFolder('INBOX');
  s.addFolder('[Gmail]', { noselect: true });
  s.addFolder('[Gmail]/Gesendet', { specialUse: '\\Sent' });
  s.addFolder('[Gmail]/Entwürfe', { specialUse: '\\Drafts' });
  s.addFolder('[Gmail]/Papierkorb', { specialUse: '\\Trash' });
  s.addFolder('[Gmail]/Spam', { specialUse: '\\Junk' });
  s.addFolder('[Gmail]/Alle Nachrichten', { specialUse: '\\All' });
  return s;
}

test('Planung: Standardordner ins Gegenstück, eigene Ordner mit Hierarchie, Papierkorb/Spam standardmäßig nicht', async () => {
  const plan = planFolders(await gmxLike().listFolders(), await gmailLike().listFolders(), { includeTrash: false, includeJunk: false });
  const map = Object.fromEntries(plan.map((p) => [p.source, p.target]));
  assert.deepEqual(map, {
    INBOX: 'INBOX',
    Gesendet: '[Gmail]/Gesendet',
    'Entwürfe': '[Gmail]/Entwürfe',
    Rechnungen: 'Rechnungen',
    'Rechnungen/2025': 'Rechnungen/2025',
  });
  assert.equal(plan[0]!.source, 'INBOX');
  assert.equal(plan[1]!.source, 'Gesendet');
  assert.equal(plan.find((p) => p.source === 'Rechnungen')!.create, true);
});

test('Planung: Gmail als Quelle überspringt "Alle Nachrichten", Courier-Präfix "INBOX." wird umgesetzt', async () => {
  const src = gmailLike();
  const courier = new MemoryStore('.');
  courier.addFolder('INBOX');
  courier.addFolder('INBOX.Sent', { specialUse: '\\Sent' });
  courier.addFolder('INBOX.Archiv');
  const plan = planFolders(await src.listFolders(), await courier.listFolders(), {
    includeTrash: true,
    includeJunk: false,
    skipSpecialUse: ['\\All', '\\Flagged', '\\Important'],
  });
  const map = Object.fromEntries(plan.map((p) => [p.source, p.target]));
  assert.equal(map['[Gmail]/Alle Nachrichten'], undefined);
  assert.equal(map['[Gmail]/Gesendet'], 'INBOX.Sent');
  assert.equal(map['[Gmail]/Papierkorb'], 'INBOX.Papierkorb');
  assert.equal(map['[Gmail]/Spam'], undefined);
});

test('Planung: Trennzeichen im Namen wird ersetzt, "[Gmail]" als Name ist tabu', async () => {
  const src = new MemoryStore('.');
  src.addFolder('INBOX');
  src.addFolder('Kunden/Lieferanten', { delimiter: '.' });
  src.addFolder('[Gmail]', { delimiter: '.' });
  const plan = planFolders(await src.listFolders(), await gmailLike().listFolders(), { includeTrash: false, includeJunk: false });
  const targets = plan.map((p) => p.target);
  assert.ok(targets.includes('Kunden-Lieferanten'));
  assert.ok(targets.includes('Ordner'));
});

test('Umzug: kopiert alle Mails mit Flags und Datum, altes Postfach bleibt unverändert', async () => {
  const src = gmxLike();
  const d = new Date('2025-05-01T08:00:00Z');
  src.add('INBOX', makeMessage({ id: 'a@x', subject: 'Eins' }), ['\\Seen'], d);
  src.add('INBOX', makeMessage({ id: 'b@x', subject: 'Zwei' }), ['\\Flagged'], d);
  src.add('Gesendet', makeMessage({ id: 'c@x' }), ['\\Seen']);
  src.add('Rechnungen/2025', makeMessage({ id: 'd@x' }));
  src.add('Papierkorb', makeMessage({ id: 'e@x' }));
  const before = JSON.stringify([...src.folders.entries()]);

  const dst = gmailLike();
  const state = emptyState();
  const result = await migrate(src, dst, state, { includeTrash: false, includeJunk: false });

  assert.equal(result, 'done');
  assert.equal(dst.folders.get('INBOX')!.messages.length, 2);
  assert.deepEqual(dst.folders.get('INBOX')!.messages[0]!.flags, ['\\Seen']);
  assert.equal(dst.folders.get('INBOX')!.messages[0]!.date?.toISOString(), d.toISOString());
  assert.equal(dst.folders.get('[Gmail]/Gesendet')!.messages.length, 1);
  assert.equal(dst.folders.get('Rechnungen/2025')!.messages.length, 1);
  assert.equal(dst.folders.get('[Gmail]/Papierkorb')!.messages.length, 0);
  assert.equal(JSON.stringify([...src.folders.entries()]), before);

  const t = totalsOf(state);
  assert.equal(t.messages, 4);
  assert.equal(t.copied, 4);
});

test('Umzug: Duplikate (gleiche Message-ID) werden übersprungen', async () => {
  const src = gmxLike();
  src.add('INBOX', makeMessage({ id: 'a@x' }));
  src.add('INBOX', makeMessage({ id: 'b@x' }));
  const dst = gmailLike();
  dst.add('INBOX', makeMessage({ id: 'a@x' }));
  const state = emptyState();
  await migrate(src, dst, state, { includeTrash: false, includeJunk: false });
  assert.equal(dst.folders.get('INBOX')!.messages.length, 2);
  assert.equal(totalsOf(state).duplicates, 1);
});

test('Umzug: Pause und Fortsetzen kopieren nichts doppelt', async () => {
  const src = gmxLike();
  for (let i = 0; i < 10; i++) src.add('INBOX', makeMessage({ id: `m${i}@x` }));
  const dst = gmailLike();
  const state = emptyState();
  let seen = 0;
  const first = await migrate(src, dst, state, { includeTrash: false, includeJunk: false }, {
    onProgress: () => void seen++,
    shouldStop: () => seen >= 4,
  });
  assert.equal(first, 'stopped');
  assert.equal(dst.folders.get('INBOX')!.messages.length, 4);

  // Zustand über JSON schicken wie beim Speichern in der Datenbank
  const resumed = JSON.parse(JSON.stringify(state));
  const second = await migrate(src, dst, resumed, { includeTrash: false, includeJunk: false });
  assert.equal(second, 'done');
  assert.equal(dst.folders.get('INBOX')!.messages.length, 10);
  assert.equal(totalsOf(resumed).copied, 10);
});

test('Umzug: Netzabbruch mitten drin, danach Fortsetzung ab letzter Mail', async () => {
  const src = gmxLike();
  for (let i = 0; i < 6; i++) src.add('INBOX', makeMessage({ id: `n${i}@x` }));
  const dst = gmailLike();
  const state = emptyState();
  let downloads = 0;
  src.beforeDownload = () => {
    if (++downloads === 4) throw new MailovoError('NET-01', { retryable: true });
  };
  await assert.rejects(migrate(src, dst, state, { includeTrash: false, includeJunk: false }), (e: MailovoError) => e.code === 'NET-01');
  assert.equal(dst.folders.get('INBOX')!.messages.length, 3);

  src.beforeDownload = undefined;
  await migrate(src, dst, state, { includeTrash: false, includeJunk: false });
  assert.equal(dst.folders.get('INBOX')!.messages.length, 6);
});

test('Umzug: zu große Mails landen im Bericht, der Rest läuft weiter', async () => {
  const src = gmxLike();
  src.add('INBOX', makeMessage({ id: 'klein@x' }));
  src.add('INBOX', makeMessage({ id: 'gross@x', subject: 'Urlaubsvideo', bytes: 5000 }));
  const dst = gmailLike();
  dst.maxMessageBytes = 2000;
  const state = emptyState();
  await migrate(src, dst, state, { includeTrash: false, includeJunk: false });
  assert.equal(dst.folders.get('INBOX')!.messages.length, 1);
  assert.equal(state.skipped.length, 1);
  assert.equal(state.skipped[0]!.subject, 'Urlaubsvideo');
});

test('Umzug: Zielpostfach voll -> CAP-02', async () => {
  const src = gmxLike();
  src.add('INBOX', makeMessage({ id: 'a@x', bytes: 1500 }));
  src.add('INBOX', makeMessage({ id: 'b@x', bytes: 1500 }));
  const dst = gmailLike();
  dst.limitBytes = 2000;
  await assert.rejects(migrate(src, dst, emptyState(), { includeTrash: false, includeJunk: false }), (e: MailovoError) => e.code === 'CAP-02');
});

test('Umzug: Tageslimit erreicht -> RATE-01 mit Zeitpunkt zum Weitermachen', async () => {
  const src = gmxLike();
  for (let i = 0; i < 5; i++) src.add('INBOX', makeMessage({ id: `r${i}@x`, bytes: 1000 }));
  const dst = gmailLike();
  const state = emptyState();
  const now = new Date('2026-09-24T10:00:00Z');
  await assert.rejects(
    migrate(src, dst, state, { includeTrash: false, includeJunk: false, targetLimits: { dailyUploadBytes: 2500 } }, { now: () => now }),
    (e: MailovoError) => e.code === 'RATE-01' && e.retryAt!.getTime() > now.getTime() + 23 * 3600e3,
  );
  assert.equal(dst.folders.get('INBOX')!.messages.length, 2);

  // Einen Tag später geht es weiter
  const later = new Date('2026-09-25T10:10:00Z');
  await migrate(src, dst, state, { includeTrash: false, includeJunk: false, targetLimits: { dailyUploadBytes: 2500 } }, { now: () => later }).catch(() => {});
  assert.ok(dst.folders.get('INBOX')!.messages.length >= 4);
});

test('Gratis-Test: nur Mails ab Stichtag', async () => {
  const src = gmxLike();
  src.add('INBOX', makeMessage({ id: 'alt@x' }), [], new Date('2025-01-01'));
  src.add('INBOX', makeMessage({ id: 'neu@x' }), [], new Date('2026-09-10'));
  const dst = gmailLike();
  await migrate(src, dst, emptyState(), { includeTrash: false, includeJunk: false, since: new Date('2026-08-25') });
  assert.equal(dst.folders.get('INBOX')!.messages.length, 1);
});

test('Umzug: ein unlesbarer Ordner wird übersprungen und gemeldet, der Rest läuft weiter', async () => {
  const src = gmxLike();
  src.add('INBOX', makeMessage({ id: 'a@x' }));
  src.add('Rechnungen', makeMessage({ id: 'r@x' }));
  const originalWithFolder = src.withFolder.bind(src);
  src.withFolder = (path, fn) => (path === 'Rechnungen' ? Promise.reject(new MailovoError('INT-01', { detail: 'BAD Invalid mailbox name' })) : originalWithFolder(path, fn));
  const dst = gmailLike();
  const state = emptyState();
  assert.equal(await migrate(src, dst, state, { includeTrash: false, includeJunk: false }), 'done');
  assert.equal(dst.folders.get('INBOX')!.messages.length, 1);
  assert.deepEqual(state.failedFolders, [{ folder: 'Rechnungen', code: 'INT-01' }]);
});

test('Umzug: Netzfehler bleiben Fehler des ganzen Auftrags (kein stilles Überspringen)', async () => {
  const src = gmxLike();
  src.add('INBOX', makeMessage({ id: 'a@x' }));
  src.withFolder = () => Promise.reject(new MailovoError('NET-01', { retryable: true }));
  await assert.rejects(migrate(src, gmailLike(), emptyState(), { includeTrash: false, includeJunk: false }), (e: MailovoError) => e.code === 'NET-01');
});
