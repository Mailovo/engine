// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MailovoError } from '../src/errors.ts';
import { migrate, emptyState, gapsOf, MAX_FAILED_STREAK, totalsOf } from '../src/engine/migrate.ts';
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

test('Umzug: eine unlesbare Mail bleibt im alten Postfach und steht im Bericht, der Rest läuft weiter', async () => {
  const src = gmxLike();
  for (const id of ['a@x', 'kaputt@x', 'c@x']) src.add('INBOX', makeMessage({ id, subject: id }));
  src.add('Rechnungen', makeMessage({ id: 'r@x' }));
  let tries = 0;
  src.beforeDownload = (_path, uid) => {
    if (uid === 2 && _path === 'INBOX') {
      tries++;
      throw new MailovoError('INT-01', { detail: 'NO Server error' });
    }
  };
  const dst = gmailLike();
  const state = emptyState();
  assert.equal(await migrate(src, dst, state, { includeTrash: false, includeJunk: false, retryDelayMs: 0 }), 'done');
  assert.equal(tries, 2, 'Lesen wird einmal wiederholt');
  assert.equal(dst.folders.get('INBOX')!.messages.length, 2);
  assert.equal(dst.folders.get('Rechnungen')!.messages.length, 1);
  const t = totalsOf(state);
  assert.deepEqual([t.copied, t.failed, t.processed, t.messages], [3, 1, 4, 4]);
  assert.deepEqual(state.unreadable, [{ folder: 'INBOX', subject: 'kaputt@x', size: state.unreadable![0]!.size, date: undefined, code: 'INT-01' }]);
  assert.equal(gapsOf(state).any, true);

  // Nachsendung: die unlesbare Mail wird nicht bei jedem Lauf wieder versucht und nicht doppelt gezählt
  src.beforeDownload = undefined;
  await migrate(src, dst, state, { includeTrash: false, includeJunk: false, retryDelayMs: 0 });
  assert.equal(totalsOf(state).failed, 1);
});

test('Umzug: vom neuen Postfach abgelehnte Mail wird nicht wiederholt (keine Dublette), aber gemeldet', async () => {
  const src = gmxLike();
  for (const id of ['a@x', 'b@x', 'c@x']) src.add('INBOX', makeMessage({ id }));
  const dst = gmailLike();
  let rejected = 0;
  dst.beforeAppend = (_path, content) => {
    if (content.includes('b@x')) {
      rejected++;
      throw new MailovoError('INT-01', { detail: 'NO [CANNOT] Invalid message' });
    }
  };
  const state = emptyState();
  assert.equal(await migrate(src, dst, state, { includeTrash: false, includeJunk: false, retryDelayMs: 0 }), 'done');
  assert.equal(rejected, 1);
  assert.deepEqual(
    dst.folders.get('INBOX')!.messages.map((m) => m.uid),
    [1, 2],
  );
  assert.deepEqual([totalsOf(state).copied, totalsOf(state).failed], [2, 1]);
});

test('Umzug: viele Fehlschläge nacheinander = grundsätzliches Problem, nichts wird übersprungen', async () => {
  const src = gmxLike();
  for (let i = 0; i < 8; i++) src.add('INBOX', makeMessage({ id: `m${i}@x` }));
  let broken = true;
  src.beforeDownload = (_path, uid) => {
    if (broken && uid >= 2) throw new MailovoError('INT-01', { detail: 'Server gestört' });
  };
  const dst = gmailLike();
  const state = emptyState();
  await assert.rejects(migrate(src, dst, state, { includeTrash: false, includeJunk: false, retryDelayMs: 0 }), (e: MailovoError) => e.code === 'INT-01');
  assert.equal(MAX_FAILED_STREAK, 5);
  assert.equal(totalsOf(state).failed, 0, 'nichts als unlesbar festgehalten');
  assert.equal(state.unreadable, undefined);
  assert.equal(state.folders.INBOX!.lastUid, 1, 'Fortsetzung beginnt vor den Fehlschlägen');

  broken = false;
  const resumed = JSON.parse(JSON.stringify(state));
  assert.equal(await migrate(src, dst, resumed, { includeTrash: false, includeJunk: false, retryDelayMs: 0 }), 'done');
  assert.equal(dst.folders.get('INBOX')!.messages.length, 8);
  assert.equal(totalsOf(resumed).failed, 0);
});

