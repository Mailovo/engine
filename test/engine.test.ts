// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MailovoError } from '../src/errors.ts';
import { migrate, emptyState, gapsOf, MAX_FAILED_STREAK, totalsOf } from '../src/engine/migrate.ts';
import { planFolders } from '../src/engine/plan.ts';
import { MemoryStore, makeMessage } from '../src/mail/memory.ts';
import type { MessageMeta } from '../src/mail/store.ts';

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

test('Umzug: ein Ordner, der erst beim nächsten Lauf lesbar ist, gilt danach nicht mehr als Lücke', async () => {
  const src = gmxLike();
  src.add('INBOX', makeMessage({ id: 'a@x' }));
  src.add('Rechnungen', makeMessage({ id: 'r@x' }));
  const originalWithFolder = src.withFolder.bind(src);
  let broken = true;
  src.withFolder = (path, fn) => (broken && path === 'Rechnungen' ? Promise.reject(new MailovoError('INT-01', { detail: 'BAD' })) : originalWithFolder(path, fn));
  const dst = gmailLike();
  const state = emptyState();
  const opts = { includeTrash: false, includeJunk: false };
  await migrate(src, dst, state, opts);
  assert.deepEqual(gapsOf(state).folders, ['Rechnungen']);
  broken = false;
  await migrate(src, dst, state, opts);
  assert.equal(dst.folders.get('Rechnungen')!.messages.length, 1);
  assert.deepEqual(gapsOf(state).folders, []);
});

test('Nachsendung: im neuen Postfach wird nur ab dem Datum der neuen Mails abgeglichen, nicht der ganze Ordner', async () => {
  const src = gmxLike();
  src.add('INBOX', makeMessage({ id: 'alt@x' }), [], new Date('2025-01-01T10:00:00Z'));
  const dst = gmailLike();
  const state = emptyState();
  const opts = { includeTrash: false, includeJunk: false, recentFirst: false };
  assert.equal(await migrate(src, dst, state, opts), 'done');
  src.add('INBOX', makeMessage({ id: 'neu@x' }), [], new Date('2026-10-30T10:00:00Z'));
  const asked: (string | undefined)[] = [];
  const originalWithFolder = dst.withFolder.bind(dst);
  dst.withFolder = (path, fn) =>
    originalWithFolder(path, (f) => fn({ ...f, dedupeKeys: (o) => (asked.push(o?.since?.toISOString()), f.dedupeKeys(o)) }));
  assert.equal(await migrate(src, dst, state, opts), 'done');
  assert.deepEqual(asked, ['2026-10-28T10:00:00.000Z']);
  assert.equal(dst.folders.get('INBOX')!.messages.length, 2);
  // Schon vorhanden und neu: der eingeschränkte Abgleich erkennt die Kopie trotzdem
  src.add('INBOX', makeMessage({ id: 'neu@x' }), [], new Date('2026-10-30T10:00:00Z'));
  assert.equal(await migrate(src, dst, state, opts), 'done');
  assert.equal(dst.folders.get('INBOX')!.messages.length, 2);
});

