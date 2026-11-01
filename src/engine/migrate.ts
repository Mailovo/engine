// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
// Kopier-Engine: plant die Ordner, kopiert Nachricht für Nachricht, merkt sich den Stand und
// kann jederzeit fortgesetzt werden. Derselbe Lauf dient auch der Nachsendung (Dauer-Sync):
// dann werden nur Mails kopiert, die seit dem letzten Lauf neu sind.
// Im alten Postfach wird nie etwas verändert (nur lesend).
import { MailovoError, type ErrorCode } from '../errors.ts';
import { dedupeKey, type MailStore, type MessageMeta, type ReadableMailStore } from '../mail/store.ts';
import { planFolders, type FolderPlan, type PlanOptions } from './plan.ts';

export interface FolderState {
  target: string;
  total: number;
  totalBytes: number;
  /** Höchste bereits erledigte UID; Fortsetzung beginnt danach */
  lastUid: number;
  /** Höchste UID, die schon in total gezählt ist (erkennt neu eingetroffene Mails) */
  maxUid?: number;
  /** UIDVALIDITY des Quellordners; ändert sie sich, wird der Ordner neu abgeglichen */
  uidValidity?: string;
  copied: number;
  duplicates: number;
  tooBig: number;
  /** Mails, die im alten Postfach gelöscht wurden, während wir kopiert haben */
  vanished?: number;
  /** Mails, die sich nicht lesen oder ablegen ließen; sie bleiben im alten Postfach (unreadable im Bericht) */
  failed?: number;
  bytes: number;
  done: boolean;
  /** Zielordner ist angelegt (nicht erneut anlegen) */
  created?: boolean;
  /** UIDs, die schon im Durchgang "Aktuelles zuerst" kopiert wurden */
  early?: number[];
}

export interface MigrationState {
  folders: Record<string, FolderState>;
  /** Übertragene Bytes im laufenden 24-Stunden-Fenster (Anbieterlimits) */
  window?: { startedAt: string; downloaded: number; uploaded: number };
  /** Zu große Mails für den Bericht */
  skipped: { folder: string; subject?: string; size: number; date?: string }[];
  /** Einzelne Mails, die der alte Anbieter nicht herausgab oder der neue ablehnte (Bericht, Fertig-Mail) */
  unreadable?: { folder: string; subject?: string; size: number; date?: string; code: string }[];
  /** Ordner, die nicht gelesen oder angelegt werden konnten (Rest läuft weiter) */
  failedFolders?: { folder: string; code: string }[];
  /** Anzahl abgeschlossener Läufe; ab dem zweiten ist es Nachsendung */
  runs?: number;
  /** Mails, die durch Nachsendung dazukamen */
  synced?: number;
  /** Durchgang "Aktuelles zuerst" ist erledigt */
  recentDone?: boolean;
  /**
   * Obergrenze des Gratis-Tests: beim ersten Lauf einmal festgelegt, damit ein fortgesetzter Test dieselben Mails nimmt.
   * last = letzte noch enthaltene Mail in der Reihenfolge "neueste zuerst" (null: alles passt),
   * messages/bytes = was wegen der Grenze fehlt.
   */
  cap?: { last: CapKey | null; messages: number; bytes: number };
  /**
   * Erste Mail einer Serie von Fehlschlägen, wegen der der Auftrag abgebrochen wurde, und wie oft schon. Scheitert
   * dieselbe Serie in mehreren Läufen (frische Verbindungen, Stunden auseinander), liegt es an den Mails, nicht am
   * Server: dann werden sie als nicht übertragbar verbucht und der Rest läuft weiter, statt dass alles scheitert.
   */
  suspect?: { folder: string; uid: number; seen: number };
}

/** Eine bearbeitete Mail auf dem Weg zum Verbuchen (siehe copyList) */
type AppendStep = { meta: MessageMeta; kind: 'append'; key?: string; content: Buffer; result?: { ok: true } | { ok: false; error: unknown } };
type Step =
  | { meta: MessageMeta; kind: 'skip' | 'duplicate' | 'vanished' }
  | { meta: MessageMeta; kind: 'unreadable'; err: MailovoError }
  | AppendStep;

/** "Aktuelles zuerst": Mails dieser letzten Tage kommen vor allen älteren an, damit das neue Postfach sofort nutzbar ist */
export const RECENT_DAYS = 30;

