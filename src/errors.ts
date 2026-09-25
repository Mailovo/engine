// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
// Fehlerkatalog (Plan, Abschnitt B3). Jeder Fehler bekommt einen Code; die Oberfläche übersetzt
// den Code in Klartext mit Lösung. Rohe Servermeldungen gehen nie an Nutzer, nur ins Protokoll.

export type ErrorCode =
  | 'AUTH-01' // Passwort passt nicht
  | 'AUTH-02' // App-Passwort nötig (Gmail, iCloud, Yahoo …)
  | 'AUTH-03' // 2FA nicht aktiv, daher kein App-Passwort möglich (nur über Nutzerrückmeldung)
  | 'AUTH-04' // Microsoft: Admin-Zustimmung nötig
  | 'AUTH-05' // Anmeldung nur über Microsoft (OAuth) möglich, noch nicht angebunden
  | 'CONF-01' // IMAP im Postfach ausgeschaltet
  | 'CONF-02' // Server unbekannt oder nicht erreichbar
  | 'CONF-03' // Zertifikat- oder TLS-Fehler
  | 'CAP-01' // Zielpostfach zu klein (vor dem Start)
  | 'CAP-02' // Zielpostfach während des Umzugs voll
  | 'RATE-01' // Tageslimit des Anbieters erreicht
  | 'NET-01' // Verbindungsabbruch / Zeitüberschreitung
  | 'DATA-01' // Ordner konnte nicht angelegt werden
  | 'DATA-02' // Einzelne Mail zu groß für das Ziel
  | 'DATA-03' // Duplikat, übersprungen
  | 'DATA-04' // Mail im alten Postfach inzwischen gelöscht, übersprungen
  | 'USER-02' // Passwort während des Umzugs geändert
  | 'INT-01'; // Unbekannter Fehler

export class MailovoError extends Error {
  readonly code: ErrorCode;
  /** Automatisch erneut versuchen sinnvoll? */
  readonly retryable: boolean;
  /** Frühester Zeitpunkt für einen neuen Versuch (z. B. nach Tageslimit). */
  readonly retryAt?: Date;
  /** Technische Details fürs Protokoll, nie für Nutzer. */
  readonly detail?: string;

  constructor(code: ErrorCode, opts: { retryable?: boolean; retryAt?: Date; detail?: string; cause?: unknown } = {}) {
    super(code, { cause: opts.cause });
    this.name = 'MailovoError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.retryAt = opts.retryAt;
    this.detail = opts.detail;
  }
}

type RawError = {
  message?: string;
  code?: string;
  authenticationFailed?: boolean;
  tlsFailed?: boolean;
  serverResponseCode?: string;
  responseText?: string;
  response?: unknown;
  throttleReset?: number;
};

export interface ClassifyContext {
  /** 'password' | 'app-password' | 'oauth-microsoft' aus dem Anbieterprofil */
  auth?: string;
  /** Wo der Fehler auftrat. */
  stage: 'connect' | 'list' | 'read' | 'create' | 'append';
  /** Der Job lief schon erfolgreich; ein Login-Fehler bedeutet dann meist ein geändertes Passwort. */
  hadConnected?: boolean;
}

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'EPROTO',
]);
const NOT_FOUND_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME']);
const REFUSED_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);
const NET_CODES = new Set(['ETIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'NoConnection', 'ESOCKET', 'ECONNABORTED']);

/** Ordnet einen Fehler aus imapflow/Node einem Katalog-Code zu. */
export function classify(err: unknown, ctx: ClassifyContext): MailovoError {
  if (err instanceof MailovoError) return err;
  const e = (err ?? {}) as RawError;
  const text = [e.responseText, typeof e.response === 'string' ? e.response : '', e.message].filter(Boolean).join(' ');
  const detail = [e.code, e.serverResponseCode, text].filter(Boolean).join(' | ').slice(0, 500);
  const make = (code: ErrorCode, extra: { retryable?: boolean; retryAt?: Date } = {}) =>
    new MailovoError(code, { ...extra, detail, cause: err });

  // Drosselung / Tageslimit
  if (e.code === 'ETHROTTLE' || /bandwidth|exceeded (the )?(daily|command)|too many|rate.?limit|throttl/i.test(text)) {
    const wait = e.throttleReset && e.throttleReset > 0 ? e.throttleReset : 60 * 60 * 1000;
    return make('RATE-01', { retryable: true, retryAt: new Date(Date.now() + wait) });
  }

  // Speicher voll
  if (e.serverResponseCode === 'OVERQUOTA' || /over ?quota|quota exceeded|mailbox (is )?full|not enough (disk )?space/i.test(text)) {
    return make('CAP-02');
  }

  // Anmeldung
  if (e.authenticationFailed || /AUTHENTICATIONFAILED|AUTHORIZATIONFAILED/i.test(e.serverResponseCode ?? '')) {
    if (/imap.{0,20}(disabled|not enabled|deaktiviert|nicht aktiviert)|enable imap/i.test(text)) return make('CONF-01');
    if (/need admin approval|AADSTS65001|AADSTS90094|consent/i.test(text)) return make('AUTH-04');
    if (ctx.auth === 'oauth-microsoft' && !/token/i.test(text)) return make('AUTH-05');
    if (/application.specific password|app.?password|web login required|log ?in via your web browser/i.test(text)) {
      return make('AUTH-02');
    }
    if (ctx.hadConnected) return make('USER-02');
    return make(ctx.auth === 'app-password' ? 'AUTH-02' : 'AUTH-01');
  }

  // Zertifikat / TLS
  if (e.tlsFailed || (e.code && TLS_CODES.has(e.code)) || /certificate|ssl routines|tls/i.test(e.message ?? '')) {
    return make('CONF-03');
  }

  // Server nicht gefunden / nimmt keine IMAP-Verbindung an
  if (e.code && NOT_FOUND_CODES.has(e.code)) return make('CONF-02');
  if (e.code && REFUSED_CODES.has(e.code)) return make(ctx.stage === 'connect' ? 'CONF-02' : 'NET-01', { retryable: ctx.stage !== 'connect' });

  // Einzelne Mail zu groß
  if (ctx.stage === 'append' && (/TOOBIG|LIMIT/i.test(e.serverResponseCode ?? '') || /too (big|large)|message size|exceeds.{0,20}(size|limit)|maximum.{0,20}size/i.test(text))) {
    return make('DATA-02');
  }

  // Mail wurde im alten Postfach gelöscht, während wir kopiert haben
  if (e.code === 'EMISSING') return make('DATA-04');

  // Ordner anlegen
  if (ctx.stage === 'create') return make('DATA-01');

  // Netzwerk
  if ((e.code && NET_CODES.has(e.code)) || /timed? ?out|socket|connection (closed|reset|lost)|unexpected close/i.test(text)) {
    return make('NET-01', { retryable: true });
  }

  return make('INT-01');
}
