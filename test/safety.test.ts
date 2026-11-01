// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
// Prüft den Quelltext der Kopier-Engine: Er darf keine Befehle enthalten, die in einem Postfach etwas löschen,
// verschieben oder umflaggen, und er schickt nichts ins Internet, schreibt keine Dateien, startet keine Programme.
// Im Mailovo-Hauptcode zusätzlich Werkzeuge, Sicherung, Kontakte/Kalender und Aufträge: auch dort nichts, was im
// Postfach löscht, verschiebt oder markiert, auch nicht über Umwege (Aliase, run()/exec() mit Rohbefehlen).
// Läuft im Mailovo-Hauptcode und genauso im veröffentlichten Paket (gleiche Ordnerstruktur, dort nur die Engine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`../src/${p}`, import.meta.url));
/** Alle .ts-Dateien unter src/<dir>, auch in Unterordnern, als "dir/datei.ts" */
const tsIn = (dir: string) =>
  (readdirSync(src(dir), { recursive: true }) as string[])
    .filter((f) => f.endsWith('.ts'))
    .map((f) => (dir ? `${dir}/` : '') + f.replaceAll('\\', '/'));
const files = ['errors.ts', ...tsIn('engine'), ...tsIn('mail')];

/** Nur im Hauptcode: Werkzeuge (große Mails, Newsletter), Sicherung als ZIP, Kontakte/Kalender, Aufträge */
const inMain = existsSync(src('app.ts'));
const SERVICE_DIRS = ['tools', 'backup', 'dav', 'jobs'];
/** Diese Dienste lesen das Postfach nur, sie schreiben in keins */
const READ_ONLY_DIRS = ['tools', 'backup'];
const serviceFiles = inMain ? SERVICE_DIRS.flatMap(tsIn) : [];

/** Kommentare entfernen, damit nur echter Code zählt */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** IMAP-Befehle, die im Postfach etwas verändern (oder es schreibend öffnen), direkt über run()/exec() von imapflow */
const IMAP_WRITE = ['STORE', 'EXPUNGE', 'COPY', 'MOVE', 'DELETE', 'RENAME', 'SUBSCRIBE', 'UNSUBSCRIBE', 'CLOSE', 'SELECT', 'APPEND', 'CREATE', 'SETACL', 'DELETEACL', 'SETQUOTA', 'SETMETADATA'];
// SQL mit denselben Wörtern (DELETE FROM, CREATE TABLE …) ist kein IMAP
const RAW_WRITE = new RegExp(
  `\\b(?:run|exec)\\(\\s*['"\`](?:UID\\s+)?(?:${IMAP_WRITE.join('|')})\\b(?!\\s+(?:FROM|TABLE|INDEX|UNIQUE|TRIGGER|VIEW|VIRTUAL|TEMP|TEMPORARY|IF|OR|INTO)\\b)`,
  'i',
);