export interface MigrationOptions extends PlanOptions {
  /** Aktuelles zuerst (Standard an) */
  recentFirst?: boolean;
  /** Nur Mails ab diesem Datum (Gratis-Test, Zeitraum-Filter) */
  since?: Date;
  /** Höchstens so viele Bytes, die neuesten zuerst (Gratis-Test) */
  maxBytes?: number;
  sourceLimits?: { dailyDownloadBytes?: number };
  targetLimits?: { dailyUploadBytes?: number };
  /** Neu gezählte Mails je Ordner melden, z. B. für Auswertungen außerhalb der Engine */
  observe?: Observer;
  /** Pause vor dem zweiten Leseversuch einer Mail (Tests: 0) */
  retryDelayMs?: number;
  /**
   * Die nächste Mail schon aus dem alten Postfach laden, während die aktuelle im neuen abgelegt wird (beide Verbindungen
   * arbeiten gleichzeitig). Verbucht wird weiter streng der Reihe nach. Standard aus.
   */
  prefetch?: boolean;
  /**
   * Verbindungen zum neuen Postfach nur zum Ablegen: Über alle zusammen werden so viele Mails gleichzeitig abgelegt
   * (manche Anbieter, z. B. iCloud, brauchen pro Mail über eine Sekunde). Ohne: über target, eine nach der anderen.
   * Verbucht wird immer streng der Reihe nach.
   */
  appendPool?: Pick<MailStore, 'append'>[];
  /** Pausen, wenn das neue Postfach "ausgelastet" meldet, bevor dieselbe Mail noch einmal abgelegt wird (Tests: [0]) */
  busyDelaysMs?: number[];
}

/** Standard: dreimal warten (15 s, 45 s, 2 Min.), erst dann gilt es als Störung des ganzen Auftrags */
const BUSY_DELAYS_MS = [15_000, 45_000, 120_000];

/**
 * Das neue Postfach lehnt eine Mail ab, weil es gerade ausgelastet ist (iCloud: "NO [UNAVAILABLE] Server Busy. Please
 * try again later"). Die Mail wurde dann sicher nicht abgelegt und darf ohne Dublette noch einmal geschickt werden.
 */
function isBusy(err: unknown): boolean {
  return err instanceof MailovoError && err.code === 'NET-01' && /UNAVAILABLE|server busy|try again later/i.test(err.detail ?? '');
}

/**
 * Wird je Ordner mit den Mails aufgerufen, die in diesem Lauf neu gezählt wurden (erster Lauf: alle, Nachsendung:
 * nur neue; nach Fortsetzen nichts doppelt). inbound = kein Gesendet/Entwürfe/Papierkorb/Spam.
 */
export type Observer = (folder: { role: string | null; inbound: boolean }, messages: MessageMeta[], isSync: boolean) => void;

export interface Totals {
  messages: number;
  bytes: number;
}

export interface MigrationHooks {
  onPlan?(plan: FolderPlan[], totals: Totals): void | Promise<void>;
  onProgress?(state: MigrationState): void | Promise<void>;
  /** Wird regelmäßig aufgerufen, um den Stand dauerhaft zu speichern. */
  checkpoint?(state: MigrationState): void | Promise<void>;
  /** true = anhalten (Pause/Abbruch durch Nutzer) */
  shouldStop?(): boolean;
  now?(): Date;
  /** Dauer einer Netzwerkaktion in ms (Auswertung des Tempos); writer = Nummer der Verbindung beim Ablegen */
  timing?(kind: 'download' | 'append', ms: number, writer?: number): void;
}

export function emptyState(): MigrationState {
  return { folders: {}, skipped: [] };
}

export function totalsOf(state: MigrationState) {
  const f = Object.values(state.folders);
  const sum = (k: keyof FolderState) => f.reduce((n, x) => n + ((x[k] as number) ?? 0), 0);
  return {
    messages: sum('total'),
    bytes: sum('totalBytes'),
    copied: sum('copied'),
    duplicates: sum('duplicates'),
    tooBig: sum('tooBig'),
    vanished: sum('vanished'),
    failed: sum('failed'),
    bytesDone: sum('bytes'),
    processed: sum('copied') + sum('duplicates') + sum('tooBig') + sum('vanished') + sum('failed'),
    synced: state.synced ?? 0,
  };
}

