/**
 * Slice A — NewSale domain: draft, pricing, inventory selection.
 *
 * Proposal only: confirm execution belongs to Slice B (refuses here).
 * Real fixture values throughout: Anny Tovar 4145460657 (single),
 * 4141294973 → Stefania Marmai (Gian) + Iliana Rodriguez (shared),
 * 04240000000 (unknown), hfghfgbghfghg@hotmail.com free `1 PERFIL (4)`
 * rows, cmaxnet001 shared clients, maxnet001 Jesus Galvis VENCIDO
 * assigned-complete. Synthetic rows mirror fixture shapes ONLY where
 * the fixture has no coverage (free profile-5, fully-free account,
 * non-ACTIVE accounts, free FlujoTV slots).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { groupRowsIntoCustomers, type Customer } from '../src/mock/customers';
import { loadFixtureAccounts, type MockAccount } from '../src/mock/excelLoader';
import { MockStore } from '../src/mock/mockStore';
import { MockAccountRepositories } from '../src/mock/repositories';
import { identifyPhone, identitiesMatch } from '../src/mock/phone';
import { deriveExpiryStatus } from '../src/mock/customers';
import {
  COST_TABLE_V1,
  PRICE_TABLE_V1,
  costSnapshotFor,
  pendingPriceDecisions,
  priceSnapshotFor,
} from '../src/sale/pricePolicy';
import {
  classifyFlujoSlot,
  classifyNetflixProfile,
  isRowOccupied,
  revalidateProposal,
  selectInventory,
} from '../src/sale/inventory';
import {
  currencyForMethod,
  detectSplitPayment,
  labelForMethod,
  matchCashHolder,
  parsePaymentMethod,
  resolveCashHolders,
} from '../src/sale/payments';
import {
  NewSaleDraftStore,
  SALE_CONFIRM_REFUSED_TEXT,
  applySalePatch,
} from '../src/sale/newSaleDraft';
import { parseSaleExtraction } from '../src/sale/saleParser';
import {
  prepareNewSaleFromAction,
  prepareNewSaleFromText,
  type SaleActor,
  type SaleDeps,
} from '../src/sale/newSaleTool';

const GABRIEL: SaleActor = { chatId: -1005550001, userId: 1057242322, name: 'Gabriel' };
const EDWARD: SaleActor = { chatId: -1005550001, userId: 941030473, name: 'Edward' };

const FIXTURE_PATH = resolve(process.cwd(), 'fixtures/BASE PRUEBA_v2.xlsx');

async function fixtureWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-sale-'));
  const store = await MockStore.create({
    fixturePath: FIXTURE_PATH,
    statePath: join(dir, 'mock-state.json'),
  });
  const repos = new MockAccountRepositories(store);
  return { store, repos, rows: store.accounts };
}

function saleRow(over: Partial<MockAccount> & { servicio: 'netflix' | 'flujotv'; correo: string; perfil: string; nombre: string }): MockAccount {
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

function stubCustomer(id: string, nombre: string, phone: string): Customer {
  return { id, nombre, phones: [phone], subscriptions: [] };
}

function depsFor(
  store: NewSaleDraftStore,
  rows: MockAccount[],
  lookup: (phone: string) => Customer[],
  extra: Partial<SaleDeps> = {},
): SaleDeps {
  return { store, findCustomersByPhone: lookup, inventoryRows: rows, ...extra };
}

const FULL_COMBO =
  'vende un perfil de netflix para 4145460657 por 2 meses, pagó 8 USD por zelle, lo recibió Edward';

// ---------------------------------------------------------------------------
// Clients 1–8
// ---------------------------------------------------------------------------

describe('sale clients (1–8)', () => {
  it('(1) existing single-phone client resolves to Anny Tovar', async () => {
    const { repos, rows } = await fixtureWorld();
    const found = await repos.searchCustomersByPhone('4145460657');
    expect(found.map((c) => c.nombre)).toEqual(['Anny Tovar']);
    const store = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      FULL_COMBO,
      depsFor(store, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.customer.existingCustomerId).toBe('anny tovar');
  });

  it('(2) unknown phone stays new-only-in-sale: read finds nothing, nothing created', async () => {
    const { store, repos, rows } = await fixtureWorld();
    const before = store.accounts.length;
    expect(await repos.searchCustomersByPhone('04240000000')).toEqual([]);
    const saleStore = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      { ...GABRIEL, userId: 777001 },
      'vende netflix para 04240000000 por 1 mes',
      depsFor(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('new-customer');
    expect(store.accounts.length).toBe(before);
    expect(await repos.searchCustomersByPhone('04240000000')).toEqual([]);
  });

  it('(3) no persist before confirm: proposed customer lives in the draft only', async () => {
    const { store, repos, rows } = await fixtureWorld();
    const before = store.accounts.length;
    const saleStore = new NewSaleDraftStore();
    const started = await prepareNewSaleFromText(
      GABRIEL,
      'vende netflix para 04240000000 por 1 mes',
      depsFor(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(started.kind).toBe('new-customer');
    const named = await prepareNewSaleFromAction(
      GABRIEL,
      { type: 'provide-name', name: 'Cliente Nuevo' },
      depsFor(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(named.draft?.customer.proposedCustomer).toMatchObject({
      name: 'Cliente Nuevo',
      phone: '04240000000',
    });
    expect(store.accounts.length).toBe(before);
    expect(groupRowsIntoCustomers(store.accounts).some((c) => c.nombre === 'Cliente Nuevo')).toBe(false);
  });

  it('(4) explicit cancel leaves nothing: draft gone, store untouched', async () => {
    const { store, repos, rows } = await fixtureWorld();
    const before = store.accounts.length;
    const saleStore = new NewSaleDraftStore();
    await prepareNewSaleFromText(
      GABRIEL,
      'vende netflix para 04240000000 por 1 mes',
      depsFor(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    const cancelled = await prepareNewSaleFromAction(
      GABRIEL,
      { type: 'cancel-sale' },
      depsFor(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(cancelled.kind).toBe('cancelled');
    expect(saleStore.get({ chatId: GABRIEL.chatId, userId: GABRIEL.userId })).toBeUndefined();
    expect(store.accounts.length).toBe(before);
  });

  it('(5) no-inventory leaves nothing: proposal null, cancel clean', async () => {
    const { store, repos, rows } = await fixtureWorld();
    const before = store.accounts.length;
    const saleStore = new NewSaleDraftStore();
    // Every fixture FlujoTV-complete row is occupied → no free complete.
    const result = await prepareNewSaleFromText(
      GABRIEL,
      'vende flujotv completa para 4145460657 por 1 mes, zelle 9 usd, lo recibió Gabriel',
      depsFor(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('no-inventory');
    expect(result.text).toContain('No hay inventario disponible.');
    expect(result.draft?.proposal).toBeNull();
    await prepareNewSaleFromAction(
      GABRIEL,
      { type: 'cancel-sale' },
      depsFor(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(store.accounts.length).toBe(before);
  });

  it('(6) normal search still never creates: unknown stays not-found with no draft', async () => {
    const { repos, rows } = await fixtureWorld();
    expect(await repos.searchCustomersByPhone('04240000000')).toEqual([]);
    expect(await repos.searchAccounts('cuenta-inexistente-zzz')).toEqual([]);
    const saleStore = new NewSaleDraftStore();
    expect(saleStore.get({ chatId: GABRIEL.chatId, userId: GABRIEL.userId })).toBeUndefined();
    void rows;
  });

  it('(7) shared phone disambiguates: Stefania + Iliana, operator picks one', async () => {
    const { repos, rows } = await fixtureWorld();
    const found = await repos.searchCustomersByPhone('4141294973');
    expect(found.map((c) => c.nombre).sort()).toEqual(['Iliana Rodriguez', 'Stefania Marmai (Gian)'].sort());
    const saleStore = new NewSaleDraftStore();
    const started = await prepareNewSaleFromText(
      GABRIEL,
      'vende netflix para 4141294973 por 1 mes',
      depsFor(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(started.kind).toBe('disambiguate');
    expect(started.customers?.map((c) => c.nombre).sort()).toEqual(
      ['Iliana Rodriguez', 'Stefania Marmai (Gian)'].sort(),
    );
    const iliana = started.customers?.find((c) => c.nombre === 'Iliana Rodriguez');
    const picked = await prepareNewSaleFromAction(
      GABRIEL,
      { type: 'select-customer', customerId: iliana?.id ?? '' },
      depsFor(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(picked.draft?.customer.existingCustomerId).toBe(iliana?.id);
  });

  it('(8) PhoneIdentity intact: shared tails never match, explicit-+ keeps priority', async () => {
    const { repos } = await fixtureWorld();
    const partial = identifyPhone('4600657')[0];
    const full = identifyPhone('4145460657')[0];
    expect(partial !== undefined && full !== undefined).toBe(true);
    expect(identitiesMatch(partial as never, full as never)).toBe(false);
    expect(await repos.searchCustomersByPhone('4600657')).toEqual([]);
    const explicit = identifyPhone('+58 414-5460657')[0];
    expect(explicit?.e164).toBe(full?.e164);
  });
});

// ---------------------------------------------------------------------------
// Inventory 9–17
// ---------------------------------------------------------------------------

describe('sale inventory (9–17)', () => {
  it('(9) Netflix priority: partially-occupied commercial before fully-free', async () => {
    const { rows } = await fixtureWorld();
    const proposal = selectInventory(rows, 'netflix-profile');
    expect(proposal.kind).toBe('slot');
    if (proposal.kind !== 'slot') {
      return;
    }
    // Fixture proof: hfghfgbghfghg has 3 occupied + 2 free `1 PERFIL (4)`.
    expect(proposal.candidate.serviceAccountId).toBe('netflix:hfghfgbghfghg@hotmail.com');
    expect(proposal.candidate.perfil).toBe('1 PERFIL (4)');
    expect(classifyNetflixProfile(proposal.candidate.perfil)).toBe('commercial');
  });

  it('(10) fully-free account serves when no partial has commercial free', () => {
    const rows: MockAccount[] = [
      saleRow({ servicio: 'netflix', correo: 'llena@test.com', perfil: '1 PERFIL (1)', nombre: 'Ocupa Uno', numero: '1111111' }),
      saleRow({ servicio: 'netflix', correo: 'llena@test.com', perfil: '1 PERFIL (2)', nombre: 'Ocupa Dos', numero: '2222222' }),
      saleRow({ servicio: 'netflix', correo: 'libre@test.com', perfil: '1 PERFIL (3)', nombre: '', numero: '' }),
    ];
    const proposal = selectInventory(rows, 'netflix-profile');
    expect(proposal.kind).toBe('slot');
    if (proposal.kind !== 'slot') {
      return;
    }
    expect(proposal.candidate.serviceAccountId).toBe('netflix:libre@test.com');
  });

  it('(11) emergency profile-5 needs explicit auth, never auto-used', async () => {
    const rows: MockAccount[] = [
      saleRow({ servicio: 'netflix', correo: 'llena@test.com', perfil: '1 PERFIL (1)', nombre: 'Ocupa Uno', numero: '1111111' }),
      saleRow({ servicio: 'netflix', correo: 'emer@test.com', perfil: '1 PERFIL (5)', nombre: '', numero: '' }),
    ];
    const proposal = selectInventory(rows, 'netflix-profile');
    expect(proposal.kind).toBe('emergency-auth-required');
    if (proposal.kind !== 'emergency-auth-required') {
      return;
    }
    expect(classifyNetflixProfile(proposal.candidate.perfil)).toBe('emergency');
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, rows, () => [stubCustomer('carlos', 'Carlos Prueba', '999888777')]);
    const started = await prepareNewSaleFromText(
      GABRIEL,
      'vende netflix para 999888777 por 1 mes, zelle 4 usd, lo recibió Gabriel',
      deps,
    );
    expect(started.kind).toBe('emergency-auth');
    expect(started.text).toContain('INVENTARIO DE EMERGENCIA');
    expect(started.draft?.proposal?.emergencyAuthorized).toBe(false);
    const authed = await prepareNewSaleFromAction(GABRIEL, { type: 'authorize-emergency' }, deps);
    expect(authed.draft?.proposal?.emergencyAuthorized).toBe(true);
  });

  it('(12) assigned-even-expired is unavailable: maxnet001 Jesus Galvis VENCIDO blocks complete', async () => {
    const { rows } = await fixtureWorld();
    const scoped = rows.filter((row) => row.correo.trim().toLowerCase() === 'maxnet001');
    expect(scoped.map((r) => r.nombre)).toEqual(['Jesus Galvis']);
    expect(deriveExpiryStatus(scoped[0]?.fechaFin ?? null, '2026-12-01').estatus).toBe('Vencido');
    expect(isRowOccupied(scoped[0] as MockAccount)).toBe(true);
    expect(selectInventory(scoped, 'flujotv-complete')).toEqual({
      kind: 'none',
      reason: 'no-complete-free',
    });
  });

  it('(13) WAITING_SUPPLIER accounts never count as inventory', () => {
    const rows: MockAccount[] = [
      saleRow({ servicio: 'netflix', correo: 'espera@test.com', perfil: '1 PERFIL (1)', nombre: '', numero: '' }),
      saleRow({ servicio: 'netflix', correo: 'ok@test.com', perfil: '1 PERFIL (2)', nombre: '', numero: '' }),
    ];
    const statusOf = (id: string): 'ACTIVE' | 'WAITING_SUPPLIER' =>
      id === 'netflix:espera@test.com' ? 'WAITING_SUPPLIER' : 'ACTIVE';
    const proposal = selectInventory(rows, 'netflix-profile', { statusOf });
    expect(proposal.kind).toBe('slot');
    if (proposal.kind !== 'slot') {
      return;
    }
    expect(proposal.candidate.serviceAccountId).toBe('netflix:ok@test.com');
    expect(selectInventory(rows, 'netflix-profile', { statusOf: () => 'WAITING_SUPPLIER' })).toEqual({
      kind: 'none',
      reason: 'no-commercial-or-emergency',
    });
  });

  it('(14) FALLEN accounts never count as inventory', () => {
    const rows: MockAccount[] = [
      saleRow({ servicio: 'netflix', correo: 'caida@test.com', perfil: '1 PERFIL (1)', nombre: '', numero: '' }),
    ];
    expect(selectInventory(rows, 'netflix-profile', { statusOf: () => 'FALLEN' })).toEqual({
      kind: 'none',
      reason: 'no-commercial-or-emergency',
    });
  });

  it('(15) BLOCKED accounts never count as inventory', () => {
    const rows: MockAccount[] = [
      saleRow({ servicio: 'flujotv', correo: 'bloq001', perfil: '1 PERFIL', nombre: '', numero: '' }),
    ];
    expect(selectInventory(rows, 'flujotv-shared', { statusOf: () => 'BLOCKED' })).toEqual({
      kind: 'none',
      reason: 'no-shared-capacity',
    });
  });

  it('(16) FlujoTV shared respects capacity: default slot count, override narrows', () => {
    // cmaxnet001 shape: 3 real occupied clients + 1 free slot row.
    const rows: MockAccount[] = [
      saleRow({ servicio: 'flujotv', correo: 'cmaxnet001', perfil: '1 PERFIL', nombre: 'Anny Tovar', numero: '4145460657' }),
      saleRow({ servicio: 'flujotv', correo: 'cmaxnet001', perfil: '1 PERFIL', nombre: 'Neisis Zambrano', numero: '4241302911' }),
      saleRow({ servicio: 'flujotv', correo: 'cmaxnet001', perfil: '1 PERFIL', nombre: 'Roman Morales', numero: '4128053264' }),
      saleRow({ servicio: 'flujotv', correo: 'cmaxnet001', perfil: '1 PERFIL', nombre: '', numero: '' }),
    ];
    const open = selectInventory(rows, 'flujotv-shared');
    expect(open.kind).toBe('slot');
    const capped = selectInventory(rows, 'flujotv-shared', {
      capacityOverrides: { 'flujotv:cmaxnet001': 3 },
    });
    expect(capped).toEqual({ kind: 'none', reason: 'no-shared-capacity' });
    expect(classifyFlujoSlot('1 PERFIL')).toBe('shared');
  });

  it('(17) complete exclusivity: free complete serves, any occupant blocks', () => {
    const free: MockAccount[] = [
      saleRow({ servicio: 'flujotv', correo: 'maxnet099', perfil: 'CUENTA COMPLETA', nombre: '', numero: '' }),
    ];
    const taken: MockAccount[] = [
      saleRow({ servicio: 'flujotv', correo: 'maxnet100', perfil: 'CUENTA COMPLETA', nombre: 'Vencido Viejo', numero: '5555555', fechaFin: '2020-01-01' }),
    ];
    expect(selectInventory(free, 'flujotv-complete').kind).toBe('slot');
    expect(selectInventory(taken, 'flujotv-complete')).toEqual({
      kind: 'none',
      reason: 'no-complete-free',
    });
    expect(classifyFlujoSlot('CUENTA COMPLETA')).toBe('complete');
  });

  it('(17b) revalidate-at-confirm design: taken/inactive/unknown fail closed', async () => {
    const { rows } = await fixtureWorld();
    const proposal = selectInventory(rows, 'netflix-profile');
    if (proposal.kind !== 'slot') {
      throw new Error('fixture must offer a Netflix commercial slot');
    }
    expect(revalidateProposal(rows, proposal.evidence).ok).toBe(true);
    const taken = rows.map((row, index) =>
      index === proposal.evidence.rowIndex ? { ...row, nombre: 'Otro Cliente' } : row,
    );
    expect(revalidateProposal(taken, proposal.evidence)).toEqual({ ok: false, reason: 'slot-taken' });
    expect(
      revalidateProposal(rows, proposal.evidence, { statusOf: () => 'FALLEN' }),
    ).toEqual({ ok: false, reason: 'account-inactive' });
  });
});

// ---------------------------------------------------------------------------
// Price/cost 20–27
// ---------------------------------------------------------------------------

describe('sale price/cost (20–27)', () => {
  it('(20) approved unit prices: 4 / 5 / 9 USD (BR-SAL-004)', () => {
    expect(PRICE_TABLE_V1.unitPrice['netflix-profile']).toBe(4);
    expect(PRICE_TABLE_V1.unitPrice['flujotv-shared']).toBe(5);
    expect(PRICE_TABLE_V1.unitPrice['flujotv-complete']).toBe(9);
    expect(PRICE_TABLE_V1.currency).toBe('USD');
  });

  it('(21) price snapshot carries policy id/version/unit/currency/suggested', () => {
    expect(priceSnapshotFor('netflix-profile', 2)).toEqual({
      policyId: 'sale-price-policy',
      policyVersion: 'v1',
      modality: 'netflix-profile',
      unitPrice: 4,
      currency: 'USD',
      months: 2,
      suggestedAmount: 8,
    });
  });

  it('(22) operational costs 2 / 1.50 / 3.50 with unit×months recognition', () => {
    expect(COST_TABLE_V1.unitCost['netflix-profile']).toBe(2);
    expect(COST_TABLE_V1.unitCost['flujotv-shared']).toBe(1.5);
    expect(COST_TABLE_V1.unitCost['flujotv-complete']).toBe(3.5);
    expect(costSnapshotFor('flujotv-shared', 2).recognizedCost).toBe(3);
    expect(costSnapshotFor('flujotv-complete', 2).recognizedCost).toBe(7);
  });

  it('(23) history immune: v1 snapshot survives a later config change', () => {
    const v1 = priceSnapshotFor('netflix-profile', 2);
    const v2 = priceSnapshotFor('netflix-profile', 2, {
      price: { ...PRICE_TABLE_V1, policyVersion: 'v2', unitPrice: { ...PRICE_TABLE_V1.unitPrice, 'netflix-profile': 6 } },
    });
    expect(v1.suggestedAmount).toBe(8);
    expect(v2.suggestedAmount).toBe(12);
    expect(v1.policyVersion).toBe('v1');
  });

  it('(24) summary shows suggested vs real amounts side by side', async () => {
    const { repos, rows } = await fixtureWorld();
    const store = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      FULL_COMBO,
      depsFor(store, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.price?.suggestedAmount).toBe(8);
    expect(result.draft?.payment.actualAmount).toBe(8);
    expect(result.text).toContain('Sugerido');
    expect(result.text).toContain('Recibido');
  });

  it('(25) months multiply price and cost: 3 Netflix months → 12 / 6', () => {
    expect(priceSnapshotFor('netflix-profile', 3).suggestedAmount).toBe(12);
    expect(costSnapshotFor('netflix-profile', 3).recognizedCost).toBe(6);
  });

  it('(26) no promotions assumed: 6 FlujoTV months grant exactly 6 (BR-FLW-006 pending)', () => {
    expect(priceSnapshotFor('flujotv-shared', 6).suggestedAmount).toBe(30);
    expect(pendingPriceDecisions().some((d) => d.startsWith('BR-FLW-006'))).toBe(true);
  });

  it('(27) draft price snapshot pins the policy version used', async () => {
    const { repos, rows } = await fixtureWorld();
    const store = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      FULL_COMBO,
      depsFor(store, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.draft?.price?.policyVersion).toBe('v1');
    expect(result.draft?.cost?.policyVersion).toBe('v1');
    expect(result.text).toContain('sale-price-policy v1');
  });
});

// ---------------------------------------------------------------------------
// Payment 28–37
// ---------------------------------------------------------------------------

describe('sale payment (28–37)', () => {
  it('(28) currency inference: Pago Móvil→VES, Zelle→USD, Binance→USDT', () => {
    expect(parsePaymentMethod('pago móvil')).toBe('pago-movil');
    expect(currencyForMethod('pago-movil')).toBe('VES');
    expect(parsePaymentMethod('por zelle')).toBe('zelle');
    expect(currencyForMethod('zelle')).toBe('USD');
    expect(parsePaymentMethod('binance usdt')).toBe('binance');
    expect(currencyForMethod('binance')).toBe('USDT');
    expect(labelForMethod('zelle')).toBe('Zelle');
  });

  it('(29) operator derives from the session, never asked', async () => {
    const { repos, rows } = await fixtureWorld();
    const store = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      EDWARD,
      'vende netflix para 4145460657 por 1 mes, zelle 4 usd, lo recibió Gabriel',
      depsFor(store, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.draft?.operator).toBe('Edward');
  });

  it('(30) receivedBy is independent: Gabriel operates, Edward receives', async () => {
    const { repos, rows } = await fixtureWorld();
    const store = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      FULL_COMBO,
      depsFor(store, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.draft?.operator).toBe('Gabriel');
    expect(result.draft?.payment.receivedBy).toBe('Edward');
    expect(result.text).toContain('Recibido por');
  });

  it('(31) real vs suggested stay visible even when they differ', async () => {
    const { repos, rows } = await fixtureWorld();
    const store = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      'vende un perfil de netflix para 4145460657 por 2 meses, pagó 10 USD por zelle, lo recibió Edward',
      depsFor(store, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.draft?.price?.suggestedAmount).toBe(8);
    expect(result.draft?.payment.actualAmount).toBe(10);
  });

  it('(32) reference is optional: kept when stated, absent otherwise', async () => {
    const { repos, rows } = await fixtureWorld();
    const withRef = await prepareNewSaleFromText(
      GABRIEL,
      'vende netflix para 4145460657 por 1 mes, zelle 4 usd ref ABC123, lo recibió Gabriel',
      depsFor(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(withRef.draft?.payment.reference).toBe('ABC123');
    expect(withRef.text).toContain('Referencia');
    const bare = await prepareNewSaleFromText(
      EDWARD,
      'vende netflix para 4145460657 por 1 mes, zelle 4 usd, lo recibió Edward',
      depsFor(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(bare.draft?.payment.reference).toBeUndefined();
    expect(bare.text).not.toContain('Referencia');
  });

  it('(33) split payments refused: clarification, method untouched', async () => {
    const { repos, rows } = await fixtureWorld();
    const store = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      'vende netflix para 4145460657, mitad zelle mitad pago móvil',
      depsFor(store, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(detectSplitPayment('mitad zelle mitad pago móvil')).toBe(true);
    expect(result.kind).toBe('clarification');
    expect(result.text).toContain('un solo método');
    expect(result.draft?.payment.method).toBeNull();
  });

  it('(34) holders default to the documented Gabriel/Edward pair', () => {
    expect(resolveCashHolders()).toEqual(['Gabriel', 'Edward']);
    expect(resolveCashHolders('')).toEqual(['Gabriel', 'Edward']);
  });

  it('(35) holders ≠ operators: unknown receiver fails closed', async () => {
    const { repos, rows } = await fixtureWorld();
    expect(matchCashHolder('Andres', resolveCashHolders())).toBeUndefined();
    const store = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      'vende netflix para 4145460657 por 1 mes, zelle 4 usd, lo recibió Andres',
      depsFor(store, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('clarification');
    expect(result.draft?.payment.receivedBy).toBeNull();
  });

  it('(36) configured holders win over the default pair', () => {
    expect(resolveCashHolders('Gabriel')).toEqual(['Gabriel']);
    expect(matchCashHolder('edward', resolveCashHolders('Gabriel'))).toBeUndefined();
    expect(matchCashHolder('EDWARD', resolveCashHolders())).toBe('Edward');
  });

  it('(37) unknown receiver keeps every other stated field (fail-closed granularity)', async () => {
    const { repos, rows } = await fixtureWorld();
    const store = new NewSaleDraftStore();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      'vende netflix para 4145460657 por 2 meses, zelle 8 usd, lo recibió Andres',
      depsFor(store, rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('clarification');
    expect(result.draft?.duration.requestedMonths).toBe(2);
    expect(result.draft?.payment.method).toBe('zelle');
    expect(result.draft?.payment.actualAmount).toBe(8);
    expect(result.draft?.payment.receivedBy).toBeNull();
  });

  it('(37b) netflix completa is reported, never coerced (BR-NFX-007 pending)', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      'vende cuenta completa de netflix para 4145460657',
      depsFor(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(parseSaleExtraction('vende cuenta completa de netflix').unsupported).toBe('netflix-complete');
    expect(result.kind).toBe('unsupported');
    expect(result.draft?.modality).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Draft 38–46
// ---------------------------------------------------------------------------

describe('sale draft (38–46)', () => {
  it('(38) zero-redundant: full-combo single sentence asks nothing', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      FULL_COMBO,
      depsFor(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('summary');
    expect(result.draft?.operationId).toMatch(/^ns-[0-9a-f]{8}$/);
    expect(result.draft?.kind).toBe('NEW_SALE');
    expect(result.draft?.status).toBe('DRAFT');
  });

  it('(39) partial asks only missing: service kept, phone asked', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      'vende netflix',
      depsFor(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    expect(result.kind).toBe('ask-missing');
    expect(result.missing).toBe('customer');
    expect(result.draft?.service).toBe('netflix');
    expect(result.text).toContain('teléfono');
  });

  it('(40) month correction recalcs the SAME draft (operationId stable, version up)', async () => {
    const { repos, rows } = await fixtureWorld();
    const store = new NewSaleDraftStore();
    const deps = depsFor(store, rows, (raw) => repos.searchCustomersByPhone(raw));
    const first = await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    const second = await prepareNewSaleFromText(GABRIEL, 'cámbialo a 3 meses', deps);
    expect(second.draft?.operationId).toBe(first.draft?.operationId);
    expect(second.draft?.duration.requestedMonths).toBe(3);
    expect(second.draft?.price?.suggestedAmount).toBe(12);
    expect(second.draft?.cost?.recognizedCost).toBe(6);
    expect((second.draft?.version ?? 0)).toBeGreaterThan(first.draft?.version ?? 0);
  });

  it('(41) service switch invalidates proposal and reprices (same draft)', async () => {
    const rows: MockAccount[] = [
      saleRow({ servicio: 'netflix', correo: 'n1@test.com', perfil: '1 PERFIL (1)', nombre: 'Ocupa Uno', numero: '1111111' }),
      saleRow({ servicio: 'netflix', correo: 'n1@test.com', perfil: '1 PERFIL (2)', nombre: '', numero: '' }),
      saleRow({ servicio: 'flujotv', correo: 'cmaxnet099', perfil: '1 PERFIL', nombre: 'Ocupa Dos', numero: '2222222' }),
      saleRow({ servicio: 'flujotv', correo: 'cmaxnet099', perfil: '1 PERFIL', nombre: '', numero: '' }),
    ];
    const store = new NewSaleDraftStore();
    const lookup = (): Customer[] => [stubCustomer('carlos', 'Carlos Prueba', '999888777')];
    const deps = depsFor(store, rows, lookup);
    const first = await prepareNewSaleFromText(
      GABRIEL,
      'vende perfil netflix a 999888777 por 1 mes, zelle 4 usd, lo recibió Gabriel',
      deps,
    );
    expect(first.draft?.modality).toBe('netflix-profile');
    const before = first.draft?.proposal?.serviceAccountId ?? '';
    expect(before).toContain('netflix:');
    const pure = applySalePatch(first.draft as never, { modality: 'flujotv-shared' });
    expect(pure.proposalInvalidated).toBe(true);
    expect(pure.draft.proposal).toBeNull();
    const second = await prepareNewSaleFromText(GABRIEL, 'mejor flujotv compartida', deps);
    expect(second.draft?.operationId).toBe(first.draft?.operationId);
    expect(second.draft?.modality).toBe('flujotv-shared');
    expect(second.draft?.proposal?.serviceAccountId).toBe('flujotv:cmaxnet099');
    expect(second.draft?.price?.unitPrice).toBe(5);
  });

  it('(42) drafts never expire: no TTL fields, still open after restore', async () => {
    const { repos, rows } = await fixtureWorld();
    const store = new NewSaleDraftStore();
    const deps = depsFor(store, rows, (raw) => repos.searchCustomersByPhone(raw));
    const first = await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    const raw = JSON.stringify(first.draft);
    expect(raw).not.toMatch(/expiresAt|expires_at|ttl|TTL/);
    const revived = new NewSaleDraftStore();
    revived.restore(store.snapshot());
    expect(revived.get({ chatId: GABRIEL.chatId, userId: GABRIEL.userId })?.operationId).toBe(
      first.draft?.operationId,
    );
  });

  it('(43) READ-safe navigation: searches never touch the sale draft', async () => {
    const { repos, rows } = await fixtureWorld();
    const store = new NewSaleDraftStore();
    const deps = depsFor(store, rows, (raw) => repos.searchCustomersByPhone(raw));
    const first = await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    await repos.searchCustomersByPhone('4145460657');
    await repos.searchAccounts('netflix');
    await repos.searchServiceAccounts('cmaxnet001');
    const current = store.get({ chatId: GABRIEL.chatId, userId: GABRIEL.userId });
    expect(current?.operationId).toBe(first.draft?.operationId);
    expect(current?.version).toBe(first.draft?.version);
  });

  it('(44) one draft per operator: re-entry recovers, never silently replaces', async () => {
    const { repos, rows } = await fixtureWorld();
    const store = new NewSaleDraftStore();
    const deps = depsFor(store, rows, (raw) => repos.searchCustomersByPhone(raw));
    const first = await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    const again = store.create(
      { chatId: GABRIEL.chatId, userId: GABRIEL.userId },
      'Gabriel',
    );
    expect(again.resumed).toBe(true);
    expect(again.draft.operationId).toBe(first.draft?.operationId);
    // Peer operators stay isolated on their own key.
    const peer = await prepareNewSaleFromText(EDWARD, 'vende netflix', deps);
    expect(peer.draft?.operationId).not.toBe(first.draft?.operationId);
  });

  it('(45) confirm refuses in Slice A: stays DRAFT, zero side-effects', async () => {
    const { store, repos, rows } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, rows, (raw) => repos.searchCustomersByPhone(raw));
    const before = store.accounts.length;
    await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    const refused = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(refused.kind).toBe('confirm-refused');
    expect(refused.text).toBe(SALE_CONFIRM_REFUSED_TEXT);
    expect(saleStore.get({ chatId: GABRIEL.chatId, userId: GABRIEL.userId })?.status).toBe('DRAFT');
    expect(store.accounts.length).toBe(before);
  });

  it('(46) no credentials in draft payload or summary card', async () => {
    const { repos, rows } = await fixtureWorld();
    const result = await prepareNewSaleFromText(
      GABRIEL,
      FULL_COMBO,
      depsFor(new NewSaleDraftStore(), rows, (raw) => repos.searchCustomersByPhone(raw)),
    );
    const serialized = JSON.stringify(result.draft);
    expect(serialized).not.toMatch(/contrasena|password|Contraseña|PIN/);
    // Real fixture password of the proposed account must not leak either.
    expect(serialized).not.toContain('juan8727');
    expect(result.text).not.toContain('juan8727');
    expect(result.text).not.toMatch(/Contraseña|PIN/);
  });
});
