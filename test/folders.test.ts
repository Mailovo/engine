// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
// Ordnerzuordnung mit Ordnerlisten, wie große Anbieter sie über IMAP melden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFolders, type PlanOptions } from '../src/engine/plan.ts';
import { folderRole } from '../src/engine/roles.ts';
import type { StoreFolder } from '../src/mail/store.ts';

type Spec = [path: string, specialUse?: string | null, extra?: Partial<StoreFolder>];
const box = (delimiter: string, specs: Spec[]): StoreFolder[] =>
  specs.map(([path, specialUse, extra]) => ({
    path,
    delimiter,
    specialUse: specialUse ?? undefined,
    noselect: false,
    messages: 5,
    ...extra,
  }));
const NOSELECT = { noselect: true, messages: 0 };

// ---- Ordnerlisten ----
const gmx = box('/', [['INBOX'], ['Gesendet', '\\Sent'], ['Entwürfe', '\\Drafts'], ['Gelöscht', '\\Trash'], ['Spamverdacht', '\\Junk'], ['Familie']]);
const gmxNoFlags = box('/', [['INBOX'], ['Gesendet'], ['Entwürfe'], ['Gelöscht'], ['Spamverdacht']]);
const gmailDe = box('/', [
  ['INBOX'],
  ['[Google Mail]', null, NOSELECT],
  ['[Google Mail]/Alle Nachrichten', '\\All'],
  ['[Google Mail]/Entwürfe', '\\Drafts'],
  ['[Google Mail]/Gesendet', '\\Sent'],
  ['[Google Mail]/Markiert', '\\Flagged'],
  ['[Google Mail]/Papierkorb', '\\Trash'],
  ['[Google Mail]/Spam', '\\Junk'],
  ['[Google Mail]/Wichtig', '\\Important'],
  ['Rechnungen'],
]);
const gmailEn = box('/', [
  ['INBOX'],
  ['[Gmail]', null, NOSELECT],
  ['[Gmail]/All Mail', '\\All'],
  ['[Gmail]/Drafts', '\\Drafts'],
  ['[Gmail]/Sent Mail', '\\Sent'],
  ['[Gmail]/Starred', '\\Flagged'],
  ['[Gmail]/Trash', '\\Trash'],
  ['[Gmail]/Spam', '\\Junk'],
  ['[Gmail]/Important', '\\Important'],
]);
// Exchange ohne SPECIAL-USE: nur Namen
const outlookDe = box('/', [
  ['INBOX'],
  ['Gesendete Elemente'],
  ['Gelöschte Elemente'],
  ['Junk-E-Mail'],
  ['Entwürfe'],
  ['Archiv'],
  ['Postausgang'],
  ['Kalender', null, { messages: 0 }],
  ['Kontakte', null, { messages: 0 }],
  ['Projekte'],
  ['Projekte/Gesendet'],
]);
const icloud = box('/', [['INBOX'], ['Sent Messages', '\\Sent'], ['Deleted Messages', '\\Trash'], ['Drafts', '\\Drafts'], ['Junk', '\\Junk'], ['Archive', '\\Archive']]);
const courier = box('.', [['INBOX'], ['INBOX.Sent'], ['INBOX.Drafts'], ['INBOX.Trash'], ['INBOX.Junk'], ['INBOX.Rechnungen'], ['INBOX.Rechnungen.2025']]);
const ionos = box('/', [['INBOX'], ['Gesendete Objekte'], ['Entwürfe'], ['Papierkorb'], ['Spam']]);

const STD: PlanOptions = { includeTrash: false, includeJunk: false };
const ALL: PlanOptions = { includeTrash: true, includeJunk: true };
const mapOf = (plan: { source: string; target: string }[]) => Object.fromEntries(plan.map((p) => [p.source, p.target]));

