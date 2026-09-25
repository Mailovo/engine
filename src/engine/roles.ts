// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
// Rollen von Ordnern (Posteingang, Gesendet, Entwürfe …) zuverlässig erkennen, auch bei Servern
// ohne SPECIAL-USE-Kennzeichnung. Regeln:
//  1. INBOX ist immer der Posteingang (IMAP-Standard, Groß-/Kleinschreibung egal).
//  2. Verbindliche Server-Kennzeichnung (RFC 6154) gilt in jeder Tiefe.
//  3. Der Name zählt nur auf oberster Ebene bzw. direkt unter Gmails Systemordner,
//     damit ein eigener Ordner "Projekte/Gesendet" ein normaler Ordner bleibt.
import type { StoreFolder } from '../mail/store.ts';

export type Role = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged' | 'important';

/** Virtuelle Sammelordner enthalten nur Kopien aus anderen Ordnern und werden nie kopiert. */
export const VIRTUAL_ROLES: Role[] = ['all', 'flagged', 'important'];

export const FLAG_ROLE: Record<string, Role> = {
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'all',
  '\\Flagged': 'flagged',
  '\\Important': 'important',
};

/** Gmail legt Systemordner unter "[Gmail]" bzw. in Deutschland teils unter "[Google Mail]" ab. */
export const SYSTEM_CONTAINERS = new Set(['[gmail]', '[google mail]']);

// Gängige Namen in den geplanten Sprachen (DE, EN, FR, ES, IT, NL, PL) plus Varianten großer Anbieter.
// Alles klein und NFKC-normalisiert.
const NAMES: Record<Exclude<Role, 'inbox'>, string[]> = {
  sent: [
    'sent', 'sent items', 'sent messages', 'sent mail', 'sent-mail', 'sent email',
    'gesendet', 'gesendete', 'gesendete objekte', 'gesendete elemente', 'gesendete nachrichten', 'gesendete e-mails',
    'envoyés', 'envoyes', 'éléments envoyés', 'messages envoyés',
    'enviados', 'elementos enviados', 'correo enviado',
    'inviati', 'posta inviata', 'elementi inviati',
    'verzonden', 'verzonden items', 'verzonden berichten',
    'wysłane', 'elementy wysłane',
  ],
  drafts: [
    'drafts', 'draft', 'entwürfe', 'entwurf', 'brouillons', 'brouillon', 'borradores', 'borrador',
    'bozze', 'concepten', 'concept', 'kopie robocze', 'szkice',
  ],
  trash: [
    'trash', 'deleted', 'deleted items', 'deleted messages', 'bin',
    'papierkorb', 'gelöscht', 'gelöschte objekte', 'gelöschte elemente', 'gelöschte nachrichten', 'gelöschte e-mails',
    'corbeille', 'éléments supprimés', 'papelera', 'elementos eliminados',
    'cestino', 'posta eliminata', 'elementi eliminati',
    'prullenbak', 'verwijderde items', 'kosz', 'elementy usunięte',
  ],
  junk: [
    'junk', 'junk e-mail', 'junk email', 'junk-e-mail', 'junk mail', 'spam', 'spamverdacht', 'unerwünscht', 'bulk mail',
    'courrier indésirable', 'indésirables', 'pourriel', 'correo no deseado', 'no deseado',
    'posta indesiderata', 'ongewenste e-mail', 'ongewenst', 'wiadomości-śmieci',
  ],
  archive: ['archive', 'archiv', 'archives', 'archivio', 'archief', 'archiwum', 'archivo'],
  // Nur unter Gmails Systemordner als virtuell behandeln
  all: ['all mail', 'alle nachrichten', 'tous les messages', 'todos', 'tutti i messaggi', 'alle berichten', 'wszystkie'],
  flagged: ['starred', 'markiert', 'suivis', 'destacados', 'speciali', 'met ster', 'oznaczone gwiazdką'],
  important: ['important', 'wichtig', 'importants', 'importantes', 'importanti', 'belangrijk', 'ważne'],
};

const NAME_INDEX = new Map<string, Role>();
for (const [role, list] of Object.entries(NAMES) as [Role, string[]][]) for (const n of list) NAME_INDEX.set(n, role);

export const normalizeName = (s: string) => s.replace(/‎/g, '').trim().toLowerCase().normalize('NFKC');

export const isInbox = (path: string) => path.toUpperCase() === 'INBOX';