/**
 * Was nach dem Umzug nur im alten Postfach liegt: Ordner, die sich nicht lesen oder anlegen ließen, zu große Mails
 * und Mails, die sich nicht übertragen ließen. Bei Lücken sagt die Fertig-Mail das deutlich, bevor jemand das alte
 * Postfach kündigt. (Im alten Postfach gelöschte Mails sind keine Lücke.)
 */
export function gapsOf(state: MigrationState | null | undefined) {
  const t = state ? totalsOf(state) : null;
  const gaps = { folders: (state?.failedFolders ?? []).map((f) => f.folder), tooBig: t?.tooBig ?? 0, failed: t?.failed ?? 0 };
  return { ...gaps, any: gaps.folders.length > 0 || gaps.tooBig > 0 || gaps.failed > 0 };
}

const DAY = 24 * 60 * 60 * 1000;
const CHECKPOINT_EVERY = 20;
/**
 * So viele Mails nacheinander, die sich nicht übertragen lassen, deuten auf ein grundsätzliches Problem (Server
 * gestört, Verbindung kaputt). Dann wird nichts übersprungen, sondern der ganze Auftrag später wiederholt.
 */
export const MAX_FAILED_STREAK = 5;
/** So viele Läufe muss dieselbe Serie gescheitert sein, bevor sie als Einzelfälle gilt (siehe MigrationState.suspect) */
export const SUSPECT_RUNS = 2;
/**
 * So viele Mails nacheinander, die es im alten Postfach angeblich nicht mehr gibt, sind eher eine gestörte Verbindung
 * als eine Aufräumaktion der Kundin. Dann wird nichts als gelöscht verbucht, sondern der Auftrag später wiederholt;
 * fehlen die Mails dann wirklich, stehen sie in der neuen Liste gar nicht mehr.
 */
export const MAX_VANISHED_STREAK = 50;

/** Ausgehende und aussortierte Ordner sagen nichts darüber, wo die Adresse hinterlegt ist. */
const NOT_INBOUND = new Set(['sent', 'drafts', 'trash', 'junk']);

/** Fehler, die den ganzen Auftrag betreffen. Alles andere betrifft nur den einen Ordner. */
const JOB_LEVEL: ErrorCode[] = ['NET-01', 'RATE-01', 'CAP-02', 'AUTH-01', 'AUTH-02', 'AUTH-04', 'AUTH-05', 'USER-02', 'CONF-01', 'CONF-02', 'CONF-03'];

export function isFolderLevel(err: unknown): err is MailovoError {
  return err instanceof MailovoError && !JOB_LEVEL.includes(err.code);
}

function markFailed(state: MigrationState, folder: string, err: MailovoError) {
  state.failedFolders ??= [];
  if (!state.failedFolders.some((f) => f.folder === folder)) state.failedFolders.push({ folder, code: err.code });
}

/**
 * Führt den Umzug aus, setzt ihn fort oder holt neue Mails nach. Wirft MailovoError bei Problemen,
 * die der Auftrag behandeln muss (Netz, Limit, Speicher voll, Passwort geändert).
 */