test('GMX -> Gmail (deutsch, [Google Mail])', () => {
  assert.deepEqual(mapOf(planFolders(gmx, gmailDe, ALL)), {
    INBOX: 'INBOX',
    Gesendet: '[Google Mail]/Gesendet',
    'Entwürfe': '[Google Mail]/Entwürfe',
    Familie: 'Familie',
    'Gelöscht': '[Google Mail]/Papierkorb',
    Spamverdacht: '[Google Mail]/Spam',
  });
  // Standard: Papierkorb und Spam bleiben weg
  assert.deepEqual(Object.keys(mapOf(planFolders(gmx, gmailDe, STD))), ['INBOX', 'Gesendet', 'Entwürfe', 'Familie']);
});

test('Gmail -> GMX ohne Server-Kennzeichnung: virtuelle Gmail-Ordner fallen weg, Namen werden erkannt', () => {
  const map: Record<string, string> = mapOf(planFolders(gmailDe, gmxNoFlags, ALL));
  assert.deepEqual(map, {
    INBOX: 'INBOX',
    '[Google Mail]/Gesendet': 'Gesendet',
    '[Google Mail]/Entwürfe': 'Entwürfe',
    Rechnungen: 'Rechnungen',
    '[Google Mail]/Papierkorb': 'Gelöscht',
    '[Google Mail]/Spam': 'Spamverdacht',
  });
  for (const virtual of ['Alle Nachrichten', 'Markiert', 'Wichtig']) assert.equal((map as Record<string, string>)[`[Google Mail]/${virtual}`], undefined);
});

test('Outlook (Exchange, deutsch, nur Namen) -> iCloud', () => {
  const map = mapOf(planFolders(outlookDe, icloud, ALL));
  assert.equal(map['Gesendete Elemente'], 'Sent Messages');
  assert.equal(map['Gelöschte Elemente'], 'Deleted Messages');
  assert.equal(map['Junk-E-Mail'], 'Junk');
  assert.equal(map['Entwürfe'], 'Drafts');
  assert.equal(map['Archiv'], 'Archive');
  assert.equal(map['Postausgang'], 'Postausgang', 'Postausgang ist kein Gesendet-Ordner');
  assert.equal(map['Kalender'], undefined, 'leere Exchange-Kalender werden nicht angelegt');
  assert.equal(map['Kontakte'], undefined);
  assert.equal(map['Projekte/Gesendet'], 'Projekte/Gesendet', 'eigener Unterordner "Gesendet" bleibt ein normaler Ordner');
});

test('Courier (INBOX.-Präfix) -> Gmail und zurück', () => {
  const toGmail = mapOf(planFolders(courier, gmailEn, ALL));
  assert.deepEqual(toGmail, {
    INBOX: 'INBOX',
    'INBOX.Sent': '[Gmail]/Sent Mail',
    'INBOX.Drafts': '[Gmail]/Drafts',
    'INBOX.Rechnungen': 'Rechnungen',
    'INBOX.Rechnungen.2025': 'Rechnungen/2025',
    'INBOX.Trash': '[Gmail]/Trash',
    'INBOX.Junk': '[Gmail]/Spam',
  });
  const back = mapOf(planFolders(gmailDe, courier, ALL));
  assert.equal(back['[Google Mail]/Gesendet'], 'INBOX.Sent');
  assert.equal(back['Rechnungen'], 'INBOX.Rechnungen');
  assert.equal(back['[Google Mail]/Papierkorb'], 'INBOX.Trash');
});

test('Fehlt im Ziel ein Standardordner, wird er in der Sprache des Ziels angelegt', () => {
  const target = box('/', [['INBOX'], ['Gesendet', '\\Sent']]);
  const plan = planFolders(icloud, target, ALL);
  const archive = plan.find((p) => p.source === 'Archive')!;
  assert.deepEqual([archive.target, archive.create], ['Archiv', true]);
  assert.equal(plan.find((p) => p.source === 'Deleted Messages')!.target, 'Papierkorb');
  const enTarget = box('/', [['INBOX'], ['Sent', '\\Sent']]);
  assert.equal(planFolders(gmx, enTarget, ALL).find((p) => p.source === 'Gelöscht')!.target, 'Trash');
});

