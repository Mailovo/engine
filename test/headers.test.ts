// Aus dem Mailovo-Hauptcode übernommen (oss/sync-engine.mjs). Änderungen bitte dort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBytes, decodeWords, rawHeader, repairHeader } from '../src/mail/headers.ts';

test('Rohe 8-Bit-Kopfzeilen: UTF-8 bleibt, Latin-1 und Windows-1252 werden erkannt', () => {
  assert.equal(decodeBytes(Buffer.from('Ihre Rechnung für September', 'utf8')), 'Ihre Rechnung für September');
  assert.equal(decodeBytes(Buffer.from('Ihre Rechnung für September', 'latin1')), 'Ihre Rechnung für September');
  // 0x80 ist in Windows-1252 das Euro-Zeichen
  assert.equal(decodeBytes(Buffer.from([0x39, 0x2c, 0x39, 0x30, 0x20, 0x80])), '9,90 €');
});

test('MIME-Wörter: Q und B, verschiedene Zeichensätze, benachbarte Wörter ohne Lücke', () => {
  assert.equal(decodeWords('=?utf-8?Q?Ihre_Rechnung_f=C3=BCr_September?='), 'Ihre Rechnung für September');
  assert.equal(decodeWords('=?ISO-8859-1?Q?Gr=FC=DFe?= aus Berlin'), 'Grüße aus Berlin');
  assert.equal(decodeWords('=?UTF-8?B?QmVzdMOkdGlndW5n?='), 'Bestätigung');
  assert.equal(decodeWords('=?utf-8?Q?Bestell?= =?utf-8?Q?best=C3=A4tigung?='), 'Bestellbestätigung');
  assert.equal(decodeWords('Kein MIME-Wort'), 'Kein MIME-Wort');
});

test('Kopfzeile aus dem Rohkopf, gefaltet, und Reparatur nur bei Ersatzzeichen', () => {
  const block = Buffer.concat([
    Buffer.from('From: Netflix <info@account.netflix.com>\r\nSubject: Ihre Rechnung f', 'latin1'),
    Buffer.from([0xfc]),
    Buffer.from('r\r\n September\r\nDate: Thu, 24 Sep 2026 10:00:00 +0000\r\n\r\n', 'latin1'),
  ]);
  const raw = rawHeader(block, 'subject')!;
  assert.equal(repairHeader('Ihre Rechnung f�r September', raw), 'Ihre Rechnung für September');
  assert.equal(repairHeader('Alles gut', raw), 'Alles gut', 'ohne Ersatzzeichen bleibt der Text von imapflow');
  assert.equal(repairHeader(undefined, raw), undefined);
  assert.equal(rawHeader(block, 'x-missing'), undefined);
});
