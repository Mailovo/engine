# Mailovo Engine

Move IMAP mailboxes from one provider to another: resumable, without duplicates, and without ever changing the old
mailbox. This is the copy engine behind [Mailovo](https://mailovo.de). We publish it so that anyone can check what
happens to their emails during a move.

*Deutsch weiter unten.*

## Check it yourself: what happens to your emails

- **The old mailbox is only read.** Folders are opened read-only with the IMAP command `EXAMINE`
  (`getMailboxLock(path, { readOnly: true })` in [`src/mail/imap.ts`](src/mail/imap.ts)). The mail server itself
  then refuses any change. Emails are also fetched with `BODY.PEEK`, which doesn't set the “read” mark either.
- **There is no command to delete, move or re-flag.** The mailbox interface in
  [`src/mail/store.ts`](src/mail/store.ts) only knows: list folders, read emails, create a folder, add an email.
- **Only the new mailbox is written to.** [`src/engine/migrate.ts`](src/engine/migrate.ts) calls `createFolder` and
  `append` on the target only.
- **Contents are copied 1:1.** An email is downloaded and added to the new mailbox unchanged, never parsed and never
  stored. The saved state only holds counts, message numbers (UIDs), dates and folder names, plus subject, size and
  date of emails too large for the new mailbox (for the report).
- **Which headers are read, and why.** Message-ID, sender, subject and date, to recognise emails that are already in
  the new mailbox. Recipients, sender name and `List-Unsubscribe` are only handed to the caller (`observe`) for optional
  analyses of the Mailovo service; the engine keeps none of them.
- **No other connections.** Apart from resolving the server name and the two IMAP connections, the code opens no
  connections, writes no files and starts no programs.
- **Proven by tests.** [`test/readonly.test.ts`](test/readonly.test.ts) records every access to the old mailbox during
  a move, an interrupted move and the forwarding period, and compares the mailbox byte for byte before and after.
  [`test/safety.test.ts`](test/safety.test.ts) fails as soon as the code contains a command that deletes, moves or
  re-flags, accesses files, sends data to the internet or runs foreign code. Run them with `npm test`.

## What it does

- **Maps folders.** Standard folders (Inbox, Sent, Drafts, Trash, Junk, Archive) land in their counterpart on the
  target, whatever they are called there: German or English names, special-use flags, Gmail's `[Gmail]` and
  `[Google Mail]`, servers with an `INBOX.` prefix. Your own folders keep their names and hierarchy. Gmail's virtual
  folders (All Mail, Starred, Important) are skipped, so nothing arrives twice.
- **Copies message by message** with the original date and flags (seen, answered, flagged, draft, custom keywords).
- **Never duplicates.** Messages already in the target (by Message-ID, otherwise sender, subject and date) are
  skipped, also when a move is repeated.
- **Resumes.** The state is a plain JSON object, saved every 20 messages. After an interruption the move continues
  where it stopped. A changed UIDVALIDITY is detected.
- **Recent first.** Emails of the last 30 days arrive before older ones, so the new mailbox is usable right away.
- **Keeps in sync.** Running it again only copies emails that arrived since the last run (forwarding period).
- **Respects provider limits.** Daily download and upload limits; messages too large for the target are reported
  instead of failing the whole move.
- **Only reads the old mailbox.** Nothing is deleted, moved or flagged there.
- **Explains errors.** Codes such as `AUTH-01` (wrong password), `AUTH-02` (app password needed), `CAP-02` (target
  full), `RATE-01` (daily limit) or `NET-01` (connection lost). Problems with a single folder don't stop the move.
- **Guards the network.** Connections only to public addresses on the IMAP ports 993 and 143, pinned to the checked
  address (no DNS rebinding).

## What it doesn't include

The service around it stays closed: web app, address checklist, newsletter and contact lists, contacts and calendars,
help bot, accounts, billing, notifications and the Microsoft sign-in.

## Usage

Node.js 24 or newer (runs TypeScript directly). The only dependency is [imapflow](https://github.com/postalsys/imapflow).

```ts
import { ImapStore, migrate, emptyState, totalsOf } from '@mailovo/engine';

const source = await ImapStore.connect({
  imap: { host: 'imap.gmx.net', port: 993, secure: true },
  username: 'anna@gmx.de',
  password: process.env.SOURCE_PASSWORD,
  auth: 'password',
});
const target = await ImapStore.connect({
  imap: { host: 'imap.gmail.com', port: 993, secure: true },
  username: 'anna@gmail.com',
  password: process.env.TARGET_APP_PASSWORD,
  auth: 'app-password',
});

const state = emptyState(); // or the JSON you saved last time
const result = await migrate(source, target, state, { includeTrash: false, includeJunk: false }, {
  onProgress: (s) => console.log(`${totalsOf(s).processed} of ${totalsOf(s).messages}`),
  checkpoint: (s) => saveSomewhere(JSON.stringify(s)),
});
console.log(result); // 'done' or 'stopped'

await source.close();
await target.close();
```

For providers that only allow OAuth (Outlook, Microsoft 365) pass `accessToken` instead of `password`.
`MemoryStore` is an in-memory mailbox for tests.

## Tests

```bash
npm test
```

The tests use in-memory mailboxes and need no network. `readonly.test.ts` and `safety.test.ts` check the promises
above.

## Background

How Mailovo works, what we store and when we delete it: <https://mailovo.de/how-we-work/> and
<https://mailovo.de/security/>.

Please report security issues privately via GitHub (**Security → Report a vulnerability**), not as public issues.

The code comes from the Mailovo main repository and is synced here; comments are in German. Issues and pull requests
are welcome, we port accepted changes into the main code.

## License

[MIT](LICENSE)

---

## Deutsch

Die Kopier-Engine von [Mailovo](https://mailovo.de): zieht IMAP-Postfächer um, fortsetzbar, ohne doppelte Mails und
ohne das alte Postfach zu verändern. Wir veröffentlichen sie, damit jede und jeder nachsehen kann, was bei einem Umzug
mit den E-Mails passiert.

**Selbst nachprüfen:**

- Das alte Postfach wird nur lesend geöffnet (IMAP-Befehl `EXAMINE`, `readOnly: true` in `src/mail/imap.ts`). Der
  Mailserver selbst lässt dann keine Änderung zu. Zusätzlich werden Mails mit `BODY.PEEK` abgerufen, das setzt auch
  die Markierung „gelesen“ nicht.
- Die Schnittstelle zum Postfach (`src/mail/store.ts`) kennt gar keinen Befehl zum Löschen, Verschieben oder
  Umflaggen. Geschrieben wird nur ins neue Postfach: Ordner anlegen, Mail hinzufügen.
- Der Inhalt einer Mail wird unverändert übertragen, nie ausgewertet und nie gespeichert.
- Außer den beiden IMAP-Verbindungen baut der Code keine Verbindungen auf, schreibt keine Dateien und startet keine
  Programme.
- Zwei Tests belegen das: `test/readonly.test.ts` vergleicht das alte Postfach vor und nach dem Umzug Byte für Byte,
  `test/safety.test.ts` schlägt fehl, sobald ein Befehl zum Löschen, Verschieben oder Umflaggen, ein Dateizugriff oder
  eine Verbindung nach außen im Code steht. Ausführen mit `npm test`.

Enthalten sind die Ordnerzuordnung (Standardordner landen im Gegenstück des neuen Anbieters, eigene Ordner behalten
Namen und Aufbau), das Kopieren mit Datum und Markierungen, der Abgleich gegen Doppelte, das Fortsetzen nach einer
Unterbrechung, „Aktuelles zuerst“, die Nachsendung, Anbieterlimits, verständliche Fehlercodes und der Schutz vor
Verbindungen ins interne Netz. Das alte Postfach wird nur gelesen.

Nicht enthalten ist alles rund um den Dienst: Website, Adress-Checkliste, Newsletter- und Kontaktlisten, Kontakte und
Kalender, Helferbot, Konten, Abrechnung, Benachrichtigungen und die Anmeldung bei Microsoft.
