// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
// Prüft den Quelltext der Kopier-Engine: Er darf keine Befehle enthalten, die in einem Postfach etwas löschen,
// verschieben oder umflaggen, und er schickt nichts ins Internet, schreibt keine Dateien, startet keine Programme.
// Läuft im Mailovo-Hauptcode und genauso im veröffentlichten Paket (gleiche Ordnerstruktur).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`../src/${p}`, import.meta.url));
const files = [
  'errors.ts',
  ...readdirSync(src('engine')).filter((f) => f.endsWith('.ts')).map((f) => `engine/${f}`),
  ...readdirSync(src('mail')).filter((f) => f.endsWith('.ts')).map((f) => `mail/${f}`),
];

/** Kommentare entfernen, damit nur echter Code zählt */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

const FORBIDDEN: [RegExp, string][] = [
  [/\bmessageDelete\b/, 'Mails löschen'],
  [/\bmessageMove\b|\bmessageCopy\b/, 'Mails verschieben oder im Postfach kopieren'],
  [/\bmessageFlags(Add|Remove|Set)\b|\bsetFlagColor\b/, 'Markierungen ändern'],
  [/\bmailboxDelete\b|\bmailboxRename\b|\bmailboxSubscribe\b|\bmailboxUnsubscribe\b/, 'Ordner löschen, umbenennen oder abonnieren'],
  [/\bexpunge\b|\bEXPUNGE\b/, 'endgültig löschen (EXPUNGE)'],
  [/['"]node:(fs|fs\/promises|child_process|http|https|http2|dgram|worker_threads|vm)['"]|\brequire\(/, 'Dateien, Programme oder eigene Internetverbindungen'],
  [/(?<![\w.])fetch\(|\bXMLHttpRequest\b|\bWebSocket\b/, 'Daten ins Internet senden'],
  [/\beval\(|\bnew Function\(/, 'fremden Code ausführen'],
];

test('Quelltext der Kopier-Engine: nichts, was im Postfach löscht, verschiebt oder markiert, und keine Verbindungen nach außen', () => {
  assert.ok(files.length >= 9, `zu wenige Dateien gefunden: ${files.join(', ')}`);
  const found: string[] = [];
  for (const f of files) {
    const text = code(readFileSync(src(f), 'utf8'));
    for (const [re, what] of FORBIDDEN) if (re.test(text)) found.push(`${f}: ${what}`);
  }
  assert.deepEqual(found, []);
});

test('IMAP: Ordner werden nur lesend geöffnet (EXAMINE), geschrieben wird nur mit Anlegen und Hinzufügen', () => {
  const imap = code(readFileSync(src('mail/imap.ts'), 'utf8'));
  const opens = imap.match(/getMailboxLock\([^)]*\)/g) ?? [];
  assert.ok(opens.length > 0);
  for (const o of opens) assert.match(o, /readOnly:\s*true/, `nicht lesend geöffnet: ${o}`);
  assert.doesNotMatch(imap, /\bmailboxOpen\(/, 'Ordner nur über die lesende Sperre öffnen');
  // Die einzigen schreibenden Befehle: Ordner anlegen und Mail hinzufügen (beides nur im neuen Postfach)
  const writes = [...imap.matchAll(/this\.client\.(\w+)\(/g)].map((m) => m[1]).filter((m) => !['list', 'getMailboxLock', 'connect', 'close', 'logout', 'getQuota', 'on'].includes(m!));
  assert.deepEqual([...new Set(writes)].sort(), ['append', 'mailboxCreate']);
});