export async function migrate(
  source: ReadableMailStore,
  target: MailStore,
  state: MigrationState,
  opts: MigrationOptions,
  hooks: MigrationHooks = {},
): Promise<'done' | 'stopped'> {
  const now = hooks.now ?? (() => new Date());
  const isSync = (state.runs ?? 0) > 0;

  // 1. Planen und zählen. Bereits gezählte Mails zählen beim Fortsetzen nicht erneut.
  const plan = planFolders(await source.listFolders(), await target.listFolders(), opts);
  const metas = new Map<string, MessageMeta[]>();
  const readable: typeof plan = [];
  const uvs = new Map<string, string | undefined>();
  for (const p of plan) {
    const known = state.folders[p.source];
    let listed: { uv?: string; items: MessageMeta[] };
    try {
      listed = await source.withFolder(p.source, async (f) => {
        const uv = f.uidValidity();
        if (known?.uidValidity && uv && known.uidValidity !== uv) {
          // Ordner wurde auf dem Server neu angelegt: alles neu abgleichen, Duplikate fängt der Abgleich ab.
          // Gemerkte UIDs aus "Aktuelles zuerst" gelten nicht mehr, sonst würden neu vergebene UIDs übersprungen.
          known.lastUid = 0;
          known.maxUid = 0;
          known.early = undefined;
          known.done = false;
        }
        return { uv, items: await f.messages({ since: opts.since, minUid: known ? known.lastUid + 1 : 1 }) };
      });
    } catch (err) {
      if (!isFolderLevel(err)) throw err;
      markFailed(state, p.source, err);
      continue;
    }
    readable.push(p);
    metas.set(p.source, listed.items);
    uvs.set(p.source, listed.uv);
  }

  // Gratis-Test: die neuesten Mails bis zur Obergrenze, einmal festgelegt und beim Fortsetzen wiederverwendet
  if (opts.maxBytes && !isSync) {
    if (!state.cap) state.cap = capFor([...metas].flatMap(([folder, list]) => list.map((meta) => ({ folder, meta }))), opts.maxBytes);
    const last = state.cap.last;
    if (last) for (const [folder, list] of metas) metas.set(folder, list.filter((m) => compareNewest(keyOf(folder, m), last) <= 0));
  }

  for (const p of readable) {
    const list = metas.get(p.source)!;
    const fs = (state.folders[p.source] ??= {
      target: p.target,
      total: 0,
      totalBytes: 0,
      lastUid: 0,
      maxUid: 0,
      copied: 0,
      duplicates: 0,
      tooBig: 0,
      bytes: 0,
      done: false,
    });
    const uv = uvs.get(p.source);
    if (uv) fs.uidValidity = uv;
    // Nur Mails zählen, die noch nicht in total stecken (neu eingetroffen oder erster Lauf)
    const fresh = list.filter((m) => m.uid > (fs.maxUid ?? fs.lastUid));
    // Noch keine UID gezählt und nichts erledigt: neu zählen statt addieren. Heilt Stände, in denen ein abgebrochener
    // Lauf total schon erhöht hatte, maxUid aber nicht mehr (so geschehen beim Absturz mit sehr großen Ordnern)
    if (!fs.maxUid && fs.copied + fs.duplicates + fs.tooBig + (fs.vanished ?? 0) + (fs.failed ?? 0) === 0) {
      fs.total = 0;
      fs.totalBytes = 0;
    }
    fs.total += fresh.length;
    fs.totalBytes += fresh.reduce((n, m) => n + m.size, 0);
    // Nicht Math.max(...uids): ab etwa 120 000 Mails in einem Ordner sprengt das den Aufrufstapel ("Maximum call stack size exceeded")
    if (fresh.length) fs.maxUid = fresh.reduce((max, m) => (m.uid > max ? m.uid : max), fs.maxUid ?? 0);
    fs.done = list.length === 0;
    if (isSync) state.synced = (state.synced ?? 0) + fresh.length;

    if (fresh.length) opts.observe?.({ role: p.role ?? null, inbound: !p.role || !NOT_INBOUND.has(p.role) }, fresh, isSync);
  }
  const t = totalsOf(state);
  await hooks.onPlan?.(plan, { messages: t.messages, bytes: t.bytes });
  await hooks.checkpoint?.(state);

  /**
   * Nachsendung: im neuen Postfach nur Mails abgleichen, die so alt sein können wie die neuen (2 Tage Puffer für Zeitzonen).
   * Kopien tragen das Eingangsdatum des Originals; sonst läse jeder Lauf alle 30 Minuten den ganzen Posteingang.
   */
  function dedupeSince(list: MessageMeta[]): Date | undefined {
    if (!isSync || !list.length) return undefined;
    let oldest = Infinity;
    for (const m of list) {
      const t = m.internalDate?.getTime();
      if (t === undefined || Number.isNaN(t)) return undefined;
      if (t < oldest) oldest = t;
    }
    return new Date(oldest - 2 * DAY);
  }

  // Zielordner vorbereiten und vorhandene Mails für den Duplikat-Abgleich lesen; null = Ordner nicht nutzbar
  async function prepare(p: FolderPlan, fs: FolderState, list: MessageMeta[] = []): Promise<Set<string> | null> {
    try {
      if (p.create && !fs.created) {
        await target.createFolder(fs.target);
        fs.created = true;
      }
      const since = dedupeSince(list);
      return await target.withFolder(fs.target, (f) => f.dedupeKeys(since ? { since } : undefined));
    } catch (err) {
      if (!isFolderLevel(err)) throw err;
      markFailed(state, p.source, err);
      fs.done = true;
      return null;
    }
  }

  /** Fehlschläge nacheinander, über Ordner hinweg (siehe MAX_FAILED_STREAK) */
  let streak = 0;
  /** In diesem Lauf kopierte Mails je Zielordner und Schlüssel mit Größe: verschiedene Mails mit derselben Message-ID kommen beide an */
  const copiedNow = new Map<string, Map<string, Set<number>>>();
  const pause = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  /**
   * Nachrichten eines Ordners kopieren; early: Durchgang "Aktuelles zuerst" (UIDs merken, lastUid nicht verändern).
   * Lässt sich eine einzelne Mail nicht lesen oder ablegen, bleibt sie im alten Postfach und steht im Bericht; der Rest
   * läuft weiter. Im Durchgang "Aktuelles zuerst" wird sie nur übergangen und im zweiten Durchgang noch einmal versucht.
   */
  async function copyList(p: FolderPlan, fs: FolderState, existing: Set<string>, list: MessageMeta[], early: boolean) {
    let sinceCheckpoint = 0;
    const skip = new Set(fs.early ?? []);
    if (!copiedNow.has(fs.target)) copiedNow.set(fs.target, new Map());
    const copied = copiedNow.get(fs.target)!;
    /** Fehlschläge seit dem letzten Erfolg; festgehalten erst, wenn danach wieder etwas klappt oder der Ordner endet */
    let pending: { meta: MessageMeta; code: string }[] = [];
    /** Im alten Postfach nicht mehr gefundene Mails seit dem letzten Erfolg; verbucht wie pending */
    let vanishing: MessageMeta[] = [];
    const commit = () => {
      if (!early) {
        for (const { meta, code } of pending) {
          fs.failed = (fs.failed ?? 0) + 1;
          (state.unreadable ??= []).push({ folder: p.source, subject: meta.subject, size: meta.size, date: meta.internalDate?.toISOString(), code });
          fs.lastUid = Math.max(fs.lastUid, meta.uid);
        }
      }
      for (const meta of vanishing) {
        fs.vanished = (fs.vanished ?? 0) + 1;
        if (early) (fs.early ??= []).push(meta.uid);
        else fs.lastUid = Math.max(fs.lastUid, meta.uid);
      }
      pending = [];
      vanishing = [];
    };
    /** Etwas hat geklappt: vorherige Fehlschläge waren Einzelfälle */
    const ok = () => {
      commit();
      streak = 0;
    };
    const fail = (meta: MessageMeta, err: MailovoError) => {
      pending.push({ meta, code: err.code });
      if (++streak < MAX_FAILED_STREAK) return;
      // Kennzeichen der Serie: kleinste UID (gleich, ob "Aktuelles zuerst" sie rückwärts oder später vorwärts trifft)
      const first = pending.reduce((min, f) => Math.min(min, f.meta.uid), Infinity);
      const same = state.suspect?.folder === p.source && state.suspect.uid === first;
      if (same && state.suspect!.seen >= SUSPECT_RUNS) {
        // Dieselbe Serie schon in mehreren Läufen: es liegt an diesen Mails. Verbuchen (bei "Aktuelles zuerst" erst im
        // zweiten Durchgang, dann stehen sie im Bericht) und weitermachen
        commit();
        streak = 0;
        if (!early) state.suspect = undefined;
        return;
      }
      // Grundsätzliches Problem: nichts festhalten, der Auftrag beginnt später wieder vor diesen Mails
      state.suspect = { folder: p.source, uid: first, seen: same ? state.suspect!.seen + 1 : 1 };
      throw err;
    };
    /**
     * Verbindungen zum Ablegen. Die eigenen haben keinen Ordner geöffnet: Auf target ist der Zielordner (für den Abgleich)
     * geöffnet, dann hängt imapflow an jedes APPEND noch NOOP und SEARCH an (z. B. bei iCloud ohne UIDPLUS).
     */
    const writers: Pick<MailStore, 'append'>[] = opts.appendPool?.length ? opts.appendPool : [target];
    await source.withFolder(p.source, async (folder) => {
      /** Schon angestoßener Download der nächsten Mail (opts.prefetch); Fehler zeigen sich erst, wenn sie an der Reihe ist */
      let ahead: { uid: number; content: Promise<Buffer> } | undefined;
      const isDuplicate = (m: MessageMeta, key = dedupeKey(m)) => {
        const seen = key ? copied.get(key) : undefined;
        return !!key && (seen ? seen.has(m.size) : existing.has(key));
      };
      const download = (uid: number, attempt: number) => {
        const loaded = attempt === 1 && ahead?.uid === uid ? ahead.content : undefined;
        if (loaded) ahead = undefined;
        return loaded ?? folder.download(uid);
      };
      const loadAhead = (next: MessageMeta | undefined) => {
        if (!opts.prefetch || !next || skip.has(next.uid) || isDuplicate(next)) return;
        const content = folder.download(next.uid);
        content.catch(() => {});
        ahead = { uid: next.uid, content };
      };

      /**
       * Bearbeitete, noch nicht verbuchte Mails in Listenreihenfolge. Jede freie Verbindung legt sofort die nächste Mail
       * ab; verbucht wird immer vom Anfang her, sobald dort ein Ergebnis vorliegt (streng der Reihe nach, genau wie beim
       * Kopieren einer Mail nach der anderen). So bremst eine langsame Ablage nicht alle anderen Verbindungen.
       */
      const queue: Step[] = [];
      /** Freie Verbindungen (Index in writers) und laufende Ablagen */
      const free = writers.map((_, n) => n).reverse();
      const running = new Set<Promise<void>>();
      /** Höchstens so viel Abgelegtes wartet aufs Verbuchen (eine hängende Ablage soll nicht den Speicher füllen) */
      const MAX_AHEAD = writers.length * 4;
      const MAX_AHEAD_BYTES = 64 * 1024 * 1024;
      const waiting = () => queue.filter((s): s is AppendStep => s.kind === 'append');

      const apply = async (s: Step) => {
        const { meta } = s;
        if (s.kind === 'unreadable') return fail(meta, s.err);
        if (s.kind === 'vanished') {
          vanishing.push(meta);
          if (vanishing.length >= MAX_VANISHED_STREAK) {
            throw new MailovoError('NET-01', { retryable: true, detail: `${vanishing.length} Mails nacheinander nicht im alten Postfach gefunden (${p.source})` });
          }
          await hooks.onProgress?.(state);
          return;
        }
        if (s.kind === 'duplicate') fs.duplicates++;
        if (s.kind === 'append') {
          const r = s.result!;
          if (r.ok) {
            countWindow(state, 'uploaded', s.content.length, now());
            fs.copied++;
            fs.bytes += s.content.length;
            if (s.key) {
              existing.add(s.key);
              if (!copied.has(s.key)) copied.set(s.key, new Set());
              copied.get(s.key)!.add(meta.size);
            }
          } else if (r.error instanceof MailovoError && r.error.code === 'DATA-02') {
            fs.tooBig++;
            state.skipped.push({ folder: p.source, subject: meta.subject, size: meta.size, date: meta.internalDate?.toISOString() });
          } else {
            // Vom neuen Postfach abgelehnt (z. B. beschädigte Kopfzeilen); nicht sofort wiederholen, sonst droht eine Dublette
            if (!isFolderLevel(r.error)) throw r.error;
            return fail(meta, r.error);
          }
        }
        if (s.kind !== 'skip') {
          ok();
          if (early) (fs.early ??= []).push(meta.uid);
        }
        if (!early && !pending.length && !vanishing.length) fs.lastUid = meta.uid;
        await hooks.onProgress?.(state);
        if (++sinceCheckpoint >= CHECKPOINT_EVERY) {
          sinceCheckpoint = 0;
          await hooks.checkpoint?.(state);
        }
      };

      /** Vom Anfang her verbuchen, was fertig ist */
      const settle = async () => {
        while (queue.length && (queue[0]!.kind !== 'append' || queue[0]!.result)) await apply(queue.shift()!);
      };
      /** Auf die nächste fertige Ablage warten, dann verbuchen */
      const waitOne = async () => {
        if (running.size) await Promise.race(running);
        await settle();
      };
      /** Alles Begonnene ablegen und verbuchen */
      const drain = async () => {
        while (queue.length) {
          if (!running.size && queue[0]!.kind === 'append' && !queue[0]!.result) throw new Error('Ablage ohne Verbindung');
          await waitOne();
        }
      };
      const dispatch = (s: AppendStep) => {
        const n = free.pop()!;
        const started = Date.now();
        const delays = opts.busyDelaysMs ?? BUSY_DELAYS_MS;
        // Ausgelastet: nur diese Verbindung wartet und schickt dieselbe Mail noch einmal, die anderen arbeiten weiter
        const send = async (): Promise<void> => {
          for (let tries = 0; ; tries++) {
            try {
              return await writers[n]!.append(fs.target, s.content, s.meta.flags, s.meta.internalDate);
            } catch (err) {
              if (tries >= delays.length || !isBusy(err)) throw err;
              await pause(delays[tries]!);
            }
          }
        };
        const task: Promise<void> = send()
          .then(
            () => void (s.result = { ok: true }),
            (error: unknown) => void (s.result = { ok: false, error }),
          )
          .finally(() => {
            hooks.timing?.('append', Date.now() - started, n);
            free.push(n);
            running.delete(task);
          });
        running.add(task);
      };

      try {
        for (let i = 0; i < list.length; i++) {
          const meta = list[i]!;
          if (hooks.shouldStop?.()) {
            // Schon Geladenes noch ablegen und verbuchen, dann anhalten
            await drain();
            return;
          }
          let step: Step;
          if (skip.has(meta.uid)) step = { meta, kind: 'skip' };
          else {
            enforceLimits(state, meta.size, opts, now());
            const key = dedupeKey(meta);
            // Dieselbe Message-ID wird gerade abgelegt: erst deren Ergebnis verbuchen, dann entscheiden
            while (key && waiting().some((s) => s.key === key)) await waitOne();
            if (isDuplicate(meta, key)) step = { meta, kind: 'duplicate' };
            else {
              let content: Buffer | undefined;
              let error: MailovoError | undefined;
              for (let attempt = 1; !content && !error; attempt++) {
                try {
                  const started = Date.now();
                  content = await download(meta.uid, attempt);
                  hooks.timing?.('download', Date.now() - started);
                } catch (err) {
                  // Inzwischen im alten Postfach gelöscht: überspringen statt den ganzen Umzug abzubrechen
                  if (err instanceof MailovoError && err.code === 'DATA-04') break;
                  if (!isFolderLevel(err)) throw err;
                  // Lesen ändert nichts: einmal kurz warten und noch einmal versuchen
                  if (attempt < 2) await pause(opts.retryDelayMs ?? 1500);
                  else error = err;
                }
              }
              if (error) step = { meta, kind: 'unreadable', err: error };
              else if (!content) step = { meta, kind: 'vanished' };
              else {
                countWindow(state, 'downloaded', content.length, now());
                step = { meta, kind: 'append', key, content };
              }
            }
          }
          if (step.kind === 'append') {
            // Eine Verbindung muss frei sein, und es darf nicht zu viel Abgelegtes aufs Verbuchen warten
            while (!free.length || waiting().length >= MAX_AHEAD || waiting().reduce((n, s) => n + s.content.length, 0) >= MAX_AHEAD_BYTES) await waitOne();
            // Eine Verbindung: eine Mail nach der anderen wie bisher, die nächste höchstens schon laden, während diese abgelegt wird
            if (writers.length === 1) loadAhead(list[i + 1]);
            dispatch(step);
            queue.push(step);
            if (writers.length === 1) await drain();
          } else queue.push(step);
          await settle();
        }
        await drain();
        // Ordnerende: Fehlschläge und gelöschte Mails festhalten (der Zähler läuft weiter, ein grundsätzliches Problem zeigt sich auch über Ordner hinweg)
        commit();
      } finally {
        // Laufende Ablagen und den Vorab-Download abwarten, bevor der Ordner freigegeben wird (sonst liefe er im nächsten Ordner)
        await Promise.allSettled([...running]);
        if (ahead) await ahead.content.catch(() => {});
      }
    });
  }

  // 2a. Aktuelles zuerst: beim ersten Lauf die Mails der letzten 30 Tage aus allen Ordnern vorziehen, neueste zuerst
  if (!isSync && opts.recentFirst !== false && !state.recentDone) {
    const cutoff = now().getTime() - RECENT_DAYS * DAY;
    for (const p of readable) {
      const fs = state.folders[p.source]!;
      if (fs.done) continue;
      const early = new Set(fs.early ?? []);
      const recent = (metas.get(p.source) ?? [])
        .filter((m) => m.internalDate && m.internalDate.getTime() >= cutoff && !early.has(m.uid))
        .sort((a, b) => b.internalDate!.getTime() - a.internalDate!.getTime() || b.uid - a.uid);
      if (!recent.length) continue;
      const existing = await prepare(p, fs);
      if (!existing) continue;
      await copyList(p, fs, existing, recent, true);
      if (hooks.shouldStop?.()) {
        await hooks.checkpoint?.(state);
        return 'stopped';
      }
    }
    state.recentDone = true;
    await hooks.checkpoint?.(state);
  }

  // 2b. Kopieren, Ordner für Ordner in UID-Reihenfolge (schon vorgezogene werden übersprungen)
  for (const p of readable) {
    const fs = state.folders[p.source]!;
    if (fs.done) continue;
    const list = metas.get(p.source) ?? [];
    const existing = await prepare(p, fs, list);
    if (!existing) continue;
    await copyList(p, fs, existing, list, false);
    if (hooks.shouldStop?.()) {
      await hooks.checkpoint?.(state);
      return 'stopped';
    }
    fs.done = true;
    fs.early = undefined;
    // Früher nicht lesbarer Ordner ist jetzt vollständig: nicht mehr als Lücke melden
    if (state.failedFolders?.some((f) => f.folder === p.source)) state.failedFolders = state.failedFolders.filter((f) => f.folder !== p.source);
    await hooks.checkpoint?.(state);
  }
  state.runs = (state.runs ?? 0) + 1;
  await hooks.checkpoint?.(state);
  return 'done';
}