/** Namensraum-Präfix, z. B. "INBOX." bei Courier und manchen Dovecot-Servern. */
export function namespacePrefix(folders: StoreFolder[]): string {
  const others = folders.filter((f) => !isInbox(f.path));
  if (!others.length) return '';
  const delim = others[0]!.delimiter;
  const prefix = `INBOX${delim}`;
  return others.every((f) => f.path.toUpperCase().startsWith(prefix.toUpperCase())) ? prefix : '';
}

/** Pfadteile ohne Namensraum-Präfix und ohne Gmail-Systemordner. */
export function relativeSegments(f: StoreFolder, prefix: string): { segments: string[]; underSystem: boolean } {
  const rel = prefix && f.path.toUpperCase().startsWith(prefix.toUpperCase()) ? f.path.slice(prefix.length) : f.path;
  let segments = rel.split(f.delimiter);
  let underSystem = false;
  if (segments.length > 1 && SYSTEM_CONTAINERS.has(normalizeName(segments[0]!))) {
    segments = segments.slice(1);
    underSystem = true;
  }
  return { segments, underSystem };
}

export interface RoleInfo {
  role: Role | null;
  /** Vom Server gekennzeichnet (verbindlich) statt nur am Namen erkannt */
  authoritative: boolean;
  depth: number;
}

export function folderRole(f: StoreFolder, prefix: string): RoleInfo {
  const { segments, underSystem } = relativeSegments(f, prefix);
  const depth = segments.length;
  if (isInbox(f.path)) return { role: 'inbox', authoritative: true, depth: 0 };

  const flagRole = f.specialUse ? FLAG_ROLE[f.specialUse] : undefined;
  // imapflow meldet mit specialUseSource "name" auch Vermutungen anhand des Namens; die prüfen wir selbst.
  if (flagRole && f.specialUseSource !== 'name') return { role: flagRole, authoritative: true, depth };

  if (depth === 1) {
    const byName = NAME_INDEX.get(normalizeName(segments[0]!));
    if (byName) {
      // Virtuelle Rollen nur im Gmail-Systemordner, sonst könnte ein eigener Ordner "Wichtig" verschwinden
      if (VIRTUAL_ROLES.includes(byName) && !underSystem) return { role: null, authoritative: false, depth };
      return { role: byName, authoritative: false, depth };
    }
    if (flagRole && !VIRTUAL_ROLES.includes(flagRole)) return { role: flagRole, authoritative: false, depth };
  }
  return { role: null, authoritative: false, depth };
}

/** Beste Ordner je Rolle auf einer Seite: verbindlich vor Name, flach vor tief, dann mit mehr Mails. */
export function roleMap(folders: StoreFolder[], prefix: string): Map<Role, StoreFolder> {
  const best = new Map<Role, { f: StoreFolder; info: RoleInfo }>();
  for (const f of folders) {
    if (f.noselect) continue;
    const info = folderRole(f, prefix);
    if (!info.role) continue;
    const cur = best.get(info.role);
    const better =
      !cur ||
      (info.authoritative && !cur.info.authoritative) ||
      (info.authoritative === cur.info.authoritative && info.depth < cur.info.depth) ||
      (info.authoritative === cur.info.authoritative && info.depth === cur.info.depth && f.messages > cur.f.messages);
    if (better) best.set(info.role, { f, info });
  }
  return new Map([...best].map(([r, v]) => [r, v.f]));
}

/** Sprache des Zielpostfachs grob aus vorhandenen Ordnernamen schätzen (für neu anzulegende Standardordner). */
export function guessLanguage(folders: StoreFolder[]): 'de' | 'en' {
  const de = new Set(['gesendet', 'entwürfe', 'papierkorb', 'gelöscht', 'spamverdacht', 'archiv', 'gesendete objekte', 'gesendete elemente']);
  return folders.some((f) => de.has(normalizeName(f.path.split(f.delimiter).pop() ?? ''))) ? 'de' : 'en';
}

export const DEFAULT_NAMES: Record<'de' | 'en', Partial<Record<Role, string>>> = {
  de: { sent: 'Gesendet', drafts: 'Entwürfe', trash: 'Papierkorb', junk: 'Spam', archive: 'Archiv' },
  en: { sent: 'Sent', drafts: 'Drafts', trash: 'Trash', junk: 'Junk', archive: 'Archive' },
};
