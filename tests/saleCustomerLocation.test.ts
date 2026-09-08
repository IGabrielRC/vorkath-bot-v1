/**
 * Part A — optional CUSTOMER_LOCATION (capture-if-provided, NEVER asked)
 * + Part B — sale card visual redesign (presentation; behavior intact).
 *
 * Location contract under test:
 * - Backward-compatible optional model (raw/display/city/stateRegion/
 *   country; no exact address, no geocoding); old rows/state load.
 * - Deterministic evident forms first (`Caracas`, `de Caracas`,
 *   `vive en Caracas`, `Valencia, Carabobo`, `Miami, Florida`,
 *   `Bogotá, Colombia`); scoped Gemini
 *   (NEW_SALE + OPTIONAL_CUSTOMER_LOCATION_EXTRACTION + currentTurnOnly
 *   + unconsumedFragments) ONLY when genuinely needed, never mutating,
 *   never touching PAIS_CUENTA.
 * - New customer: draft-only until confirm; cancel/no-inventory persist
 *   nothing. Existing customer: explicit in-sale location proposes an
 *   update (`📍 Ubicación: Caracas → Valencia`), applied on confirm,
 *   kept on cancel. No cross-operation inheritance.
 * - CUSTOMER_LOCATION ≠ PAIS_CUENTA both directions.
 *
 * Visual contract under test (render.ts only):
 * - No internal metadata on cards (policy ids/versions, internal enums,
 *   repo ids); human assignment lines + identifier always shown; money
 *   block per method (USD/USDT/VES, no invented rates); contextual
 *   buttons only (no Confirmar until READY); missing-batch lists ONLY
 *   current missing + combined example; compact state cards; empty
 *   fields omitted; HTML escaping intact; one-card + NavStack + Volver
 *   + ownership untouched; location adds zero turns.
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
import { groupRowsIntoCustomers, type Customer } from '../src/mock/customers';
import { loadFixtureAccounts, type MockAccount } from '../src/mock/excelLoader';
import { MockStore } from '../src/mock/mockStore';
import { MockAccountRepositories } from '../src/mock/repositories';
import { NewSaleDraftStore } from '../src/sale/newSaleDraft';
import type { SaleClock } from '../src/sale/newSaleConfirm';
import {
  prepareNewSaleFromAction,
  prepareNewSaleFromText,
  type SaleActor,
  type SaleDeps,
  type ScopedRemainderArgs,
  type ScopedRemainderInterpreter,
} from '../src/sale/newSaleTool';
import { SessionStore } from '../src/session/store';
import type { TelegramClient } from '../src/telegram/client';
import {
  formatSaleMoney,
  renderNewSaleSummary,
  saleAssignmentHead,
} from '../src/telegram/render';
import {
  credentialCardKeyboard,
  draftKeyboard,
  saleProgressKeyboard,
} from '../src/telegram/keyboards';
import { keyboardForSaleResult } from '../src/telegram/saleHandlers';

const GABRIEL_ID = 1057242322;
const EDWARD_ID = 941030473;
const GROUP_CHAT_ID = -1005550001;
const GABRIEL: SaleActor = { chatId: GROUP_CHAT_ID, userId: GABRIEL_ID, name: 'Gabriel' };
const KNOWN_PHONE = '4145460657';
const UNKNOWN_PHONE = '04249990001';
const UNKNOWN_PHONE_2 = '04249990002';
const FULL_COMBO =
  'vende un perfil de netflix para 4145460657 por 2 meses, pagó 8 USD por zelle, lo recibió Edward';

const FIXTURE_PATH = resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx');
const PINNED_NOW = new Date('2026-09-07T12:00:00.000Z');
const clock: SaleClock = { now: () => new Date(PINNED_NOW) };

async function fixtureWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-sloc-'));
  const store = await MockStore.create({
    fixturePath: FIXTURE_PATH,
    statePath: join(dir, 'mock-state.json'),
  });
  const repos = new MockAccountRepositories(store);
  return { dir, store, repos, rows: store.accounts };
}

function toolDeps(
  saleStore: NewSaleDraftStore,
  rows: MockAccount[],
  lookup: (phone: string) => Customer[] | Promise<Customer[]>,
  scopedRemainder?: ScopedRemainderInterpreter,
  extra: Partial<SaleDeps> = {},
): SaleDeps {
  return {
    store: saleStore,
    findCustomersByPhone: lookup,
    inventoryRows: rows,
    ...(scopedRemainder !== undefined ? { scopedRemainder } : {}),
    ...extra,
  };
}

function confirmDeps(
  saleStore: NewSaleDraftStore,
  mockStore: MockStore,
  lookup: (phone: string) => Customer[],
): SaleDeps {
  return {
    store: saleStore,
    findCustomersByPhone: lookup,
    inventoryRows: mockStore.accounts,
    saleExec: { mockStore, clock },
  };
}

function countingRemainder(
  result: { field: string; value: string } | null,
): { calls: ScopedRemainderArgs[]; interpreter: ScopedRemainderInterpreter } {
  const calls: ScopedRemainderArgs[] = [];
  return {
    calls,
    interpreter: {
      interpretRemainder: async (args: ScopedRemainderArgs) => {
        calls.push(args);
        return result;
      },
    },
  };
}

function saleRow(
  over: Partial<MockAccount> & { servicio: 'netflix' | 'flujotv'; correo: string; perfil: string; nombre: string },
): MockAccount {
  return {
    contrasena: 'x',
    fechaInicio: null,
    fechaFin: null,
    dias: null,
    estatus: 'VIGENTE',
    monto: null,
    estado: '',
    numero: '',
    pais: 'VE',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// L1–L14: optional customer location
// ---------------------------------------------------------------------------

describe('customer location (L1–L14)', () => {
  it('(L1) optional model: old rows without location stay valid, old state still loads', async () => {
    const rows = loadFixtureAccounts(FIXTURE_PATH);
    // Fixture rows carry no location: grouping still works, ubicacion stays absent.
    for (const customer of groupRowsIntoCustomers(rows)) {
      expect(customer.ubicacion).toBeUndefined();
    }
    // Rows built without the field (pre-change shape) group fine too.
    const legacy: MockAccount[] = [
      { ...saleRow({ servicio: 'netflix', correo: 'a@t.com', perfil: '1 PERFIL (1)', nombre: 'Ana Vieja' }), numero: '111' },
    ];
    delete (legacy[0] as Partial<MockAccount>).ubicacion;
    expect(groupRowsIntoCustomers(legacy)[0]?.ubicacion).toBeUndefined();
    // Old persisted state (no ubicacion anywhere) still loads.
    const { dir, store } = await fixtureWorld();
    const reloaded = await MockStore.create({
      fixturePath: FIXTURE_PATH,
      statePath: join(dir, 'mock-state.json'),
    });
    expect(reloaded.accounts.length).toBe(store.accounts.length);
    expect(await store.save(join(dir, 'mock-state.json')).then(() => true)).toBe(true);
  });

  it('(L2) deterministic "de Caracas" attaches to a new customer without asking', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      `vende un perfil de netflix para ${UNKNOWN_PHONE} por 1 mes de Caracas, Juan Diaz, zelle, 4 dólares, lo recibió Edward`,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.customer.proposedCustomer).toMatchObject({
      name: 'Juan Diaz',
      phone: UNKNOWN_PHONE,
    });
    expect(result.draft?.customer.proposedCustomer?.location).toMatchObject({
      raw: 'de Caracas',
      display: 'Caracas',
      city: 'Caracas',
    });
    expect(result.draft?.customer.proposedCustomer?.location?.country).toBeUndefined();
    // Location never joins the missing-field model: nothing extra is asked.
    expect(result.missingFields).toBeUndefined();
    expect(result.text).toContain('📍 Ubicación: Caracas');
  });

  it('(L3) "Juan Diaz, Caracas" splits into name + location', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      `vende un perfil de netflix para ${UNKNOWN_PHONE} por 1 mes, Juan Diaz, Caracas, zelle, 4 dólares, lo recibió Edward`,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.customer.proposedCustomer?.name).toBe('Juan Diaz');
    expect(result.draft?.customer.proposedCustomer?.location?.display).toBe('Caracas');
    expect(result.text).toContain('Juan Diaz (nuevo)');
    expect(result.text).toContain('📍 Ubicación: Caracas');
  });

  it('(L4) "Caracas, Zelle, 4 dólares, Edward" 4-way split on an existing customer', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw));
    const first = await prepareNewSaleFromText(
      GABRIEL,
      `vende netflix para ${KNOWN_PHONE} por 2 meses`,
      deps,
    );
    expect(first.missingFields).toEqual(['method', 'amount', 'receiver']);
    const done = await prepareNewSaleFromText(
      GABRIEL,
      'Caracas, Zelle, 4 dólares, Edward',
      deps,
    );
    expect(done.kind).toBe('summary');
    // Caracas is the place (never the name), Edward the receiver.
    expect(done.draft?.customer.existingCustomerId).toBe('anny tovar');
    expect(done.draft?.customer.proposedCustomer).toBeUndefined();
    expect(done.draft?.customer.locationUpdate?.to.display).toBe('Caracas');
    expect(done.draft?.payment.method).toBe('zelle');
    expect(done.draft?.payment.actualAmount).toBe(4);
    expect(done.draft?.payment.receivedBy).toBe('Edward');
    expect(done.text).toContain('📍 Ubicación: Caracas');
  });

  it('(L5) single "Chile" captures conservatively (city only)', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      `vende un perfil de netflix para ${UNKNOWN_PHONE} por 1 mes, Juan Diaz de Chile, zelle, 4 dólares, lo recibió Edward`,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.customer.proposedCustomer?.location).toMatchObject({
      display: 'Chile',
      city: 'Chile',
    });
    expect(result.draft?.customer.proposedCustomer?.location?.country).toBeUndefined();
    expect(result.draft?.customer.proposedCustomer?.location?.stateRegion).toBeUndefined();
  });

  it('(L6) "Miami, Florida" pair maps city + region, never a country', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      `vende un perfil de netflix para ${UNKNOWN_PHONE} por 1 mes, Juan Diaz, Miami, Florida, zelle, 4 dólares, lo recibió Edward`,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.customer.proposedCustomer?.location).toMatchObject({
      display: 'Miami, Florida',
      city: 'Miami',
      stateRegion: 'Florida',
    });
    expect(result.draft?.customer.proposedCustomer?.location?.country).toBeUndefined();
  });

  it('(L7) "Bogotá, Colombia" asserts city + country', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      `vende un perfil de netflix para ${UNKNOWN_PHONE} por 1 mes, vive en Bogotá, Colombia, Juan Diaz, zelle, 4 dólares, lo recibió Edward`,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.customer.proposedCustomer?.location).toMatchObject({
      display: 'Bogotá, Colombia',
      city: 'Bogotá',
      country: 'Colombia',
    });
    expect(result.draft?.customer.proposedCustomer?.location?.stateRegion).toBeUndefined();
  });

  it('(L8) raw text preserved; "Caracas" alone never implies a country', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      `${FULL_COMBO} de Caracas`,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('summary');
    const update = result.draft?.customer.locationUpdate;
    expect(update?.to.raw).toBe('de Caracas');
    expect(update?.to.display).toBe('Caracas');
    expect(update?.to.city).toBe('Caracas');
    expect(update?.to.country).toBeUndefined();
    expect(update?.to.stateRegion).toBeUndefined();
  });

  it('(L9) full smoke sentence with location reaches summary directly; location adds zero turns', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      `${FULL_COMBO} de Caracas`,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.customer.locationUpdate?.to.display).toBe('Caracas');
    expect(result.text).toContain('📍 Ubicación: Caracas');
    // Never-ask: an incomplete sale never mentions ubicación in its batch card.
    const saleStore2 = new NewSaleDraftStore();
    const partial = await prepareNewSaleFromText(
      GABRIEL,
      'dame una cuenta nueva netflix por 30 dias',
      toolDeps(saleStore2, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(partial.kind).toBe('ask-missing');
    expect(partial.text).not.toContain('Ubicaci');
    expect(partial.text).not.toContain('📍');
    expect(partial.missingFields).not.toContain('location');
  });

  it('(L10) scoped Gemini location fallback: purpose + fail-closed, PAIS_CUENTA untouched', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    // Multi-word place without preposition: deterministic cannot claim it;
    // the customer is already resolved (Anny Tovar), so the scoped call
    // may fire exactly once with the location-only contract.
    const scoped = countingRemainder({ field: 'location', value: 'San Juan de los Morros' });
    const result = await prepareNewSaleFromText(
      GABRIEL,
      'vende netflix para 4145460657 por 2 meses, zelle, 8 dólares, lo recibió Edward, San Juan de los Morros',
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw), scoped.interpreter),
    );
    expect(scoped.calls).toHaveLength(1);
    const args = scoped.calls[0] as ScopedRemainderArgs;
    expect(args.operation).toBe('NEW_SALE');
    expect(args.purpose).toBe('OPTIONAL_CUSTOMER_LOCATION_EXTRACTION');
    expect(args.currentTurnOnly).toBe(true);
    expect(args.missing).toEqual([]);
    expect(args.allowed).toEqual(['location']);
    expect(result.draft?.customer.locationUpdate?.to.display).toBe('San Juan de los Morros');
    // A non-location decision is ignored (fail-closed).
    const saleStore2 = new NewSaleDraftStore();
    const scoped2 = countingRemainder({ field: 'method', value: 'zelle' });
    const attempt2 = await prepareNewSaleFromText(
      GABRIEL,
      'vende netflix para 4145460657 por 2 meses, zelle, 8 dólares, lo recibió Edward, San Juan de los Morros',
      toolDeps(saleStore2, rows, (raw) => repos.searchCustomersByPhone(raw), scoped2.interpreter),
    );
    expect(attempt2.draft?.customer.locationUpdate).toBeUndefined();
    expect(attempt2.draft?.customer.pendingLocation).toBeUndefined();
  });

  it('(L11) cancel and no-inventory persist nothing (location included)', async () => {
    const { store, repos, rows } = await fixtureWorld();
    const before = JSON.stringify(store.accounts);
    const saleStore = new NewSaleDraftStore();
    const deps = toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw));
    await prepareNewSaleFromText(
      GABRIEL,
      `vende un perfil de netflix para ${UNKNOWN_PHONE} por 1 mes de Caracas, Juan Diaz, zelle, 4 dólares, lo recibió Edward`,
      deps,
    );
    const cancelled = await prepareNewSaleFromAction(GABRIEL, { type: 'cancel-sale' }, deps);
    expect(cancelled.kind).toBe('cancelled');
    expect(JSON.stringify(store.accounts)).toBe(before);
    expect(groupRowsIntoCustomers(store.accounts).some((c) => c.nombre === 'Juan Diaz')).toBe(false);
    expect(store.saleOperations).toHaveLength(0);
    // No-inventory with a location mention: reported, nothing created.
    const saleStore2 = new NewSaleDraftStore();
    const deps2 = toolDeps(saleStore2, rows, (raw) => repos.searchCustomersByPhone(raw));
    const empty = await prepareNewSaleFromText(
      GABRIEL,
      `vende flujotv completa para ${KNOWN_PHONE} por 1 mes, de Valencia, zelle 9 usd, lo recibió Gabriel`,
      deps2,
    );
    expect(empty.kind).toBe('no-inventory');
    expect(JSON.stringify(store.accounts)).toBe(before);
    expect(store.saleOperations).toHaveLength(0);
  });

  it('(L12) confirm persists a new customer location (row + ledger)', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = confirmDeps(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    const prepared = await prepareNewSaleFromText(
      GABRIEL,
      `vende un perfil de netflix para ${UNKNOWN_PHONE_2} por 1 mes, Juan Diaz, Valencia, Carabobo, zelle, 4 dólares, lo recibió Edward`,
      deps,
    );
    expect(prepared.kind).toBe('summary');
    const rowIndex = prepared.draft?.proposal?.evidence.rowIndex ?? -1;
    const confirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(confirmed.kind).toBe('confirmed');
    expect(store.accounts[rowIndex]?.nombre).toBe('Juan Diaz');
    expect(store.accounts[rowIndex]?.ubicacion).toBe('Valencia, Carabobo');
    expect(store.saleOperations[0]?.customerLocation).toMatchObject({
      display: 'Valencia, Carabobo',
      city: 'Valencia',
      stateRegion: 'Carabobo',
    });
    expect(groupRowsIntoCustomers(store.accounts).find((c) => c.nombre === 'Juan Diaz')?.ubicacion?.display).toBe(
      'Valencia, Carabobo',
    );
  });

  it('(L13) existing-customer update is visible, applied on confirm, kept on cancel', async () => {
    const { store, repos } = await fixtureWorld();
    // Seed a stored location so the summary shows the compact transition.
    for (const row of store.accounts) {
      if (row.nombre.trim().toLowerCase() === 'anny tovar') {
        row.ubicacion = 'Caracas';
      }
    }
    const saleStore = new NewSaleDraftStore();
    const deps = confirmDeps(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    const prepared = await prepareNewSaleFromText(GABRIEL, `${FULL_COMBO} de Valencia`, deps);
    expect(prepared.kind).toBe('summary');
    expect(prepared.draft?.customer.locationUpdate).toMatchObject({
      existingCustomerId: 'anny tovar',
      to: { display: 'Valencia' },
    });
    expect(prepared.draft?.customer.locationUpdate?.from?.display).toBe('Caracas');
    expect(prepared.text).toContain('📍 Ubicación: Caracas → Valencia');
    const confirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(confirmed.kind).toBe('confirmed');
    const annyRows = store.accounts.filter((row) => row.nombre.trim().toLowerCase() === 'anny tovar');
    expect(annyRows.length).toBeGreaterThan(0);
    for (const row of annyRows) {
      expect(row.ubicacion).toBe('Valencia');
    }
    expect(store.saleOperations[0]?.customerLocation?.display).toBe('Valencia');
    // Cancel keeps the stored value: a second sale cancelled mid-way changes nothing.
    const saleStore2 = new NewSaleDraftStore();
    const deps2 = confirmDeps(saleStore2, store, (raw) => repos.searchCustomersByPhone(raw));
    await prepareNewSaleFromText(GABRIEL, `${FULL_COMBO} de Miami, Florida`, deps2);
    await prepareNewSaleFromAction(GABRIEL, { type: 'cancel-sale' }, deps2);
    for (const row of store.accounts.filter((r) => r.nombre.trim().toLowerCase() === 'anny tovar')) {
      expect(row.ubicacion).toBe('Valencia');
    }
  });

  it('(L14) no stale inheritance; CUSTOMER_LOCATION ≠ PAIS_CUENTA both directions', async () => {
    const { store, repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw));
    await prepareNewSaleFromText(GABRIEL, `${FULL_COMBO} de Caracas`, deps);
    await prepareNewSaleFromAction(GABRIEL, { type: 'cancel-sale' }, deps);
    // Fresh operation starts with zero location state (never inherited).
    const fresh = await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    expect(fresh.kind).toBe('summary');
    expect(fresh.draft?.customer.locationUpdate).toBeUndefined();
    expect(fresh.draft?.customer.pendingLocation).toBeUndefined();
    expect(fresh.draft?.customer.proposedCustomer?.location).toBeUndefined();
    expect(fresh.text).not.toContain('📍');
    // Direction 1: PAIS_CUENTA values never fill CUSTOMER_LOCATION…
    expect(fresh.draft?.customer.locationUpdate).toBeUndefined();
    // Direction 2: …and a captured location never writes PAIS_CUENTA.
    const saleStore2 = new NewSaleDraftStore();
    const deps2 = confirmDeps(saleStore2, store, (raw) => repos.searchCustomersByPhone(raw));
    const paisBefore = store.accounts.map((row) => row.pais);
    const located = await prepareNewSaleFromText(GABRIEL, `${FULL_COMBO} de Valencia`, deps2);
    expect(located.kind).toBe('summary');
    const confirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps2);
    expect(confirmed.kind).toBe('confirmed');
    expect(store.accounts.map((row) => row.pais)).toEqual(paisBefore);
    expect(JSON.stringify(store.saleOperations[0] ?? {}).toLowerCase()).not.toContain('pais');
    expect(store.saleOperations[0]?.customerLocation?.display).toBe('Valencia');
  });
});

// ---------------------------------------------------------------------------
// V15–V27: sale card visual redesign
// ---------------------------------------------------------------------------

describe('sale card visual redesign (V15–V27)', () => {
  it('(V15) HTML escaping intact for hostile name + location ("Juan & Hijos <Caracas>")', () => {
    const card = renderNewSaleSummary({
      customerName: 'Juan & Hijos <Caracas>',
      phone: '04249990001',
      isNewCustomer: true,
      modality: 'netflix-profile',
      requestedMonths: 1,
      grantedMonths: 1,
      assignmentModality: 'netflix-profile',
      assignmentPerfil: '1 PERFIL (4)',
      assignmentIdentifier: 'cuenta&<test>@mail.com',
      locationDisplay: 'Valencia & <Norte>',
      suggestedAmount: 4,
      suggestedCurrency: 'USD',
      actualAmount: 4,
      currency: 'USD',
      methodLabel: 'Zelle',
      receivedBy: 'Edward',
    });
    expect(card).toContain('Juan &amp; Hijos &lt;Caracas&gt;');
    expect(card).toContain('📍 Ubicación: Valencia &amp; &lt;Norte&gt;');
    expect(card).toContain('📧 cuenta&amp;&lt;test&gt;@mail.com');
    expect(card).not.toContain('Juan & Hijos <Caracas>');
    expect(card).not.toContain('<Norte>');
  });

  it('(V16) summary carries zero internal metadata', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      FULL_COMBO,
      toolDeps(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('summary');
    for (const token of [
      'sale-price-policy',
      'operational-cost-policy',
      'mock-rows-v1',
      'netflix-profile',
      'row:',
      'Política',
    ]) {
      expect(result.text).not.toContain(token);
    }
    // Behavioral data survives: human lines, money, method, receiver.
    expect(result.text).toContain('📺 Netflix · Perfil 4');
    expect(result.text).toContain('Sugerido');
    expect(result.text).toContain('Recibido');
    expect(result.text).toContain('Zelle');
    expect(result.text).toContain('Edward');
  });

  it('(V17) human Netflix assignment lines with the identifier always shown', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      FULL_COMBO,
      toolDeps(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.text).toContain('📺 Netflix · Perfil 4');
    expect(result.text).toContain('📧 hfghfgbghfghg@hotmail.com');
    expect(saleAssignmentHead('netflix-profile', '1 PERFIL (4)')).toBe('Netflix · Perfil 4');
  });

  it('(V18) FlujoTV perfil/completa equivalents with the identifier always shown', async () => {
    const shared: MockAccount[] = [
      saleRow({ servicio: 'flujotv', correo: 'flujo-libre-01@test.com', perfil: '1 PERFIL', nombre: '' }),
    ];
    const sharedStore = new NewSaleDraftStore();
    const sharedResult = await prepareNewSaleFromText(
      GABRIEL,
      `vende una compartida de flujo para Juan Diaz ${UNKNOWN_PHONE} por 1 mes, zelle 5 usd, lo recibió Gabriel`,
      toolDeps(sharedStore, shared, () => []),
    );
    expect(sharedResult.kind).toBe('summary');
    expect(sharedResult.text).toContain('📺 FlujoTV · 1 PERFIL');
    expect(sharedResult.text).toContain('📧 flujo-libre-01@test.com');
    const complete: MockAccount[] = [
      saleRow({ servicio: 'flujotv', correo: 'flujo-full-01@test.com', perfil: 'CUENTA COMPLETA', nombre: '' }),
    ];
    const completeResult = await prepareNewSaleFromText(
      GABRIEL,
      `vende una cuenta completa para Juan Diaz ${UNKNOWN_PHONE} por 1 mes, zelle 9 usd, lo recibió Gabriel`,
      toolDeps(new NewSaleDraftStore(), complete, () => []),
    );
    expect(completeResult.kind).toBe('summary');
    expect(completeResult.text).toContain('📺 FlujoTV · Completa');
    expect(completeResult.text).toContain('📧 flujo-full-01@test.com');
  });

  it('(V19) money block per method with USD/USDT/VES formatting, no invented rates', async () => {
    expect(formatSaleMoney(8, 'USD')).toBe('$8.00 USD');
    expect(formatSaleMoney(5, 'USDT')).toBe('5.00 USDT');
    expect(formatSaleMoney(1800, 'VES')).toBe('Bs 1.800,00 VES');
    const { repos, rows } = await fixtureWorld();
    const zelle = await prepareNewSaleFromText(
      GABRIEL,
      FULL_COMBO,
      toolDeps(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(zelle.text).toContain('$8.00 USD');
    const usdt = await prepareNewSaleFromText(
      { ...GABRIEL, userId: 777002 },
      `vende netflix para ${KNOWN_PHONE} por 1 mes, binance 5 usdt, lo recibió Gabriel`,
      toolDeps(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(usdt.kind).toBe('summary');
    expect(usdt.text).toContain('5.00 USDT');
    expect(usdt.text).toContain('Binance');
    const ves = await prepareNewSaleFromText(
      { ...GABRIEL, userId: 777003 },
      `vende netflix para ${KNOWN_PHONE} por 1 mes, pago móvil 1800 bs, lo recibió Gabriel`,
      toolDeps(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(ves.kind).toBe('summary');
    expect(ves.text).toContain('Bs 1.800,00 VES');
    expect(JSON.stringify(ves.draft)).not.toMatch(/equivalentUSD|exchangeRate/i);
  });

  it('(V20) location line shows only when present', async () => {
    const { repos, rows } = await fixtureWorld();
    const plain = await prepareNewSaleFromText(
      GABRIEL,
      FULL_COMBO,
      toolDeps(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(plain.text).not.toContain('📍');
    expect(plain.text).not.toContain('Ubicación');
    const located = await prepareNewSaleFromText(
      { ...GABRIEL, userId: 777004 },
      `${FULL_COMBO} de Caracas`,
      toolDeps(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(located.text).toContain('📍 Ubicación: Caracas');
  });

  it('(V21) missing-batch card lists ONLY current missing + combined example', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      `vende netflix para ${KNOWN_PHONE}`,
      toolDeps(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('ask-missing');
    expect(result.missingFields).toEqual(['months', 'method', 'amount', 'receiver']);
    // Single count header, no redundant recap line duplicating the list.
    expect(result.text).toContain('faltan 4 datos');
    expect(result.text).not.toContain('Faltan:');
    expect(result.text).toContain('UN mensaje');
    expect(result.text).toContain('Zelle, 4 dólares, lo recibió Edward');
  });

  it('(V22) contextual buttons only: no Confirmar until READY', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw));
    const incomplete = await prepareNewSaleFromText(GABRIEL, `vende netflix para ${KNOWN_PHONE}`, deps);
    expect(incomplete.kind).toBe('ask-missing');
    const progressKeyboard = keyboardForSaleResult(incomplete, 'ix1');
    expect(JSON.stringify(progressKeyboard)).not.toContain('Confirmar');
    const ready = await prepareNewSaleFromText(GABRIEL, 'por 2 meses, Zelle, 8 dólares, lo recibió Edward', deps);
    expect(ready.kind).toBe('summary');
    const readyKeyboard = keyboardForSaleResult(ready, 'ix1');
    expect(JSON.stringify(readyKeyboard)).toContain('Confirmar');
    void draftKeyboard;
    void saleProgressKeyboard;
  });

  it('(V23) confirmed card keeps the summary + Datos + WhatsApp delivery', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = confirmDeps(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    const prepared = await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    expect(prepared.kind).toBe('summary');
    const confirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(confirmed.kind).toBe('confirmed');
    expect(confirmed.text).toContain('✅ VENTA CONFIRMADA');
    expect(confirmed.text).toContain('💬 WhatsApp preparado.');
    expect(confirmed.whatsappUrl).toMatch(/^https:\/\/wa\.me\//);
    const keyboard = keyboardForSaleResult(confirmed, 'ix1', confirmed.whatsappUrl);
    expect(JSON.stringify(keyboard)).toContain('Abrir WhatsApp');
    void credentialCardKeyboard;
  });

  it('(V25) cancelled card is compact with zero side-effects', async () => {
    const { store, repos, rows } = await fixtureWorld();
    const before = store.accounts.length;
    const saleStore = new NewSaleDraftStore();
    const deps = toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw));
    await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    const cancelled = await prepareNewSaleFromAction(GABRIEL, { type: 'cancel-sale' }, deps);
    expect(cancelled.kind).toBe('cancelled');
    expect(cancelled.text).toContain('❌ Venta cancelada. No se guardó nada.');
    expect(store.accounts.length).toBe(before);
    expect(store.saleOperations).toHaveLength(0);
  });

  it('(V26) no-inventory card is compact and metadata-free', async () => {
    const { store, repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      `vende flujotv completa para ${KNOWN_PHONE} por 1 mes, zelle 9 usd, lo recibió Gabriel`,
      toolDeps(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('no-inventory');
    expect(result.text).toContain('No hay inventario disponible.');
    for (const token of ['sale-price-policy', 'mock-rows-v1', 'row:', 'Política']) {
      expect(result.text).not.toContain(token);
    }
    expect(store.saleOperations).toHaveLength(0);
  });

  it('(V27) emergency card keeps the explicit auth gate beside the summary', async () => {
    const rows: MockAccount[] = [
      saleRow({ servicio: 'netflix', correo: 'llena@test.com', perfil: '1 PERFIL (1)', nombre: 'Ocupa Uno', numero: '1111111' }),
      saleRow({ servicio: 'netflix', correo: 'emer@test.com', perfil: '1 PERFIL (5)', nombre: '', numero: '' }),
    ];
    const saleStore = new NewSaleDraftStore();
    const started = await prepareNewSaleFromText(
      GABRIEL,
      'vende netflix para 999888777 por 1 mes, zelle 4 usd, lo recibió Gabriel',
      toolDeps(saleStore, rows, () => []),
    );
    expect(started.kind).toBe('emergency-auth');
    expect(started.text).toContain('INVENTARIO DE EMERGENCIA');
    // The summary beside the gate shows the human assignment, never internals.
    expect(started.text).toContain('📺 Netflix · Perfil 5');
    expect(started.text).toContain('📧 emer@test.com');
    expect(started.text).not.toContain('sale-price-policy');
  });
});

// ---------------------------------------------------------------------------
// V24: one-card lineage (same messageId) — webhook level
// ---------------------------------------------------------------------------

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
  private nextId = 900;

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

  lastText(): string {
    return (
      this.sent
        .filter((entry) => entry.kind === 'send' || entry.kind === 'edit')
        .map((entry) => (entry.payload as CardPayload).text)
        .at(-1) ?? ''
    );
  }
}

const SECRET = 'sale-location-card-test-secret-long';

const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  TELEGRAM_BOT_TOKEN: 'tok-test-secret',
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  AUTHORIZED_TELEGRAM_USER_IDS: `${GABRIEL_ID},${EDWARD_ID}`,
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

const NAMES: Record<number, string> = { [GABRIEL_ID]: 'Gabriel', [EDWARD_ID]: 'Edward' };

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

describe('sale card lineage with location (V24)', () => {
  it('(V24) location sale stays on ONE card: 1 send, same messageId across turns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vokath-sloc-card-'));
    const mockStore = await MockStore.create({
      fixturePath: FIXTURE_PATH,
      statePath: join(dir, 'mock-state.json'),
    });
    const reposStore = await MockStore.create({
      fixturePath: FIXTURE_PATH,
      statePath: join(dir, 'repos-state.json'),
    });
    const client = new CardClient();
    const saleDrafts = new NewSaleDraftStore();
    const app: FastifyInstance = buildApp(testEnv, {
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
    let counter = 9500;
    const post = async (update: unknown): Promise<void> => {
      await app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': SECRET },
        payload: update,
      });
    };
    await post(
      textMessage((counter += 1), GABRIEL_ID, 'dame una cuenta nueva netflix por 30 dias'),
    );
    await post(textMessage((counter += 1), GABRIEL_ID, UNKNOWN_PHONE));
    await post(
      textMessage((counter += 1), GABRIEL_ID, 'Juan Diaz de Caracas, Zelle, 4 dólares, lo recibió Edward'),
    );
    expect(client.sends()).toHaveLength(1);
    expect(client.lastText()).toContain('VENTA NUEVA');
    expect(client.lastText()).toContain('Juan Diaz (nuevo)');
    expect(client.lastText()).toContain('📍 Ubicación: Caracas');
    const ids = new Set([
      client.sends()[0]?.messageId,
      ...client.edits().map((edit) => edit.messageId),
    ]);
    expect(ids.size).toBe(1);
    await app.close();
  });
});