/** Eindeutige Stelle einer Mail in der Reihenfolge "neueste zuerst" (gleich alte nach Ordner und UID) */
export interface CapKey {
  date: number;
  folder: string;
  uid: number;
}
const keyOf = (folder: string, m: MessageMeta): CapKey => ({ date: m.internalDate?.getTime() ?? 0, folder, uid: m.uid });
/** < 0: a kommt vor b (neuer), > 0: danach */
function compareNewest(a: CapKey, b: CapKey): number {
  return b.date - a.date || (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0) || b.uid - a.uid;
}

/** Neueste Mails zuerst, bis die Obergrenze erreicht ist. Mindestens eine Mail, damit der Test nie leer bleibt. */
export function capFor(entries: { folder: string; meta: MessageMeta }[], maxBytes: number): NonNullable<MigrationState['cap']> {
  const sorted = entries.map((e) => ({ key: keyOf(e.folder, e.meta), size: e.meta.size })).sort((a, b) => compareNewest(a.key, b.key));
  let bytes = 0;
  let i = 0;
  for (; i < sorted.length; i++) {
    if (i > 0 && bytes + sorted[i]!.size > maxBytes) break;
    bytes += sorted[i]!.size;
  }
  const left = sorted.slice(i);
  if (!left.length) return { last: null, messages: 0, bytes: 0 };
  return { last: sorted[i - 1]!.key, messages: left.length, bytes: left.reduce((n, m) => n + m.size, 0) };
}

function countWindow(state: MigrationState, key: 'downloaded' | 'uploaded', bytes: number, now: Date) {
  if (!state.window || now.getTime() - Date.parse(state.window.startedAt) >= DAY) {
    state.window = { startedAt: now.toISOString(), downloaded: 0, uploaded: 0 };
  }
  state.window[key] += bytes;
}

/** Tageslimits der Anbieter (z. B. Gmail) einhalten: rechtzeitig pausieren statt gesperrt werden. */
function enforceLimits(state: MigrationState, nextBytes: number, opts: MigrationOptions, now: Date) {
  const w = state.window;
  if (!w || now.getTime() - Date.parse(w.startedAt) >= DAY) return;
  const down = opts.sourceLimits?.dailyDownloadBytes;
  const up = opts.targetLimits?.dailyUploadBytes;
  if ((down && w.downloaded + nextBytes > down) || (up && w.uploaded + nextBytes > up)) {
    const retryAt = new Date(Date.parse(w.startedAt) + DAY + 5 * 60 * 1000);
    throw new MailovoError('RATE-01', { retryable: true, retryAt, detail: `daily window reached ${JSON.stringify(w)}` });
  }
}
