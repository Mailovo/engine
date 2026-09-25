// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
// Ordnerzuordnung alt -> neu.
// Standardordner (Posteingang, Gesendet, Entwürfe, Papierkorb, Spam, Archiv) landen im Gegenstück
// des Zielanbieters, egal wie sie dort heißen. Eigene Ordner behalten Namen und Hierarchie.
import type { StoreFolder } from '../mail/store.ts';
import {
  DEFAULT_NAMES,
  FLAG_ROLE,
  VIRTUAL_ROLES,
  folderRole,
  guessLanguage,
  isInbox,
  namespacePrefix,
  normalizeName,
  relativeSegments,
  roleMap,
  type Role,
} from './roles.ts';

export interface PlanOptions {
  includeTrash: boolean;
  includeJunk: boolean;
  /** Special-Use-Ordner der Quelle, die zusätzlich übersprungen werden */
  skipSpecialUse?: string[];
  /** Ausdrückliche Auswahl der Quellordner durch den Nutzer; ohne Angabe gelten die Standards */
  folders?: string[];
  /** Sprache für neu anzulegende Standardordner; sonst aus dem Ziel geschätzt (Sicherung: Sprache des Nutzers) */
  targetLang?: 'de' | 'en';
  /** Selbst gewählte Zielordner (Quellpfad -> Zielpfad) haben Vorrang vor der automatischen Zuordnung */
  folderMap?: Record<string, string>;
}

export interface FolderPlan {
  source: string;
  target: string;
  role: Role | null;
  /** Server-Kennzeichnung, falls vorhanden (für Bericht und Fehlersuche) */
  specialUse?: string;
  messages: number;
  /** Zielordner existiert noch nicht */
  create: boolean;
  /** Wird kopiert (Nutzerauswahl bzw. Standard) */
  include: boolean;
}

function sanitize(segment: string, targetDelimiter: string): string {
  const cleaned = segment
    .split(targetDelimiter)
    .join('-')
    .replace(/[\u0000-\u001f\u007f*%]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // "[Gmail]" / "[Google Mail]" sind bei Gmail reserviert
  return cleaned && !/^\[(gmail|google mail)\]$/i.test(cleaned) ? cleaned : 'Ordner';
}

// Exchange/Outlook zeigen über IMAP auch Kalender, Kontakte usw. als leere Ordner; die legen wir nicht an.
const NON_MAIL = new Set([
  'kalender', 'kontakte', 'aufgaben', 'notizen', 'journal', 'unterhaltungsverlauf', 'synchronisierungsprobleme',
  'calendar', 'contacts', 'tasks', 'notes', 'conversation history', 'sync issues',
]);

function defaultInclude(role: Role | null, opts: PlanOptions): boolean {
  if (role === 'trash') return opts.includeTrash;
  if (role === 'junk') return opts.includeJunk;
  return true;
}

/**
 * Plant alle kopierbaren Ordner. Mit `all: true` kommen auch abgewählte Ordner mit include=false
 * zurück (für die Auswahl in der Oberfläche); sonst nur die zu kopierenden.
 */
export function planFolders(source: StoreFolder[], target: StoreFolder[], opts: PlanOptions, { all = false } = {}): FolderPlan[] {
  const targetDelimiter = target.find((f) => !isInbox(f.path))?.delimiter ?? target[0]?.delimiter ?? '/';
  const sourcePrefix = namespacePrefix(source);
  const targetPrefix = namespacePrefix(target);
  const targetRoles = roleMap(target, targetPrefix);
  const targetPaths = new Set(target.map((f) => f.path));
  const lang = opts.targetLang ?? guessLanguage(target);
  const skip = new Set((opts.skipSpecialUse ?? []).map((f) => FLAG_ROLE[f]).filter(Boolean));
  // Unterordner des Posteingangs nur dann unter INBOX anlegen, wenn das Ziel das auch so macht
  const inboxChildrenOk =
    !!targetPrefix || target.some((f) => !isInbox(f.path) && f.path.toUpperCase().startsWith(`INBOX${f.delimiter}`.toUpperCase()));

  const plans: FolderPlan[] = [];
  for (const f of source) {
    if (f.noselect) continue;
    const { role, depth } = folderRole(f, sourcePrefix);
    if (role && (VIRTUAL_ROLES.includes(role) || skip.has(role))) continue;
    if (!role && depth === 1 && f.messages === 0 && NON_MAIL.has(normalizeName(relativeSegments(f, sourcePrefix).segments[0]!))) continue;

    let targetPath: string;
    if (role === 'inbox') {
      targetPath = 'INBOX';
    } else if (role) {
      const counterpart = targetRoles.get(role);
      targetPath = counterpart ? counterpart.path : targetPrefix + (DEFAULT_NAMES[lang][role] ?? relativeSegments(f, sourcePrefix).segments.pop()!);
    } else {
      let { segments } = relativeSegments(f, sourcePrefix);
      // Unterordner des Posteingangs ("INBOX/Rechnungen"): unter INBOX nur, wenn das Ziel das auch so macht
      const underInbox = !sourcePrefix && segments.length > 1 && isInbox(segments[0]!);
      if (underInbox) segments = segments.slice(1);
      let path = segments.map((s) => sanitize(s, targetDelimiter)).join(targetDelimiter);
      if (underInbox && inboxChildrenOk && !targetPrefix) path = `INBOX${targetDelimiter}${path}`;
      targetPath = targetPrefix + path;
    }

    const chosenTarget = opts.folderMap?.[f.path];
    if (chosenTarget) targetPath = chosenTarget;
    const include = opts.folders ? opts.folders.includes(f.path) : defaultInclude(role, opts);
    if (!include && !all) continue;
    plans.push({
      source: f.path,
      target: targetPath,
      role,
      specialUse: f.specialUse,
      messages: f.messages,
      create: !targetPaths.has(targetPath),
      include,
    });
  }

  // Posteingang zuerst, dann Gesendet, Entwürfe, eigene Ordner, Archiv, Papierkorb, Spam
  const order: (Role | null)[] = ['inbox', 'sent', 'drafts', null, 'archive', 'trash', 'junk'];
  const rank = (p: FolderPlan) => order.indexOf(p.role);
  return plans.sort((a, b) => rank(a) - rank(b) || a.source.localeCompare(b.source, 'de'));
}
