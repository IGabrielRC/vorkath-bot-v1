/**
 * Batch missing-fields + multifield NL + natural payment (same card, fewer turns).
 *
 * - Batch 1–6: one batched card for independent missing fields, remainder-only
 *   follow-ups, empty → summary.
 * - Multifield 7–12: deterministic multi-answer parse in ANY order, holder-vs-name,
 *   typo tolerance (Gemini never involved — StubIntentInterpreter calls stay 0
 *   where asserted at webhook level).
 * - Fastest path 13–16: full-combo one-parse summary, new-customer-except-name.
 * - Payment 17–25: Zelle→USD, Binance→USDT, Pago Móvil→VES (no invented rate),
 *   method/amount-only, conflict clarification (never silent conversion).
 * - New-customer 26–30, one-card 31–37 (webhook lineage), inventory 38–42.
 *
 * Real fixture values throughout (Anny Tovar 4145460657, unknown 04149990001 /
 * 04149990002); synthetic rows only for the emergency-only precheck.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { StubIntentInterpreter } from '../src/ai/intentInterpreter';
import { parseAuthorizedChatIds, parseAuthorizedIds } from '../src/auth/allowlist';
import { buildApp } from '../src/app';
import type { Env } from '../src/config/env';
import { DraftEngine } from '../src/drafts/engine';
import { InteractionStore } from '../src/interactions/interactions';
import { MockStore } from '../src/mock/mockStore';
import { MockAccountRepositories } from '../src/mock/repositories';
import type { MockAccount } from '../src/mock/excelLoader';
import type { Customer } from '../src/mock/customers';
import { NewSaleDraftStore } from '../src/sale/newSaleDraft';
import { parseSaleExtraction } from '../src/sale/saleParser';
import {
  expectedSaleFields,
  isSaleReady,
  prepareNewSaleFromAction,
  prepareNewSaleFromText,
  type SaleActor,
  type SaleDeps,
} from '../src/sale/newSaleTool';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';

const GABRIEL_ACTOR: SaleActor = { chatId: -1005550001, userId: 1057242322, name: 'Gabriel' };
const GABRIEL = 1057242322;
const EDWARD = 941030473;
const GROUP_CHAT_ID = -1005550001;
const KNOWN_PHONE = '4145460657';
const UNKNOWN_PHONE = '04149990001';
const UNKNOWN_PHONE_2 = '04149990002';
const FULL_COMBO =
  'vende un perfil de netflix para 4145460657 por 2 meses, pagó 8 USD por zelle, lo recibió Edward';

const FIXTURE_PATH = resolve(process.cwd(), 'fixtures/BASE PRUEBA_v2.xlsx');

async function fixtureWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-batch-'));
  const store = await MockStore.create({ fixturePath: FIXTURE_PATH, statePath: join(dir, 'mock-state.json') });
  const repos = new MockAccountRepositories(store);
  return { store, repos, rows: store.accounts };
}

function depsFor(
  store: NewSaleDraftStore,
  rows: MockAccount[],
  lookup: (phone: string) => Customer[] | Promise<Customer[]>,
  extra: Partial<SaleDeps> = {},
): SaleDeps {
  return { store, findCustomersByPhone: lookup, inventoryRows: rows, ...extra };
}

function fixtureDeps(saleStore: NewSaleDraftStore, rows: MockAccount[], repos: MockAccountRepositories): SaleDeps {
  return depsFor(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw));
}

// ---------------------------------------------------------------------------
// Batch 1–6: missing-fields model (one card, remainder-only, empty → summary)
// ---------------------------------------------------------------------------

describe('sale batch missing-fields (1–6)', () => {
  it('(1) 4-missing cue → ONE card listing ALL with combined example', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'vende netflix para 4145460657',
      fixtureDeps(saleStore, rows, repos),
    );
    expect(result.kind).toBe('ask-missing');
    expect(result.missing).toBe('months');
    expect(result.missingFields).toEqual(['months', 'method', 'amount', 'receiver']);
    expect(expectedSaleFields(result.draft as never)).toEqual(['months', 'method', 'amount', 'receiver']);
    expect(result.text).toContain('UN mensaje');
    expect(result.text).toContain('Zelle, 4 dólares, lo recibió Edward');
    expect(result.text).not.toContain('teléfono');
    expect(result.text).toContain('meses');
    expect(result.text).toContain('Método de pago');
    expect(result.text).toContain('recibió');
  });

  it('(2) full batch answer in ONE message completes to summary (same draft)', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = fixtureDeps(saleStore, rows, repos);
    const first = await prepareNewSaleFromText(GABRIEL_ACTOR, 'vende netflix para 4145460657', deps);
    const second = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'por 2 meses, Zelle, 8 dólares, lo recibió Edward',
      deps,
    );
    expect(second.kind).toBe('summary');
    expect(second.draft?.operationId).toBe(first.draft?.operationId);
    expect(second.draft?.duration.requestedMonths).toBe(2);
    expect(second.draft?.payment.method).toBe('zelle');
    expect(second.draft?.payment.actualAmount).toBe(8);
    expect(second.draft?.payment.currency).toBe('USD');
    expect(second.draft?.payment.receivedBy).toBe('Edward');
    expect(isSaleReady(second.draft as never)).toBe(true);
  });

  it('(3) partial batch answer → card shows ONLY the remainder', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = fixtureDeps(saleStore, rows, repos);
    await prepareNewSaleFromText(GABRIEL_ACTOR, 'vende netflix para 4145460657', deps);
    const partial = await prepareNewSaleFromText(GABRIEL_ACTOR, 'por 2 meses, zelle', deps);
    expect(partial.kind).toBe('ask-missing');
    expect(partial.missing).toBe('amount');
    expect(partial.missingFields).toEqual(['amount', 'receiver']);
    expect(partial.text).toContain('Monto');
    expect(partial.text).toContain('Gabriel o Edward');
    expect(partial.text).not.toContain('meses');
    expect(partial.text).not.toContain('Duración');
    expect(partial.text).not.toContain('Método');
  });

  it('(4) 3-of-4 answered → single ask for the last one only', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = fixtureDeps(saleStore, rows, repos);
    await prepareNewSaleFromText(GABRIEL_ACTOR, 'vende netflix para 4145460657', deps);
    await prepareNewSaleFromText(GABRIEL_ACTOR, 'por 2 meses, zelle', deps);
    const last = await prepareNewSaleFromText(GABRIEL_ACTOR, 'recibí 8 usd', deps);
    expect(last.kind).toBe('ask-missing');
    expect(last.missing).toBe('receiver');
    expect(last.missingFields).toEqual(['receiver']);
    expect(last.text).toContain('Gabriel o Edward');
    expect(last.text).not.toContain('Monto');
    expect(last.text).not.toContain('Faltan:');
  });

  it('(5) resolved fields are never re-asked across the walk', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = fixtureDeps(saleStore, rows, repos);
    const first = await prepareNewSaleFromText(GABRIEL_ACTOR, 'vende netflix para 4145460657', deps);
    const second = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'por 2 meses, zelle, 8 dólares',
      deps,
    );
    expect(second.kind).toBe('ask-missing');
    expect(second.draft?.operationId).toBe(first.draft?.operationId);
    expect(second.text).not.toContain('Faltan');
    expect(second.text).not.toContain('meses');
    expect(second.text).not.toContain('Método');
    expect(second.text).toContain('recibió');
  });

  it('(6) empty missing → summary immediately, nothing asked', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      FULL_COMBO,
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    expect(result.kind).toBe('summary');
    expect(result.missing).toBeUndefined();
    expect(result.missingFields).toBeUndefined();
    expect(result.text).toContain('VENTA NUEVA');
    expect(isSaleReady(result.draft as never)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multifield 7–12: scoped deterministic parse, any order, holder-vs-name
// ---------------------------------------------------------------------------

describe('sale multifield parsing (7–12)', () => {
  it('(7) 4-field combo parses in ANY order to the same summary', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'vende netflix para 4145460657, lo recibió Edward, 8 dólares, zelle, por 2 meses',
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.duration.requestedMonths).toBe(2);
    expect(result.draft?.payment.method).toBe('zelle');
    expect(result.draft?.payment.actualAmount).toBe(8);
    expect(result.draft?.payment.currency).toBe('USD');
    expect(result.draft?.payment.receivedBy).toBe('Edward');
  });

  it('(8) order invariance: scrambled orders yield identical drafts', async () => {
    const { repos, rows } = await fixtureWorld();
    const first = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'vende perfil netflix a 4145460657 por 1 mes, zelle 4 usd, lo recibió Gabriel',
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    const second = await prepareNewSaleFromText(
      { ...GABRIEL_ACTOR, userId: 777008 },
      'lo recibió Gabriel, zelle 4 usd, por 1 mes, vende perfil netflix a 4145460657',
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    const tuple = (draft: typeof first.draft) =>
      [
        draft?.service,
        draft?.modality,
        draft?.duration.requestedMonths,
        draft?.payment.method,
        draft?.payment.actualAmount,
        draft?.payment.currency,
        draft?.payment.receivedBy,
        draft?.customer.existingCustomerId,
      ];
    expect(second.kind).toBe('summary');
    expect(tuple(second.draft)).toEqual(tuple(first.draft));
  });

  it('(9) 3-field combo leaves ONLY the fourth missing', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = fixtureDeps(saleStore, rows, repos);
    await prepareNewSaleFromText(GABRIEL_ACTOR, 'vende netflix para 4145460657', deps);
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'zelle, 4 dólares, lo recibió Gabriel',
      deps,
    );
    expect(result.kind).toBe('ask-missing');
    expect(result.missing).toBe('months');
    expect(result.missingFields).toEqual(['months']);
    expect(result.text).toContain('meses');
  });

  it('(10) multi-correction in ONE message recalculates the same draft', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = fixtureDeps(saleStore, rows, repos);
    const first = await prepareNewSaleFromText(GABRIEL_ACTOR, FULL_COMBO, deps);
    const second = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'cámbialo a 3 meses por Binance, 5 USDT, lo recibió Gabriel',
      deps,
    );
    expect(second.kind).toBe('summary');
    expect(second.draft?.operationId).toBe(first.draft?.operationId);
    expect(second.draft?.duration.requestedMonths).toBe(3);
    expect(second.draft?.payment.method).toBe('binance');
    expect(second.draft?.payment.actualAmount).toBe(5);
    expect(second.draft?.payment.currency).toBe('USDT');
    expect(second.draft?.payment.receivedBy).toBe('Gabriel');
    expect(second.draft?.price?.suggestedAmount).toBe(12);
    expect(second.draft?.cost?.recognizedCost).toBe(6);
  });

  it('(11) holder-vs-name: exact holder wins for receiver, rest stays the name', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = fixtureDeps(saleStore, rows, repos);
    const started = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `vende perfil netflix para ${UNKNOWN_PHONE} por 1 mes, zelle 4 usd`,
      deps,
    );
    expect(started.kind).toBe('new-customer');
    const named = await prepareNewSaleFromText(GABRIEL_ACTOR, 'Gabriel Juan lo recibió Edward', deps);
    expect(named.kind).toBe('summary');
    expect(named.draft?.customer.proposedCustomer?.name).toBe('Gabriel Juan');
    expect(named.draft?.payment.receivedBy).toBe('Edward');

    // Near-miss names never match holders: Eduardo ≠ Edward.
    const saleStore2 = new NewSaleDraftStore();
    const deps2 = fixtureDeps(saleStore2, rows, repos);
    await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `vende perfil netflix para ${UNKNOWN_PHONE_2} por 1 mes, zelle 4 usd`,
      deps2,
    );
    const eduardo = await prepareNewSaleFromText(GABRIEL_ACTOR, 'Eduardo Ramos', deps2);
    expect(eduardo.draft?.customer.proposedCustomer?.name).toBe('Eduardo Ramos');
    expect(eduardo.draft?.payment.receivedBy).toBeNull();
    expect(eduardo.kind).toBe('ask-missing');
    expect(eduardo.missing).toBe('receiver');
  });

  it('(12) typo tolerance: case, accents and service typos still parse', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'VENDE UN PERFIL NETFLIX PARA 4145460657 POR 2 MESES, ZELLE 8 DOLARES, LO RECIBIO EDWARD',
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.payment.receivedBy).toBe('Edward');
    expect(parseSaleExtraction('dame una cuenta nueva netflx').service).toBe('netflix');
  });
});

// ---------------------------------------------------------------------------
// Fastest path 13–16
// ---------------------------------------------------------------------------

describe('sale fastest path (13–16)', () => {
  it('(13) full-combo existing customer resolves in one parse', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      FULL_COMBO,
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.customer.existingCustomerId).toBe('anny tovar');
    expect(result.draft?.proposal).not.toBeNull();
    expect(result.draft?.price?.suggestedAmount).toBe(8);
    expect(result.draft?.cost?.recognizedCost).toBe(4);
  });

  it('(14) new-customer-except-name: combo asks ONLY the name', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `vende perfil netflix para ${UNKNOWN_PHONE} por 2 meses, zelle 8 usd, lo recibió Edward`,
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    expect(result.kind).toBe('new-customer');
    expect(result.text).toContain('nombre');
    expect(result.text).not.toContain('Método');
    expect(result.draft?.phone).toBe(UNKNOWN_PHONE);
    expect(result.draft?.customer.proposedCustomer).toBeUndefined();
    expect(result.draft?.duration.requestedMonths).toBe(2);
    expect(result.draft?.payment.method).toBe('zelle');
  });

  it('(15) name answer completes the new-customer sale (2 turns total)', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = fixtureDeps(saleStore, rows, repos);
    const started = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `vende perfil netflix para ${UNKNOWN_PHONE} por 2 meses, zelle 8 usd, lo recibió Edward`,
      deps,
    );
    expect(started.kind).toBe('new-customer');
    const done = await prepareNewSaleFromText(GABRIEL_ACTOR, 'Gabriel Juan', deps);
    expect(done.kind).toBe('summary');
    expect(done.draft?.operationId).toBe(started.draft?.operationId);
    expect(done.draft?.customer.proposedCustomer).toMatchObject({ name: 'Gabriel Juan', phone: UNKNOWN_PHONE });
  });

  it('(16) complete sentence with filler words resolves in one parse', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'sácame una netflix para 4145460657 de 1 mes por zelle de 4 usd que lo recibió Gabriel',
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.duration.requestedMonths).toBe(1);
    expect(result.draft?.payment.method).toBe('zelle');
    expect(result.draft?.payment.actualAmount).toBe(4);
    expect(result.draft?.payment.receivedBy).toBe('Gabriel');
  });
});

// ---------------------------------------------------------------------------
// Payment 17–25: natural method/currency handling, never silent conversion
// ---------------------------------------------------------------------------

describe('sale natural payment (17–25)', () => {
  it('(17) Zelle + 4 USD → USD, no currency question', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `vende netflix para ${KNOWN_PHONE} por 1 mes, zelle 4 usd, lo recibió Gabriel`,
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.payment.method).toBe('zelle');
    expect(result.draft?.payment.currency).toBe('USD');
  });

  it('(18) Binance + 4 USDT → USDT', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `vende netflix para ${KNOWN_PHONE} por 1 mes, binance 4 usdt, lo recibió Gabriel`,
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.payment.method).toBe('binance');
    expect(result.draft?.payment.currency).toBe('USDT');
    expect(result.draft?.payment.actualAmount).toBe(4);
  });

  it('(19) “4 dólares por Binance” → minimal clarification, never silent conversion', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `vende perfil netflix para ${KNOWN_PHONE} por 1 mes, 4 dólares por Binance, lo recibió Gabriel`,
      fixtureDeps(saleStore, rows, repos),
    );
    expect(result.kind).toBe('clarification');
    expect(result.draft?.payment.method).toBe('binance');
    expect(result.draft?.payment.actualAmount).toBe(4);
    expect(result.draft?.payment.currency).toBe('USD');
    expect(result.text).toContain('USDT');
    expect(result.text).toContain('Binance');
  });

  it('(20) Pago Móvil → VES real amount, no invented rate, price-vs-payment kept', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `vende netflix para ${KNOWN_PHONE} por 1 mes, pago móvil 1800 bs, lo recibió Gabriel`,
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.payment.method).toBe('pago-movil');
    expect(result.draft?.payment.currency).toBe('VES');
    expect(result.draft?.payment.actualAmount).toBe(1800);
    expect(result.draft?.price?.suggestedAmount).toBe(4);
    expect(result.draft?.price?.currency).toBe('USD');
    expect(JSON.stringify(result.draft)).not.toMatch(/equivalentUSD|exchangeRate/i);
    expect(result.text).toContain('Sugerido');
    expect(result.text).toContain('Recibido');
  });

  it('(21) method without amount → ONLY amount missing', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `vende netflix para ${KNOWN_PHONE} por 1 mes, zelle, lo recibió Gabriel`,
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    expect(result.kind).toBe('ask-missing');
    expect(result.missing).toBe('amount');
    expect(result.missingFields).toEqual(['amount']);
    expect(result.text).toContain('recibí');
  });

  it('(22) “pagó 4 dólares” without method → ONLY method missing', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `vende netflix para ${KNOWN_PHONE} por 1 mes, pagó 4 dólares, lo recibió Gabriel`,
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    expect(result.kind).toBe('ask-missing');
    expect(result.missing).toBe('method');
    expect(result.missingFields).toEqual(['method']);
    expect(result.text).toContain('Método de pago');
  });

  it('(23) actual ≠ suggested stays visible side by side', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `vende un perfil de netflix para ${KNOWN_PHONE} por 2 meses, pagó 10 USD por zelle, lo recibió Edward`,
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    expect(result.draft?.price?.suggestedAmount).toBe(8);
    expect(result.draft?.payment.actualAmount).toBe(10);
    expect(result.text).toContain('Sugerido');
    expect(result.text).toContain('Recibido');
  });

  it('(24) Pago Móvil + USD conflict → clarification, kept as stated', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `vende netflix para ${KNOWN_PHONE} por 1 mes, pago móvil 4 usd, lo recibió Gabriel`,
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    expect(result.kind).toBe('clarification');
    expect(result.draft?.payment.method).toBe('pago-movil');
    expect(result.draft?.payment.currency).toBe('USD');
    expect(result.text).toContain('VES');
  });

  it('(25) Pago Móvil bare amount → VES via the method, no currency re-ask', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `vende netflix para ${KNOWN_PHONE} por 1 mes, pago móvil 1800, lo recibió Gabriel`,
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.payment.method).toBe('pago-movil');
    expect(result.draft?.payment.currency).toBe('VES');
    expect(result.draft?.payment.actualAmount).toBe(1800);
  });
});

// ---------------------------------------------------------------------------
// New-customer 26–30
// ---------------------------------------------------------------------------

describe('sale new-customer (26–30)', () => {
  it('(26) unknown phone asks ONLY the name (never the phone again)', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `vende netflix para ${UNKNOWN_PHONE} por 1 mes`,
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    expect(result.kind).toBe('new-customer');
    // Part B: deduped batch card — the name bullet keeps the wording, capitalized.
    expect(result.text).toContain('Nombre del cliente');
    expect(result.draft?.phone).toBe(UNKNOWN_PHONE);
  });

  it('(27) NL name fills the proposed customer with the phone preserved', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = fixtureDeps(saleStore, rows, repos);
    await prepareNewSaleFromText(GABRIEL_ACTOR, `vende netflix para ${UNKNOWN_PHONE} por 1 mes`, deps);
    const named = await prepareNewSaleFromText(GABRIEL_ACTOR, 'Gabriel Juan', deps);
    expect(named.draft?.customer.proposedCustomer).toMatchObject({
      name: 'Gabriel Juan',
      phone: UNKNOWN_PHONE,
    });
  });

  it('(28) button≡NL: provide-name action reaches the same summary', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = fixtureDeps(saleStore, rows, repos);
    const started = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `vende perfil netflix para ${UNKNOWN_PHONE} por 2 meses, zelle 8 usd, lo recibió Edward`,
      deps,
    );
    expect(started.kind).toBe('new-customer');
    const done = await prepareNewSaleFromAction(
      GABRIEL_ACTOR,
      { type: 'provide-name', name: 'Gabriel Juan' },
      deps,
    );
    expect(done.kind).toBe('summary');
    expect(done.draft?.operationId).toBe(started.draft?.operationId);
    expect(done.draft?.customer.proposedCustomer?.name).toBe('Gabriel Juan');
  });

  it('(29) shared phone still disambiguates (regression intact)', async () => {
    const { repos, rows } = await fixtureWorld();
    const started = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'vende netflix para 4141294973 por 1 mes',
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    expect(started.kind).toBe('disambiguate');
    expect(started.customers?.map((customer) => customer.nombre).sort()).toEqual(
      ['Iliana Rodriguez', 'Stefania Marmai (Gian)'].sort(),
    );
  });

  it('(30) known phone resolves existing — never the new-customer prompt', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      FULL_COMBO,
      fixtureDeps(new NewSaleDraftStore(), rows, repos),
    );
    expect(result.kind).toBe('summary');
    expect(result.text).not.toContain('nombre del cliente');
    expect(result.text).not.toContain('(nuevo)');
  });
});

// ---------------------------------------------------------------------------
// One-card 31–37 (webhook lineage: 1 send, edits only, same message ids)
// ---------------------------------------------------------------------------

const SECRET = 'sale-batch-test-secret-long';

const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  TELEGRAM_BOT_TOKEN: 'tok-test-secret',
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  AUTHORIZED_TELEGRAM_USER_IDS: `${GABRIEL},${EDWARD}`,
  AUTHORIZED_TELEGRAM_CHAT_IDS: `${GROUP_CHAT_ID}`,
  TELEGRAM_OPERATOR_TOPICS: '',
  TELEGRAM_ACTIVITY_TOPIC_ID: '',
  GEMINI_API_KEY: 'key-test-secret',
  GEMINI_MODEL: 'gemini-2.0-flash',
  PUBLIC_BASE_URL: 'https://example.com',
  REGISTER_TELEGRAM_WEBHOOK: 'false',
  MOCK_STATE_PATH: '/data/mock-state.json',
  DRAFTS_STATE_PATH: '/data/drafts-state.json',
  INTERACTIONS_STATE_PATH: '/data/interactions-state.json',
};

interface CardPayload {
  chatId: number;
  text: string;
  replyMarkup?: {
    inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
  };
  messageThreadId?: number;
  messageId?: number;
}

class CardClient implements TelegramClient {
  readonly sent: Array<{ kind: 'send' | 'edit' | 'answer'; payload: unknown }> = [];
  private nextId = 700;

  async sendMessage(opts: CardPayload): Promise<unknown> {
    const messageId = this.nextId;
    this.nextId += 1;
    this.sent.push({ kind: 'send', payload: { ...opts, messageId } });
    return { ok: true, result: { message_id: messageId } };
  }

  async editMessageText(opts: CardPayload & { messageId: number }): Promise<unknown> {
    this.sent.push({ kind: 'edit', payload: opts });
    return { ok: true };
  }

  async answerCallbackQuery(callbackQueryId: string, opts?: { text?: string }): Promise<unknown> {
    this.sent.push({
      kind: 'answer',
      payload: { callbackQueryId, ...(opts?.text !== undefined ? { text: opts.text } : {}) },
    });
    return { ok: true };
  }

  sends(): CardPayload[] {
    return this.sent
      .filter((entry) => entry.kind === 'send')
      .map((entry) => entry.payload as CardPayload);
  }

  edits(): Array<CardPayload & { messageId: number }> {
    return this.sent
      .filter((entry) => entry.kind === 'edit')
      .map((entry) => entry.payload as CardPayload & { messageId: number });
  }

  texts(): string[] {
    return [...this.sends(), ...[]].map((entry) => entry.text).concat(
      this.sent
        .filter((entry) => entry.kind === 'edit')
        .map((entry) => (entry.payload as CardPayload).text),
    );
  }

  lastText(): string {
    const cards = this.sent.filter((entry) => entry.kind === 'send' || entry.kind === 'edit');
    return (cards.at(-1)?.payload as CardPayload)?.text ?? '';
  }

  findButton(label: string): string | undefined {
    for (const entry of [...this.sent].reverse()) {
      if (entry.kind !== 'send' && entry.kind !== 'edit') {
        continue;
      }
      const found = (entry.payload as CardPayload).replyMarkup?.inline_keyboard
        .flat()
        .find((button) => button.text === label);
      if (found?.callback_data !== undefined) {
        return found.callback_data;
      }
    }
    return undefined;
  }
}

interface BatchWorld {
  app: FastifyInstance;
  client: CardClient;
  saleDrafts: NewSaleDraftStore;
  mockStore: MockStore;
  nextUpdateId: () => number;
  post: (update: unknown) => Promise<void>;
}

async function createBatchWorld(): Promise<BatchWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-batch-card-'));
  const mockStore = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'mock-state.json'),
  });
  const reposStore = await MockStore.create({
    fixturePath: resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx'),
    statePath: join(dir, 'repos-state.json'),
  });
  const client = new CardClient();
  const saleDrafts = new NewSaleDraftStore();
  const app = buildApp(testEnv, {
    allowlist: parseAuthorizedIds(testEnv.AUTHORIZED_TELEGRAM_USER_IDS),
    chatAllowlist: parseAuthorizedChatIds(testEnv.AUTHORIZED_TELEGRAM_CHAT_IDS),
    sessions: new SessionStore(),
    drafts: new DraftEngine(),
    interactions: new InteractionStore(),
    interpreter: new StubIntentInterpreter(),
    repos: new MockAccountRepositories(reposStore),
    client,
    sale: { saleDrafts, mockStore },
    alertsTopicId: 25,
  });
  let counter = 9100;
  return {
    app,
    client,
    saleDrafts,
    mockStore,
    nextUpdateId: () => {
      counter += 1;
      return counter;
    },
    post: async (update: unknown) => {
      await app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': SECRET },
        payload: update,
      });
    },
  };
}

const NAMES: Record<number, string> = { [GABRIEL]: 'Gabriel', [EDWARD]: 'Edward' };

function textMessage(updateId: number, actorId: number, text: string): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Stranger' },
      chat: { id: GROUP_CHAT_ID, type: 'supergroup', is_forum: true },
      text,
    },
  };
}

function tap(updateId: number, actorId: number, data: string): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: actorId, first_name: NAMES[actorId] ?? 'Stranger' },
      message: { message_id: 7, chat: { id: GROUP_CHAT_ID, type: 'supergroup' } },
      data,
    },
  };
}

describe('sale one-card batch lineage (31–37)', () => {
  it('(31) batch cue → exactly 1 initial send', async () => {
    const world = await createBatchWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'vende netflix para 4145460657'));
    expect(world.client.sends()).toHaveLength(1);
    expect(world.client.lastText()).toContain('UN mensaje');
    await world.app.close();
  });

  it('(32) batch answer → edits only, still 1 send', async () => {
    const world = await createBatchWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'vende netflix para 4145460657'));
    await world.post(
      textMessage(world.nextUpdateId(), GABRIEL, 'por 2 meses, Zelle, 8 dólares, lo recibió Edward'),
    );
    expect(world.client.sends()).toHaveLength(1);
    expect(world.client.edits()).toHaveLength(1);
    expect(world.client.lastText()).toContain('VENTA NUEVA');
    await world.app.close();
  });

  it('(33) cue → batch → summary share ONE message id', async () => {
    const world = await createBatchWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'vende netflix para 4145460657'));
    await world.post(
      textMessage(world.nextUpdateId(), GABRIEL, 'por 2 meses, Zelle, 8 dólares, lo recibió Edward'),
    );
    const ids = new Set([
      world.client.sends()[0]?.messageId,
      ...world.client.edits().map((edit) => edit.messageId),
    ]);
    expect(world.client.sends()).toHaveLength(1);
    expect(ids.size).toBe(1);
    await world.app.close();
  });

  it('(34) confirm freezes the batch card + fresh Home below (ledger 1)', async () => {
    const world = await createBatchWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const confirmData = world.client.findButton('✅Confirmar');
    expect(confirmData).toBeDefined();
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirmData as string));
    expect(world.mockStore.saleOperations).toHaveLength(1);
    // HOTFIX 2: terminal freeze (in-place edit) + exactly one fresh
    // Home send below — the confirmed result is on the frozen card.
    expect(world.client.sends()).toHaveLength(2);
    expect(world.client.lastText()).toContain('🏠 Vokath');
    expect(world.client.texts()).toContainEqual(
      expect.stringContaining('✅ VENTA CONFIRMADA'),
    );
    await world.app.close();
  });

  it('(35) cancel freezes the batch card compact + fresh Home below (draft dropped, ledger 0)', async () => {
    const world = await createBatchWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'vende netflix para 4145460657'));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'cancelar'));
    expect(world.saleDrafts.get({ chatId: GROUP_CHAT_ID, userId: GABRIEL })).toBeUndefined();
    expect(world.client.sends()).toHaveLength(2);
    expect(world.client.edits()).toHaveLength(1);
    expect(world.client.texts()).toContainEqual(expect.stringContaining('cancelada'));
    expect(world.client.lastText()).toContain('🏠 Vokath');
    expect(world.mockStore.saleOperations).toHaveLength(0);
    await world.app.close();
  });

  it('(36) second mutation → GESTIÓN PENDIENTE on the SAME card', async () => {
    const world = await createBatchWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, 'vende otra cuenta netflix'));
    expect(world.client.sends()).toHaveLength(1);
    expect(world.client.lastText()).toContain('Tienes una gestión pendiente');
    await world.app.close();
  });

  it('(37) summary → confirm freezes the card + fresh Home below (lineage split at terminal)', async () => {
    const world = await createBatchWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    const confirmData = world.client.findButton('✅Confirmar');
    // Production tap targets the card itself: reuse the real card id so
    // the confirm edit lands on the same message.
    const cardId = world.client.sends()[0]?.messageId ?? 7;
    await world.post({
      update_id: world.nextUpdateId(),
      callback_query: {
        id: 'cb-confirm-37',
        from: { id: GABRIEL, first_name: 'Gabriel' },
        message: { message_id: cardId, chat: { id: GROUP_CHAT_ID, type: 'supergroup' } },
        data: confirmData,
      },
    });
    // HOTFIX 2: the frozen terminal edit keeps the single lineage
    // (send id + edit id are one), the fresh Home is a NEW send below.
    expect(world.client.sends()).toHaveLength(2);
    expect(world.client.edits()).toHaveLength(1);
    const ids = new Set([
      world.client.sends()[0]?.messageId,
      ...world.client.edits().map((edit) => edit.messageId),
    ]);
    expect(ids.size).toBe(1);
    expect(world.client.sends()[1]?.messageId).not.toBe(world.client.sends()[0]?.messageId);
    expect(world.client.texts()).toContainEqual(expect.stringContaining('💬 WhatsApp preparado.'));
    expect(world.client.lastText()).toContain('🏠 Vokath');
    await world.app.close();
  });
});

// ---------------------------------------------------------------------------
// Inventory 38–42: precheck intact, no reservation, revalidation, renew hold
// ---------------------------------------------------------------------------

describe('sale inventory + reservations (38–42)', () => {
  it('(38) service+modality with zero stock → SIN INVENTARIO, asks nothing else', async () => {
    const { repos } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `vende perfil netflix para ${KNOWN_PHONE} por 1 mes, zelle 4 usd, lo recibió Gabriel`,
      depsFor(new NewSaleDraftStore(), [], (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('no-inventory');
    expect(result.text).toContain('No hay inventario disponible');
    expect(result.text).not.toContain('teléfono');
    expect(result.text).not.toContain('Faltan');
  });

  it('(39) emergency-only stock decides FIRST (auth before customer/payment)', async () => {
    const occupied: MockAccount = {
      servicio: 'netflix',
      correo: 'llena@test.com',
      perfil: '1 PERFIL (1)',
      nombre: 'Ocupa',
      numero: '7000000',
      contrasena: 'x',
      fechaInicio: null,
      fechaFin: null,
      dias: null,
      estatus: 'VIGENTE',
      monto: null,
      estado: '',
      pais: 'VE',
    };
    const emergencyFree: MockAccount = { ...occupied, correo: 'emer@test.com', perfil: '1 PERFIL (5)', nombre: '', numero: '' };
    const lookup = (): Customer[] => [{ id: 'carlos', nombre: 'Carlos Prueba', phones: ['999888777'], subscriptions: [] }];
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'vende netflix para 999888777 por 1 mes, zelle 4 usd, lo recibió Gabriel',
      depsFor(new NewSaleDraftStore(), [occupied, emergencyFree], lookup),
    );
    expect(result.kind).toBe('emergency-auth');
    expect(result.text).toContain('EMERGENCIA');
    expect(result.draft?.proposal?.emergencyAuthorized).toBe(false);
  });

  it('(40) no-inventory reserves nothing: proposal null, cancel clean', async () => {
    const { store, repos, rows } = await fixtureWorld();
    const before = store.accounts.length;
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, [], (raw) => repos.searchCustomersByPhone(raw));
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      `vende perfil netflix para ${KNOWN_PHONE} por 1 mes, zelle 4 usd, lo recibió Gabriel`,
      deps,
    );
    expect(result.draft?.proposal).toBeNull();
    await prepareNewSaleFromAction(GABRIEL_ACTOR, { type: 'cancel-sale' }, deps);
    expect(saleStore.get({ chatId: GABRIEL_ACTOR.chatId, userId: GABRIEL_ACTOR.userId })).toBeUndefined();
    expect(store.accounts.length).toBe(before);
    void rows;
  });

  it('(41) confirm revalidates drained stock → no-inventory, ledger 0', async () => {
    const world = await createBatchWorld();
    await world.post(textMessage(world.nextUpdateId(), GABRIEL, FULL_COMBO));
    expect(world.client.lastText()).toContain('VENTA NUEVA');
    world.mockStore.accounts.length = 0;
    const confirmData = world.client.findButton('✅Confirmar');
    await world.post(tap(world.nextUpdateId(), GABRIEL, confirmData as string));
    expect(world.client.lastText()).toContain('No hay inventario disponible');
    expect(world.mockStore.saleOperations).toHaveLength(0);
    await world.app.close();
  });

  it('(42) renew words stay reserved: never a NEW_SALE, safe hold, no draft', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL_ACTOR,
      'renueva mi perfil de netflix por 30 dias',
      fixtureDeps(saleStore, rows, repos),
    );
    expect(result.kind).toBe('clarification');
    expect(result.draft).toBeNull();
    expect(result.text).toContain('renovaciones aún no están disponibles');
    expect(saleStore.get({ chatId: GABRIEL_ACTOR.chatId, userId: GABRIEL_ACTOR.userId })).toBeUndefined();
  });
});