test('Umzug: "Aktuelles zuerst" überspringt eine unlesbare Mail nur vorläufig, der zweite Durchgang versucht sie erneut', async () => {
  const now = new Date('2026-09-20T12:00:00Z');
  const src = gmxLike();
  src.add('INBOX', makeMessage({ id: 'alt@x' }), [], new Date('2024-01-01'));
  src.add('INBOX', makeMessage({ id: 'neu@x' }), [], new Date('2026-09-19'));
  let fails = 2;
  src.beforeDownload = (_path, uid) => {
    if (uid === 2 && fails-- > 0) throw new MailovoError('INT-01');
  };
  const dst = gmailLike();
  const state = emptyState();
  await migrate(src, dst, state, { includeTrash: false, includeJunk: false, retryDelayMs: 0 }, { now: () => now });
  assert.equal(dst.folders.get('INBOX')!.messages.length, 2);
  assert.deepEqual([totalsOf(state).copied, totalsOf(state).failed], [2, 0]);
});

test('Umzug: neue UIDVALIDITY nach "Aktuelles zuerst": alte gemerkte UIDs überspringen keine Mails', async () => {
  const now = new Date('2026-09-20T12:00:00Z');
  const src = gmxLike();
  src.add('INBOX', makeMessage({ id: 'A@x' }), [], new Date('2024-01-01'));
  src.add('INBOX', makeMessage({ id: 'B@x' }), [], new Date('2024-02-01'));
  src.add('INBOX', makeMessage({ id: 'C@x' }), [], new Date('2026-09-18'));
  src.add('INBOX', makeMessage({ id: 'D@x' }), [], new Date('2026-09-19'));
  const dst = gmailLike();
  const state = emptyState();
  // Nach "Aktuelles zuerst" (C, D) anhalten
  let copied = 0;
  await migrate(src, dst, state, { includeTrash: false, includeJunk: false }, { now: () => now, onProgress: () => void copied++, shouldStop: () => copied >= 2 });
  assert.deepEqual(state.folders.INBOX!.early, [4, 3]);
  // Der Anbieter legt den Ordner neu an: gleiche Mails, neue UIDs in anderer Reihenfolge
  const f = src.folders.get('INBOX')!;
  f.uidValidity = '2';
  f.messages = [f.messages[3]!, f.messages[2]!, f.messages[1]!, f.messages[0]!].map((m, i) => ({ ...m, uid: i + 1 }));
  f.nextUid = 5;
  assert.equal(await migrate(src, dst, state, { includeTrash: false, includeJunk: false }, { now: () => now }), 'done');
  const ids = dst.folders.get('INBOX')!.messages.map((m) => /Message-ID: <([^>]+)>/.exec(m.content.toString())![1]).sort();
  assert.deepEqual(ids, ['A@x', 'B@x', 'C@x', 'D@x']);
});

test('Duplikat-Abgleich: verschiedene Mails mit gleichem Absender, Betreff und Zeitpunkt kommen alle an', async () => {
  const at = new Date('2026-05-01T08:00:00Z');
  const src = gmxLike();
  src.add('INBOX', makeMessage({ subject: 'Alarm', body: 'Sensor 1' }), [], at);
  src.add('INBOX', makeMessage({ subject: 'Alarm', body: 'Sensor 12' }), [], at);
  src.add('INBOX', makeMessage({ subject: 'Alarm', body: 'Sensor 123' }), [], at);
  const dst = gmailLike();
  const state = emptyState();
  await migrate(src, dst, state, { includeTrash: false, includeJunk: false, recentFirst: false });
  assert.equal(dst.folders.get('INBOX')!.messages.length, 3);
  assert.equal(totalsOf(state).duplicates, 0);
  // Fortsetzen erkennt die kopierten trotzdem als vorhanden
  const again = emptyState();
  await migrate(src, dst, again, { includeTrash: false, includeJunk: false, recentFirst: false });
  assert.equal(dst.folders.get('INBOX')!.messages.length, 3);
});

test('Duplikat-Abgleich: zwei verschiedene Mails mit derselben Message-ID in einem Lauf kommen beide an', async () => {
  const src = gmxLike();
  src.add('INBOX', makeMessage({ id: 'gleich@x', body: 'erste' }));
  src.add('INBOX', makeMessage({ id: 'gleich@x', body: 'zweite, andere Mail' }));
  src.add('INBOX', makeMessage({ id: 'gleich@x', body: 'erste' }));
  const dst = gmailLike();
  const state = emptyState();
  await migrate(src, dst, state, { includeTrash: false, includeJunk: false });
  assert.equal(dst.folders.get('INBOX')!.messages.length, 2, 'echte Dublette (gleich groß) nur einmal');
  assert.equal(totalsOf(state).duplicates, 1);
});