test('Zwei Gesendet-Ordner in der Quelle landen beide im Gesendet-Ordner des Ziels', () => {
  const src = box('/', [['INBOX'], ['Sent'], ['Gesendete Objekte']]);
  const map = mapOf(planFolders(src, gmailDe, STD));
  assert.equal(map['Sent'], '[Google Mail]/Gesendet');
  assert.equal(map['Gesendete Objekte'], '[Google Mail]/Gesendet');
});

test('Unterordner des Posteingangs: bei Gmail nach oben, bei INBOX-Servern darunter', () => {
  const dovecot = box('/', [['INBOX'], ['INBOX/Rechnungen'], ['Sent', '\\Sent']]);
  assert.equal(mapOf(planFolders(dovecot, gmailDe, STD))['INBOX/Rechnungen'], 'Rechnungen');
  assert.equal(mapOf(planFolders(dovecot, courier, STD))['INBOX/Rechnungen'], 'INBOX.Rechnungen');
  const withChildren = box('/', [['INBOX'], ['INBOX/Alt']]);
  assert.equal(mapOf(planFolders(dovecot, withChildren, STD))['INBOX/Rechnungen'], 'INBOX/Rechnungen');
});

test('Namensvermutung von imapflow in tieferen Ebenen wird nicht übernommen', () => {
  const guessed: StoreFolder = { path: 'Kunden/Spam', delimiter: '/', specialUse: '\\Junk', specialUseSource: 'name', noselect: false, messages: 3 };
  assert.equal(folderRole(guessed, '').role, null);
  const authoritative: StoreFolder = { ...guessed, specialUseSource: 'extension' };
  assert.equal(folderRole(authoritative, '').role, 'junk');
});

test('Eigener Ordner "Wichtig" außerhalb von Gmail bleibt erhalten (nicht virtuell)', () => {
  const src = box('/', [['INBOX'], ['Wichtig'], ['Alle Nachrichten']]);
  const map = mapOf(planFolders(src, ionos, STD));
  assert.equal(map['Wichtig'], 'Wichtig');
  assert.equal(map['Alle Nachrichten'], 'Alle Nachrichten');
});

test('IONOS -> GMX: "Gesendete Objekte" und "Papierkorb" finden ihr Gegenstück', () => {
  const map = mapOf(planFolders(ionos, gmx, ALL));
  assert.equal(map['Gesendete Objekte'], 'Gesendet');
  assert.equal(map['Papierkorb'], 'Gelöscht');
  assert.equal(map['Spam'], 'Spamverdacht');
});

test('Nutzerauswahl: nur gewählte Ordner, mit all=true auch die abgewählten sichtbar', () => {
  const chosen = planFolders(gmx, gmailDe, { ...STD, folders: ['INBOX', 'Gelöscht'] });
  assert.deepEqual(chosen.map((p) => p.source), ['INBOX', 'Gelöscht']);
  const everything = planFolders(gmx, gmailDe, STD, { all: true });
  assert.equal(everything.length, 6);
  assert.equal(everything.find((p) => p.source === 'Gelöscht')!.include, false);
  assert.equal(everything.find((p) => p.source === 'Familie')!.include, true);
  assert.equal(everything.find((p) => p.source === 'Gesendet')!.role, 'sent');
});

test('Sonderzeichen und Trennzeichen im Namen', () => {
  const src = box('.', [['INBOX'], ['Kunden/Lieferanten'], ['[Gmail]']]);
  const targets = planFolders(src, gmailDe, STD).map((p) => p.target);
  assert.ok(targets.includes('Kunden-Lieferanten'));
  assert.ok(targets.includes('Ordner'));
});
