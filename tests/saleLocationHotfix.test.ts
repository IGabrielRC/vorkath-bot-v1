/**
 * HOTFIX 1 — open-world case-insensitive CUSTOMER_LOCATION (tool level).
 *
 * Supersedes lowercase-inert for LOCATION ONLY (non-location inert
 * contracts hold: a lowercase place never fills name/method/receiver/
 * amount, never blocks, never adds a turn):
 * - (1–2) classification is case-insensitive (`caracas`/`Caracas`/
 *   `CARACAS`, `MIAMI, FLORIDA` ≡ `Miami, Florida`); raw/display
 *   preserve the original typing verbatim.
 * - (3–6) open-world capture with no closed whitelist: `Miami, Florida`
 *   mid-sentence keeps the full pair; unknown cities/regions (never
 *   listed anywhere) capture; only safe levels asserted (never invented
 *   hierarchy; PAIS_CUENTA untouched both directions).
 * - (7–11) post-consume fragment evaluation, zero-question discipline,
 *   and name/method/receiver disambiguation.
 * - (12–15) persistence rules: cancel/no-inventory persist nothing,
 *   confirm persists the location with the customer.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockStore } from '../src/mock/mockStore';
import { MockAccountRepositories } from '../src/mock/repositories';
import type { MockAccount } from '../src/mock/excelLoader';
import type { Customer } from '../src/mock/customers';
import { groupRowsIntoCustomers } from '../src/mock/customers';
import { NewSaleDraftStore } from '../src/sale/newSaleDraft';
import type { SaleClock } from '../src/sale/newSaleConfirm';
import { prepareNewSaleFromAction, prepareNewSaleFromText, type SaleActor, type SaleDeps } from '../src/sale/newSaleTool';

const GABRIEL_ID = 1057242322;
const GROUP_CHAT_ID = -1005550001;
const GABRIEL: SaleActor = { chatId: GROUP_CHAT_ID, userId: GABRIEL_ID, name: 'Gabriel' };
const KNOWN_PHONE = '4145460657';
const UNKNOWN_PHONE = '04249990001';
const FULL_COMBO =
  'vende un perfil de netflix para 4145460657 por 2 meses, pagó 8 USD por zelle, lo recibió Edward';

const FIXTURE_PATH = resolve(process.cwd(), 'fixtures', 'BASE PRUEBA_v2.xlsx');
const PINNED_NOW = new Date('2026-09-07T12:00:00.000Z');
const clock: SaleClock = { now: () => new Date(PINNED_NOW) };

async function fixtureWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-lochot-'));
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
): SaleDeps {
  return { store: saleStore, findCustomersByPhone: lookup, inventoryRows: rows };
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

describe('HOTFIX 1 location (1–15)', () => {
  it('(1) case trio: caracas/Caracas/CARACAS share one semantic result', async () => {
    const { repos, rows } = await fixtureWorld();
    const variants = ['caracas', 'Caracas', 'CARACAS'];
    for (const variant of variants) {
      const saleStore = new NewSaleDraftStore();
      const result = await prepareNewSaleFromText(
        GABRIEL,
        `vende un perfil de netflix para ${UNKNOWN_PHONE} por 1 mes, Juan Diaz, ${variant}, zelle, 4 dólares, lo recibió Edward`,
        toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
      );
      expect(result.kind).toBe('summary');
      expect(result.draft?.customer.proposedCustomer?.name).toBe('Juan Diaz');
      expect(result.draft?.customer.proposedCustomer?.location?.city?.toLowerCase()).toBe(
        'caracas',
      );
      // Raw/display preserve the original typing verbatim.
      expect(result.draft?.customer.proposedCustomer?.location?.raw).toContain(variant);
      expect(result.draft?.customer.proposedCustomer?.location?.display).toBe(variant);
    }
  });

  it('(2) MIAMI, FLORIDA ≡ Miami, Florida (pair, verbatim display)', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      `vende un perfil de netflix para ${UNKNOWN_PHONE} por 1 mes, Juan Diaz, MIAMI, FLORIDA, zelle, 4 dólares, lo recibió Edward`,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.customer.proposedCustomer?.location).toMatchObject({
      display: 'MIAMI, FLORIDA',
      city: 'MIAMI',
      stateRegion: 'FLORIDA',
    });
    expect(result.draft?.customer.proposedCustomer?.location?.country).toBeUndefined();
  });

  it('(3) mid-sentence "Miami, Florida" keeps the full pair (no truncation to Miami)', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    // The reported smoke: the pair sits mid-sentence (not at segment
    // start), where the old position-anchored pair detector missed it
    // and the card showed only "Miami".
    const result = await prepareNewSaleFromText(
      GABRIEL,
      `vende un perfil de netflix para ${UNKNOWN_PHONE} por 1 mes Miami, Florida, Juan Diaz, zelle, 4 dólares, lo recibió Edward`,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.customer.proposedCustomer?.location).toMatchObject({
      display: 'Miami, Florida',
      city: 'Miami',
      stateRegion: 'Florida',
    });
    expect(result.text).toContain('📍 Ubicación: Miami, Florida');
  });

  it('(4) "Bogotá, Colombia" asserts city + country, never stateRegion', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      `vende un perfil de netflix para ${UNKNOWN_PHONE} por 1 mes, Bogotá, Colombia, Juan Diaz, zelle, 4 dólares, lo recibió Edward`,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.draft?.customer.proposedCustomer?.location).toMatchObject({
      display: 'Bogotá, Colombia',
      city: 'Bogotá',
      country: 'Colombia',
    });
    expect(result.draft?.customer.proposedCustomer?.location?.stateRegion).toBeUndefined();
  });

  it('(5) lone "Chile" stays safe: city only, never country/region', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      `vende un perfil de netflix para ${UNKNOWN_PHONE} por 1 mes, Juan Diaz de chile, zelle, 4 dólares, lo recibió Edward`,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.draft?.customer.proposedCustomer?.location).toMatchObject({
      city: 'chile',
    });
    expect(result.draft?.customer.proposedCustomer?.location?.country).toBeUndefined();
    expect(result.draft?.customer.proposedCustomer?.location?.stateRegion).toBeUndefined();
  });

  it('(6) open-world proof: never-listed cities capture with no whitelist', async () => {
    const { repos, rows } = await fixtureWorld();
    // Single unknown city as its own comma fragment (post-consume leftover).
    const single = await prepareNewSaleFromText(
      GABRIEL,
      `vende un perfil de netflix para ${UNKNOWN_PHONE} por 1 mes, Juan Diaz, quilmes, zelle, 4 dólares, lo recibió Edward`,
      toolDeps(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(single.kind).toBe('summary');
    expect(single.draft?.customer.proposedCustomer?.location?.city?.toLowerCase()).toBe(
      'quilmes',
    );
    // Unknown pair (neither side in any list): city + region, never country.
    const pair = await prepareNewSaleFromText(
      { ...GABRIEL, userId: 777101 },
      `vende un perfil de netflix para 04249990002 por 1 mes, Juan Diaz, Valera, Trujillo, zelle, 4 dólares, lo recibió Edward`,
      toolDeps(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(pair.draft?.customer.proposedCustomer?.location).toMatchObject({
      display: 'Valera, Trujillo',
      city: 'Valera',
      stateRegion: 'Trujillo',
    });
    expect(pair.draft?.customer.proposedCustomer?.location?.country).toBeUndefined();
  });

  it('(7) post-consume tail: full combo + lowercase place reaches summary with zero extra turns', async () => {
    const { repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      `${FULL_COMBO} de valera`,
      toolDeps(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.customer.locationUpdate?.to.city?.toLowerCase()).toBe('valera');
    expect(result.missingFields).toBeUndefined();
  });

  it('(8) zero-question: partial drafts never ask for location', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      'dame una cuenta nueva netflix por 30 dias',
      toolDeps(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('ask-missing');
    expect(result.missingFields).not.toContain('location');
    expect(result.text).not.toContain('Ubicaci');
    expect(result.text).not.toContain('📍');
  });

  it('(9) name isolation: "Juan Diaz" is the name, never the location', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      `vende un perfil de netflix para ${UNKNOWN_PHONE} por 1 mes, Juan Diaz, zelle, 4 dólares, lo recibió Edward`,
      toolDeps(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.draft?.customer.proposedCustomer?.name).toBe('Juan Diaz');
    expect(result.draft?.customer.proposedCustomer?.location).toBeUndefined();
  });

  it('(10) method/receiver isolation: Edward is the receiver, never a place', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      `vende netflix para ${KNOWN_PHONE} por 2 meses, Caracas, Zelle, 4 dólares, lo recibió Edward`,
      toolDeps(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('summary');
    // The holder fills the receiver; the place fills the location —
    // never crossed (holder collisions are dropped by the caller).
    expect(result.draft?.payment.receivedBy).toBe('Edward');
    expect(result.draft?.customer.locationUpdate?.to.display).toBe('Caracas');
    expect(result.draft?.customer.locationUpdate?.to.city).not.toBe('Edward');
  });

  it('(11) unknown receiver asks holders; the place question never appears', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      `vende un perfil de netflix para ${UNKNOWN_PHONE} por 1 mes, Juan Diaz, zelle, 4 dólares, lo recibió Pedro`,
      toolDeps(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('clarification');
    expect(result.text).toContain('Pedro');
    expect(result.text).not.toContain('Ubicaci');
    expect(result.draft?.customer.proposedCustomer?.location).toBeUndefined();
  });

  it('(12) PAIS_CUENTA → location: stored service countries never fill the place', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      FULL_COMBO,
      toolDeps(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.customer.locationUpdate).toBeUndefined();
    expect(result.draft?.customer.pendingLocation).toBeUndefined();
    expect(result.text).not.toContain('📍');
  });

  it('(13) location → PAIS_CUENTA: confirming with a place leaves service countries intact', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = confirmDeps(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    const prepared = await prepareNewSaleFromText(GABRIEL, `${FULL_COMBO} de Caracas`, deps);
    expect(prepared.kind).toBe('summary');
    const confirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(confirmed.kind).toBe('confirmed');
    // The customer row carries the place; subscriptions keep their own
    // PAIS_CUENTA from the service rows (never derived from the place).
    const customers = groupRowsIntoCustomers(store.accounts);
    const stored = customers.find((customer) =>
      customer.phones.some((phone) => phone.includes('4145460657')),
    );
    expect(stored).toBeDefined();
    for (const sub of stored?.subscriptions ?? []) {
      expect(sub.paisCuenta).not.toBe('Caracas');
    }
  });

  it('(14) cancel persists nothing (location included)', async () => {
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
    expect(store.saleOperations).toHaveLength(0);
    expect(groupRowsIntoCustomers(store.accounts).some((c) => c.nombre === 'Juan Diaz')).toBe(
      false,
    );
  });

  it('(15) confirm persists the new-customer location with the customer', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = confirmDeps(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    const prepared = await prepareNewSaleFromText(
      GABRIEL,
      `vende un perfil de netflix para ${UNKNOWN_PHONE} por 1 mes de Caracas, Juan Diaz, zelle, 4 dólares, lo recibió Edward`,
      deps,
    );
    expect(prepared.kind).toBe('summary');
    const confirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(confirmed.kind).toBe('confirmed');
    expect(confirmed.text).toContain('📍 Ubicación: Caracas');
    expect(groupRowsIntoCustomers(store.accounts).some((c) => c.nombre === 'Juan Diaz')).toBe(
      true,
    );
  });
});
