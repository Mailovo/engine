// Mailovo Engine: IMAP-Postfächer umziehen, fortsetzbar, ohne Doppelte, ohne das alte Postfach zu verändern.
// Öffentliche Schnittstelle. Die Dateien unter src/ kommen aus dem Mailovo-Hauptcode (oss/sync-engine.mjs).

// Umzug ausführen, fortsetzen, Nachsendung
export {
  migrate,
  emptyState,
  totalsOf,
  capFor,
  isFolderLevel,
  gapsOf,
  RECENT_DAYS,
  MAX_FAILED_STREAK,
  type MigrationState,
  type MigrationOptions,
  type MigrationHooks,
  type FolderState,
  type Observer,
  type Totals,
} from './src/engine/migrate.ts';

// Ordnerzuordnung alt -> neu (Standardordner je Anbieter und Sprache)
export { planFolders, type FolderPlan, type PlanOptions } from './src/engine/plan.ts';
export { folderRole, guessLanguage, DEFAULT_NAMES, VIRTUAL_ROLES, type Role, type RoleInfo } from './src/engine/roles.ts';

// Postfach-Schnittstelle und Umsetzungen
export type { MailStore, ReadableMailStore, FolderHandle, MessageMeta, StoreFolder, Quota, AuthKind, ImapSettings } from './src/mail/store.ts';
export { dedupeKey, normalizeMessageId } from './src/mail/store.ts';
export { ImapStore, type AccountAccess } from './src/mail/imap.ts';
export { MemoryStore, makeMessage } from './src/mail/memory.ts';

// Fehlercodes und Netzwerkschutz
export { MailovoError, classify, type ErrorCode } from './src/errors.ts';
export { assertPublicImapHost, isPublicAddress, ALLOWED_IMAP_PORTS } from './src/mail/net.ts';