test('Vorab laden: gleiches Ergebnis wie der Reihe nach (Doppelte, gelöschte, unlesbare Mails, Aktuelles zuerst, Pause)', async () => {
  const DAY = 86400e3;
  const run = async (prefetch: boolean) => {
    const src = gmxLike();
    for (let i = 1; i <= 40; i++) {
      // Die letzten fünf sind aktuell ("Aktuelles zuerst"), jede zehnte trägt dieselbe Message-ID
      const date = i > 35 ? new Date(Date.now() - (41 - i) * DAY) : new Date(Date.UTC(2025, 0, i));
      src.add('INBOX', makeMessage({ id: i % 10 === 0 ? 'doppelt@x' : `m${i}@x`, subject: `Mail ${i}` }), i % 3 ? [] : ['\\Seen'], date);
    }
    src.add('Rechnungen', makeMessage({ id: 'r@x', subject: 'Rechnung' }));
    const dst = gmailLike();
    dst.add('INBOX', makeMessage({ id: 'm5@x', subject: 'Mail 5' }), [], new Date(Date.UTC(2025, 0, 5)));
    const events: string[] = [];
    src.beforeDownload = (path, uid) => {
      events.push(`d${uid}`);
      if (path === 'INBOX' && uid === 7) throw new MailovoError('INT-01', { detail: 'kaputt' });
    };
    dst.beforeAppend = (_path, content) => {
      const nr = /Subject: Mail (\d+)/.exec(content.toString())?.[1] ?? '-';
      events.push(`a${nr}`);
      // Kundin löscht Mail 23 im alten Postfach, während Mail 15 abgelegt wird (nach der Pause, vor dem Vorab-Laden)
      if (nr === '15') src.folders.get('INBOX')!.messages = src.folders.get('INBOX')!.messages.filter((m) => m.uid !== 23);
    };
    const state = emptyState();
    const opts = { includeTrash: false, includeJunk: false, prefetch, retryDelayMs: 0 };
    let n = 0;
    assert.equal(await migrate(src, dst, state, opts, { onProgress: () => void n++, shouldStop: () => n >= 15 }), 'stopped');
    assert.equal(await migrate(src, dst, state, opts), 'done');
    const inbox = dst.folders.get('INBOX')!.messages.map((m) => `${/Subject: (.*)/.exec(m.content.toString())![1]}|${m.flags.join(',')}`);
    return { result: { totals: totalsOf(state), unreadable: state.unreadable, folders: state.folders, inbox }, events };
  };
  const fast = await run(true);
  const slow = await run(false);
  assert.deepEqual(fast.result, slow.result);
  // Die Sonderfälle kamen wirklich vor
  assert.deepEqual([slow.result.totals.vanished, slow.result.totals.failed, slow.result.totals.duplicates >= 1], [1, 1, true]);
  // Und es wird tatsächlich vorab geladen: Mail 2 kommt, bevor Mail 1 abgelegt ist
  assert.ok(fast.events.indexOf('d2') < fast.events.indexOf('a1'), fast.events.join(' '));
  assert.ok(slow.events.indexOf('d2') > slow.events.indexOf('a1'), slow.events.join(' '));
});

/** Weitere "Verbindung" ins selbe Postfach, die unterschiedlich lange braucht (zählt, wie viele gleichzeitig ablegen) */
function slowWriter(dst: MemoryStore, load: { now: number; most: number }) {
  return {
    async append(path: string, content: Buffer, flags: string[], date?: Date) {
      load.most = Math.max(load.most, ++load.now);
      try {
        await new Promise((r) => setTimeout(r, Math.random() * 4));
        await dst.append(path, content, flags, date);
      } finally {
        load.now--;
      }
    },
  };
}

test('Paralleles Ablegen: gleiches Ergebnis wie eine Mail nach der anderen (Fehler, zu groß, gelöscht, Doppelte, Pause)', async () => {
  const DAY = 86400e3;
  const run = async (writers: number) => {
    const src = gmxLike();
    for (let i = 1; i <= 60; i++) {
      // Die letzten fünf sind aktuell ("Aktuelles zuerst"), jede zehnte ist dieselbe Mail noch einmal
      const date = i > 55 ? new Date(Date.now() - (61 - i) * DAY) : new Date(Date.UTC(2025, 0, (i % 28) + 1));
      const content = i % 10 === 0 ? makeMessage({ id: 'doppelt@x', subject: 'Doppelt' }) : makeMessage({ id: `m${i}@x`, subject: `Mail ${i}`, bytes: i === 33 ? 5000 : undefined });
      src.add('INBOX', content, i % 3 ? [] : ['\\Seen'], date);
    }
    src.add('Rechnungen', makeMessage({ id: 'r@x', subject: 'Rechnung' }));
    const dst = gmailLike();
    dst.maxMessageBytes = 4000;
    dst.add('INBOX', makeMessage({ id: 'm5@x', subject: 'Mail 5' }), [], new Date(Date.UTC(2025, 0, 6)));
    src.beforeDownload = (path, uid) => {
      if (path === 'INBOX' && uid === 7) throw new MailovoError('INT-01', { detail: 'kaputt' });
    };
    dst.beforeAppend = (_path, content) => {
      const nr = /Subject: Mail (\d+)/.exec(content.toString())?.[1];
      // Kundin löscht Mail 48, während Mail 44 abgelegt wird; Mail 41 lehnt das neue Postfach ab
      if (nr === '44') src.folders.get('INBOX')!.messages = src.folders.get('INBOX')!.messages.filter((m) => m.uid !== 48);
      if (nr === '41') throw new MailovoError('INT-01', { detail: 'abgelehnt' });
    };
    const load = { now: 0, most: 0 };
    const opts = { includeTrash: false, includeJunk: false, retryDelayMs: 0, appendPool: Array.from({ length: writers - 1 }, () => slowWriter(dst, load)) };
    const state = emptyState();
    let n = 0;
    assert.equal(await migrate(src, dst, state, opts, { onProgress: () => void n++, shouldStop: () => n >= 20 }), 'stopped');
    assert.equal(await migrate(src, dst, state, opts), 'done');
    // Im neuen Postfach kann die Reihenfolge abweichen (gleichzeitig abgelegt), der Inhalt nicht
    const inbox = dst.folders.get('INBOX')!.messages.map((m) => `${/Subject: (.*)/.exec(m.content.toString())![1]}|${m.flags.join(',')}`).sort();
    return { result: { totals: totalsOf(state), unreadable: state.unreadable, skipped: state.skipped, folders: state.folders, inbox }, most: load.most };
  };
  const parallel = await run(3);
  const serial = await run(1);
  assert.deepEqual(parallel.result, serial.result);
  // Die Sonderfälle kamen wirklich vor, und es wurde wirklich gleichzeitig abgelegt
  const t = serial.result.totals;
  assert.deepEqual([t.vanished, t.failed, t.tooBig, t.duplicates >= 5], [1, 2, 1, true]);
  assert.ok(parallel.most >= 2, `gleichzeitig: ${parallel.most}`);
});