/** Verändert ein Postfach: verboten in der Engine und in allen Diensten */
const MAILBOX: [RegExp, string][] = [
  [/\bmessageDelete\b/, 'Mails löschen'],
  [/\bmessageMove\b|\bmessageCopy\b/, 'Mails verschieben oder im Postfach kopieren'],
  [/\bmessageFlags(Add|Remove|Set)\b|\bsetFlagColor\b/, 'Markierungen ändern'],
  // Abonnieren nur automatisch durch mailboxCreate im neuen Postfach, nie von uns aus
  [/\bmailboxDelete\b|\bmailboxRename\b|\bmailboxSubscribe\b|\bmailboxUnsubscribe\b/, 'Ordner löschen, umbenennen oder abonnieren'],
  [/\bexpunge\b/i, 'endgültig löschen (EXPUNGE)'],
  [/\bmailboxClose\b/, 'Ordner schließen (CLOSE löscht als gelöscht markierte Mails endgültig)'],
  [/\bmailboxOpen\b/, 'Ordner ohne die lesende Sperre öffnen'],
  [RAW_WRITE, 'IMAP-Schreibbefehl direkt über run()/exec()'],
  [/\bsource\??\.(append|createFolder|put)\(/, 'ins alte Postfach oder Konto schreiben'],
];

/** Nur für die Engine: Die Dienste dürfen Dateien und Verbindungen nutzen (Datenbank, CardDAV, Abmeldelinks) */
const OUTSIDE: [RegExp, string][] = [
  [/['"]node:(fs|fs\/promises|child_process|http|https|http2|dgram|worker_threads|vm)['"]|\brequire\(/, 'Dateien, Programme oder eigene Internetverbindungen'],
  [/(?<![\w.])fetch\(|\bXMLHttpRequest\b|\bWebSocket\b/, 'Daten ins Internet senden'],
  [/\beval\(|\bnew Function\(/, 'fremden Code ausführen'],
];

const findings = (f: string, rules: [RegExp, string][]) => {
  const text = code(readFileSync(src(f), 'utf8'));
  return rules.filter(([re]) => re.test(text)).map(([, what]) => `${f}: ${what}`);
};

test('Quelltext der Kopier-Engine: nichts, was im Postfach löscht, verschiebt oder markiert, und keine Verbindungen nach außen', () => {
  assert.ok(files.length >= 9, `zu wenige Dateien gefunden: ${files.join(', ')}`);
  assert.deepEqual(files.flatMap((f) => findings(f, [...MAILBOX, ...OUTSIDE])), []);
});

test('Werkzeuge, Sicherung, Kontakte/Kalender und Aufträge: nichts, was im Postfach löscht, verschiebt oder markiert', { skip: !inMain && 'nur im Mailovo-Hauptcode' }, () => {
  for (const d of SERVICE_DIRS) assert.ok(serviceFiles.some((f) => f.startsWith(`${d}/`)), `keine Dateien in src/${d} gefunden`);
  const found = serviceFiles.flatMap((f) =>
    findings(f, READ_ONLY_DIRS.some((d) => f.startsWith(`${d}/`)) ? [...MAILBOX, [/\.(append|createFolder)\(/, 'in ein Postfach schreiben (liest nur)']] : MAILBOX),
  );
  assert.deepEqual(found, []);
});

test('Nur mail/imap.ts spricht IMAP (imapflow kommt nirgends sonst vor)', () => {
  const users = tsIn('').filter((f) => /['"]imapflow['"]|\bImapFlow\b/.test(code(readFileSync(src(f), 'utf8'))));
  assert.deepEqual(users, ['mail/imap.ts']);
});

test('IMAP: Ordner werden nur lesend geöffnet (EXAMINE), geschrieben wird nur mit Anlegen und Hinzufügen', () => {
  const imap = code(readFileSync(src('mail/imap.ts'), 'utf8'));
  const opens = imap.match(/getMailboxLock\([^)]*\)/g) ?? [];
  assert.ok(opens.length > 0);
  for (const o of opens) assert.match(o, /readOnly:\s*true/, `nicht lesend geöffnet: ${o}`);

  // Alle Namen der Verbindung: client (auch this.client, store.client), Aliase wie "const c = this.client"
  // und Parameter vom Typ ImapFlow
  const names = new Set(['client']);
  for (const m of imap.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=\s*(?:(?:\w+\.)?client|new ImapFlow)\b(?!\s*[.[(])/g)) names.add(m[1]!);
  for (const m of imap.matchAll(/\b(\w+)\s*:\s*ImapFlow\b/g)) names.add(m[1]!);
  const calls = new Map<string, number>();
  for (const n of names) {
    assert.doesNotMatch(imap, new RegExp(`\\{[^{}]*\\}\\s*=\\s*(?:\\w+\\.)?${n}\\b(?!\\s*[.[(])`), `Methoden nicht aus ${n} herauslösen`);
    assert.doesNotMatch(imap, new RegExp(`\\b${n}\\s*\\??\\.?\\[`), `${n}[…]: Methoden nur mit Namen aufrufen`);
    for (const m of imap.matchAll(new RegExp(`\\b${n}\\s*\\??\\.\\s*(\\w+)\\s*\\(`, 'g'))) calls.set(m[1]!, (calls.get(m[1]!) ?? 0) + 1);
  }
  // noop: hält wartende Verbindungen offen, ändert nichts
  const READ = ['connect', 'on', 'list', 'getMailboxLock', 'search', 'fetch', 'fetchOne', 'getQuota', 'noop', 'logout', 'close'];
  const WRITE = ['append', 'mailboxCreate'];
  assert.ok(calls.has('fetch') && calls.has('getMailboxLock'), `Aufrufe über Aliase nicht erkannt: ${[...calls.keys()].join(', ')}`);
  const unknown = [...calls.keys()].filter((c) => !READ.includes(c) && !WRITE.includes(c));
  assert.deepEqual(unknown, [], 'neue imapflow-Aufrufe erst prüfen und dann hier eintragen');
  // Die einzigen schreibenden Befehle: Ordner anlegen und Mail hinzufügen, je an genau einer Stelle (nur im neuen Postfach)
  assert.deepEqual(Object.fromEntries(WRITE.map((w) => [w, calls.get(w) ?? 0])), { append: 1, mailboxCreate: 1 });
});

test('Kontrolle: Die Suche erkennt verbotene Aufrufe auch über Umwege, SQL und Kommentare zählen nicht', () => {
  const hits = (snippet: string) => MAILBOX.filter(([re]) => re.test(code(snippet))).map(([, what]) => what);
  for (const bad of [
    `await client.messageFlagsAdd('1:*', ['\\\\Seen'])`,
    'const c = this.client; await c.messageDelete(uid)',
    `await client.run('EXPUNGE')`,
    'await this.client.exec(`UID STORE ${uid} +FLAGS (\\\\Deleted)`)',
    `await imap.exec('uid move', [])`,
    `await client.run("select", 'INBOX')`,
    'await client.mailboxClose()',
    `await client.mailboxOpen('INBOX')`,
    `await source.append('INBOX', raw, [])`,
  ]) {
    assert.notDeepEqual(hits(bad), [], bad);
  }
  for (const ok of [
    `db.exec('CREATE TABLE IF NOT EXISTS x (a TEXT)')`,
    `db.prepare('DELETE FROM x WHERE a = ?').run(1)`,
    'copy.exec(`DELETE FROM ${table}`)',
    `await target.append('INBOX', raw, [])`,
    '// client.messageDelete(1) steht nur im Kommentar',
  ]) {
    assert.deepEqual(hits(ok), [], ok);
  }
});