test('Paralleles Ablegen: eine langsame Ablage hält die anderen Verbindungen nicht auf, verbucht wird trotzdem der Reihe nach', async () => {
  const src = gmxLike();
  for (let i = 1; i <= 20; i++) src.add('INBOX', makeMessage({ id: `m${i}@x`, subject: `Mail ${i}` }), [], new Date(Date.UTC(2025, 0, i)));
  const dst = gmailLike();
  const finished: string[] = [];
  const writer = {
    async append(path: string, content: Buffer, flags: string[], date?: Date) {
      const nr = /Subject: Mail (\d+)/.exec(content.toString())![1]!;
      // Mail 1 braucht lange (wie die Ausreißer bei iCloud)
      await new Promise((r) => setTimeout(r, nr === '1' ? 150 : 1));
      await dst.append(path, content, flags, date);
      finished.push(nr);
    },
  };
  const order: number[] = [];
  const state = emptyState();
  const opts = { includeTrash: false, includeJunk: false, recentFirst: false, appendPool: [writer, writer] };
  assert.equal(await migrate(src, dst, state, opts, { onProgress: (s) => void order.push(s.folders.INBOX?.lastUid ?? 0) }), 'done');
  assert.ok(finished.indexOf('1') >= 4, `während Mail 1 hing, kamen andere an: ${finished.join(' ')}`);
  assert.deepEqual(order.filter((u, n) => u > 0 && u !== order[n - 1]), Array.from({ length: 20 }, (_, n) => n + 1), 'verbucht der Reihe nach');
  assert.equal(dst.folders.get('INBOX')!.messages.length, 20);
});

test('Neues Postfach "ausgelastet": nur diese Mail wird nach einer Pause noch einmal geschickt, kein Abbruch, keine Dublette', async () => {
  const busy = () => new MailovoError('NET-01', { retryable: true, detail: 'UNAVAILABLE | Server Busy. Please try again later. 110 NO [UNAVAILABLE] Server Busy.' });
  for (const appendPool of [undefined, 'pool'] as const) {
    const src = gmxLike();
    for (let i = 1; i <= 12; i++) src.add('INBOX', makeMessage({ id: `m${i}@x`, subject: `Mail ${i}` }), [], new Date(Date.UTC(2025, 0, i)));
    const dst = gmailLike();
    let refusals = 2;
    dst.beforeAppend = (_path, content) => {
      if (refusals > 0 && /Subject: Mail 5\r/.test(content.toString())) {
        refusals--;
        throw busy();
      }
    };
    const writer = { append: (path: string, c: Buffer, f: string[], d?: Date) => dst.append(path, c, f, d) };
    const opts = { includeTrash: false, includeJunk: false, busyDelaysMs: [0, 0, 0], appendPool: appendPool ? [writer, writer, writer] : undefined };
    const state = emptyState();
    assert.equal(await migrate(src, dst, state, opts), 'done', String(appendPool));
    const subjects = dst.folders.get('INBOX')!.messages.map((m) => /Subject: (.*)/.exec(m.content.toString())![1]);
    assert.deepEqual([subjects.length, new Set(subjects).size, totalsOf(state).copied], [12, 12, 12]);
  }
  // Bleibt es ausgelastet, ist es eine Störung des Auftrags (wird später wiederholt); andere Netzfehler sofort
  const src = gmxLike();
  src.add('INBOX', makeMessage({ id: 'a@x', subject: 'Mail 1' }));
  const dst = gmailLike();
  dst.beforeAppend = () => {
    throw busy();
  };
  await assert.rejects(migrate(src, dst, emptyState(), { includeTrash: false, includeJunk: false, busyDelaysMs: [0, 0, 0] }), (e: MailovoError) => e.code === 'NET-01');
  let calls = 0;
  dst.beforeAppend = () => {
    calls++;
    throw new MailovoError('NET-01', { retryable: true, detail: 'NoConnection | Connection not available' });
  };
  await assert.rejects(migrate(src, dst, emptyState(), { includeTrash: false, includeJunk: false, busyDelaysMs: [0, 0, 0] }), (e: MailovoError) => e.code === 'NET-01');
  assert.equal(calls, 1, 'Verbindung weg: nicht blind noch einmal schicken (könnte schon angekommen sein)');
});

test('Paralleles Ablegen: Postfach voll mitten im Stapel, danach weiter ohne Verlust und ohne Doppelte', async () => {
  const src = gmxLike();
  for (let i = 1; i <= 30; i++) src.add('INBOX', makeMessage({ id: `m${i}@x`, subject: `Mail ${i}` }), [], new Date(Date.UTC(2025, 0, i % 28 || 1)));
  const dst = gmailLike();
  let full = true;
  dst.beforeAppend = (_path, content) => {
    if (full && /Subject: Mail 13\r/.test(content.toString())) {
      full = false;
      throw new MailovoError('CAP-02');
    }
  };
  const load = { now: 0, most: 0 };
  const opts = { includeTrash: false, includeJunk: false, appendPool: [slowWriter(dst, load), slowWriter(dst, load), slowWriter(dst, load)] };
  const state = emptyState();
  await assert.rejects(migrate(src, dst, state, opts), (e: MailovoError) => e.code === 'CAP-02');
  assert.equal(await migrate(src, dst, state, opts), 'done');
  const subjects = dst.folders.get('INBOX')!.messages.map((m) => /Subject: (.*)/.exec(m.content.toString())![1]);
  assert.equal(subjects.length, 30);
  assert.equal(new Set(subjects).size, 30, 'keine Mail doppelt');
  const t = totalsOf(state);
  assert.equal(t.copied + t.duplicates, 30);
});

test('Umzug: sehr großer Ordner (200 000 Mails) sprengt beim Zählen nicht den Aufrufstapel', async () => {
  const src = gmxLike();
  const big: MessageMeta[] = Array.from({ length: 200_000 }, (_, i) => ({ uid: i + 1, size: 1000, flags: [] }));
  const originalWithFolder = src.withFolder.bind(src);
  src.withFolder = (path, fn) =>
    originalWithFolder(path, (f) => fn(path === 'INBOX' ? { ...f, messages: async (o = {}) => big.filter((m) => m.uid >= (o.minUid ?? 1)) } : f));
  const state = emptyState();
  assert.equal(await migrate(src, gmailLike(), state, { includeTrash: false, includeJunk: false }, { shouldStop: () => true }), 'stopped');
  assert.equal(state.folders.INBOX!.total, 200_000);
  assert.equal(state.folders.INBOX!.totalBytes, 200_000_000);
  assert.equal(state.folders.INBOX!.maxUid, 200_000);
});

test('Umzug: von abgebrochenen Läufen aufgeblähter Zählstand wird beim Fortsetzen richtiggestellt', async () => {
  const src = gmxLike();
  src.add('INBOX', makeMessage({ id: 'a@x' }));
  src.add('INBOX', makeMessage({ id: 'b@x' }));
  const dst = gmailLike();
  const state = emptyState();
  // Stand nach vier abgestürzten Läufen: total viermal erhöht, maxUid nie gesetzt, nichts kopiert
  state.folders.INBOX = { target: 'INBOX', total: 8, totalBytes: 800, lastUid: 0, maxUid: 0, copied: 0, duplicates: 0, tooBig: 0, bytes: 0, done: false };
  assert.equal(await migrate(src, dst, state, { includeTrash: false, includeJunk: false }), 'done');
  const t = totalsOf(state);
  assert.equal(t.messages, 2);
  assert.equal(t.processed, 2);
  assert.equal(dst.folders.get('INBOX')!.messages.length, 2);
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
