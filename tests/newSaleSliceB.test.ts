/**
 * Slice B — atomic MOCK sale confirm + single-card UX + post-sale
 * datos/WhatsApp (MOCK cases A–P, tests 47–63 + race/recalc/receiver/
 * amounts/new-customer/emergency/no-inventory).
 *
 * REAL fixture values throughout: Anny Tovar 4145460657, fixture free
 * `1 PERFIL (4)` rows on hfghfgbghfghg@hotmail.com, fixture password
 * `juan8727` (asserted absent pre-confirm / absent from audit+alerts,
 * present ONLY inside the post-confirm delivery card). Synthetic rows
 * mirror fixture shapes ONLY where the fixture has no coverage (free
 * FlujoTV slots, free profile-5, single-free-slot races). Pinned clock
 * 2026-09-07 → starts_on 2026-09-07, 2-month expiry 2026-11-07
 * (`7 de noviembre de 2026`, no legacy DIAS, no invented promos).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { groupRowsIntoCustomers, type Customer } from '../src/mock/customers';
import type { MockAccount } from '../src/mock/excelLoader';
import { MockStore } from '../src/mock/mockStore';
import { MockAccountRepositories } from '../src/mock/repositories';
import { PRICE_TABLE_V1 } from '../src/sale/pricePolicy';
import { NewSaleDraftStore } from '../src/sale/newSaleDraft';
import {
  confirmNewSale,
  type ConfirmOutcome,
  type SaleClock,
} from '../src/sale/newSaleConfirm';
import {
  prepareNewSaleFromAction,
  prepareNewSaleFromText,
  renderSaleDraftSummary,
  type SaleActor,
  type SaleDeps,
} from '../src/sale/newSaleTool';

const GABRIEL: SaleActor = { chatId: -1005550001, userId: 1057242322, name: 'Gabriel' };
const EDWARD: SaleActor = { chatId: -1005550001, userId: 941030473, name: 'Edward' };

const FIXTURE_PATH = resolve(process.cwd(), 'fixtures/BASE PRUEBA_v2.xlsx');
const PINNED_NOW = new Date('2026-09-07T12:00:00.000Z');
const clock: SaleClock = { now: () => new Date(PINNED_NOW) };

const FULL_COMBO =
  'vende un perfil de netflix para 4145460657 por 2 meses, pagó 8 USD por zelle, lo recibió Edward';

async function fixtureWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'vokath-saleb-'));
  const store = await MockStore.create({
    fixturePath: FIXTURE_PATH,
    statePath: join(dir, 'mock-state.json'),
  });
  const repos = new MockAccountRepositories(store);
  return { store, repos, rows: store.accounts };
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

function stubCustomer(id: string, nombre: string, phone: string): Customer {
  return { id, nombre, phones: [phone], subscriptions: [] };
}

function depsFor(
  store: NewSaleDraftStore,
  mockStore: MockStore,
  lookup: (phone: string) => Customer[],
  extra: Partial<SaleDeps> = {},
): SaleDeps {
  return {
    store,
    findCustomersByPhone: lookup,
    inventoryRows: mockStore.accounts,
    saleExec: { mockStore, clock },
    ...extra,
  };
}

/** Fresh world whose live rows are the given synthetic set (same ref as the ledger seam). */
async function syntheticWorld(rows: MockAccount[]) {
  const world = await fixtureWorld();
  world.store.accounts.length = 0;
  world.store.accounts.push(...rows);
  return world;
}

function ledgerLengths(store: MockStore) {
  return [
    store.saleOperations.length,
    store.saleItems.length,
    store.saleSubscriptions.length,
    store.salePayments.length,
    store.saleMovements.length,
    store.saleAudits.length,
  ];
}

// ---------------------------------------------------------------------------
// Atomicity 47–56
// ---------------------------------------------------------------------------

describe('sale atomicity (47–56)', () => {
  it('(47) confirm creates sale+subscription+slot+payment+movement+audit with snapshots', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    const prepared = await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    expect(prepared.kind).toBe('summary');
    const operationId = prepared.draft?.operationId ?? '';
    const evidenceRow = prepared.draft?.proposal?.evidence.rowIndex ?? -1;
    const prevRow = { ...(store.accounts[evidenceRow] as MockAccount) };

    const confirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(confirmed.kind).toBe('confirmed');

    expect(store.saleOperations).toHaveLength(1);
    const op = store.saleOperations[0];
    expect(op).toMatchObject({
      operationId,
      idempotencyKey: operationId,
      type: 'NEW_SALE',
      status: 'CONFIRMED',
      operator: 'Gabriel',
      customerName: 'Anny Tovar',
      phone: '4145460657',
      service: 'netflix',
      modality: 'netflix-profile',
      monthsRequested: 2,
      monthsGranted: 2,
      startsOn: '2026-09-07',
      expiresOn: '2026-11-07',
      serviceAccountId: 'netflix:hfghfgbghfghg@hotmail.com',
    });
    expect(op?.price).toMatchObject({
      policyId: 'sale-price-policy',
      policyVersion: 'v1',
      unitPrice: 4,
      suggestedAmount: 8,
    });
    expect(op?.cost).toMatchObject({
      policyId: 'operational-cost-policy',
      policyVersion: 'v1',
      unitCost: 2,
      recognizedCost: 4,
    });
    expect(op?.payment).toMatchObject({
      actualAmount: 8,
      currency: 'USD',
      method: 'zelle',
      receivedBy: 'Edward',
    });

    expect(store.saleSubscriptions).toHaveLength(1);
    expect(store.saleSubscriptions[0]).toMatchObject({
      id: `sub-${operationId}`,
      operationId,
      startsOn: '2026-09-07',
      expiresOn: '2026-11-07',
      months: 2,
    });
    expect(store.saleItems).toHaveLength(1);
    expect(store.saleItems[0]).toMatchObject({
      operationId,
      subscriptionId: `sub-${operationId}`,
    });
    expect(store.salePayments).toHaveLength(1);
    expect(store.salePayments[0]).toMatchObject({
      id: `pay-${operationId}`,
      amount: 8,
      currency: 'USD',
      method: 'zelle',
      receivedBy: 'Edward',
    });
    expect(store.saleMovements).toHaveLength(1);
    expect(store.saleMovements[0]).toMatchObject({
      id: `mov-${operationId}`,
      direction: 'IN',
      amount: 8,
      currency: 'USD',
      holder: 'Edward',
    });
    expect(store.saleAudits).toHaveLength(1);
    expect(store.saleAudits[0]).toMatchObject({ operationId, type: 'sale.confirmed' });

    const row = store.accounts[op?.rowIndex ?? -1] as MockAccount;
    expect(row.nombre).toBe('Anny Tovar');
    expect(row.numero).toBe('4145460657');
    expect(row.fechaInicio).toBe('2026-09-07');
    expect(row.fechaFin).toBe('2026-11-07');
    // Legacy columns never govern: untouched by the assignment.
    expect(row.estatus).toBe(prevRow.estatus);
    expect(row.dias).toBe(prevRow.dias);
    expect(row.contrasena).toBe(prevRow.contrasena);
    expect(row.correo).toBe(prevRow.correo);
    expect(row.perfil).toBe(prevRow.perfil);
    expect(saleStore.confirmed({ chatId: GABRIEL.chatId, userId: GABRIEL.userId })?.status).toBe(
      'CONFIRMED',
    );
  });

  it.each(['assignment', 'subscription', 'payment', 'movement', 'audit'] as const)(
    '(48–52) injected failure at %s rolls back everything (zero partials + safe alert)',
    async (failAt) => {
      const { store, repos } = await fixtureWorld();
      const saleStore = new NewSaleDraftStore();
      const alerts: Array<{ title: string; summary: string }> = [];
      const deps = depsFor(saleStore, store, (raw) => repos.searchCustomersByPhone(raw), {
        saleExec: { mockStore: store, clock, failAt, onAlert: (alert) => alerts.push(alert) },
      });
      const prepared = await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
      expect(prepared.kind).toBe('summary');
      const evidenceRow = prepared.draft?.proposal?.evidence.rowIndex ?? -1;
      const prevRow = { ...(store.accounts[evidenceRow] as MockAccount) };

      const result = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
      expect(result.kind).toBe('clarification');
      expect(result.text).toContain('no pudo registrarse');
      expect(ledgerLengths(store)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(store.accounts[evidenceRow]).toEqual(prevRow);
      expect(saleStore.get({ chatId: GABRIEL.chatId, userId: GABRIEL.userId })?.status).toBe('DRAFT');
      expect(alerts).toHaveLength(1);
      const serialized = JSON.stringify(alerts[0]);
      expect(serialized).not.toContain('juan8727');
      expect(serialized).not.toMatch(/contrasena|password|Contraseña|PIN/);
    },
  );

  it('(53) slot taken between summary and confirm → recalc, zero partials, then confirms', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    const prepared = await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    expect(prepared.kind).toBe('summary');
    const firstSlot = prepared.draft?.proposal?.slotId ?? '';
    // A peer grabs the evidenced slot before Gabriel confirms.
    const rowIndex = prepared.draft?.proposal?.evidence.rowIndex ?? -1;
    store.assignSaleSlot(rowIndex, {
      nombre: 'Intruso',
      numero: '7000000',
      fechaInicio: '2026-01-01',
      fechaFin: '2026-02-01',
    });

    const recalc = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(recalc.kind).toBe('summary');
    expect(recalc.text).toContain('inventario cambió');
    expect(recalc.draft?.proposal?.slotId).not.toBe(firstSlot);
    // Recalc creates NO sale rows (the intruder row is external, not ours).
    expect(store.saleOperations).toHaveLength(0);

    const confirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(confirmed.kind).toBe('confirmed');
    expect(store.saleOperations).toHaveLength(1);
    expect(store.saleOperations[0]?.slotId).toBe(recalc.draft?.proposal?.slotId);
  });

  it('(54) double Confirm executes once (second answers already confirmed)', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    const first = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    const second = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(first.kind).toBe('confirmed');
    expect(second.kind).toBe('already-confirmed');
    expect(second.text).toContain('ya registrada');
    expect(ledgerLengths(store)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('(55) repeat confirm callbacks stay idempotent (exactly 1 of everything)', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    for (let i = 0; i < 3; i += 1) {
      await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    }
    expect(store.saleOperations).toHaveLength(1);
    expect(store.saleSubscriptions).toHaveLength(1);
    expect(store.salePayments).toHaveLength(1);
    expect(store.saleMovements).toHaveLength(1);
    expect(store.saleAudits).toHaveLength(1);
    const assigned = store.accounts.filter((row) => row.nombre === 'Anny Tovar');
    expect(assigned.filter((row) => row.fechaInicio === '2026-09-07')).toHaveLength(1);
  });

  it('(56) stale version refuses with version-conflict and zero rows', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    const prepared = await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    expect(prepared.kind).toBe('summary');
    const summaryFor = (draft: NonNullable<typeof prepared.draft>): string =>
      renderSaleDraftSummary(draft, store.accounts);
    const outcome: ConfirmOutcome = confirmNewSale(
      { chatId: GABRIEL.chatId, userId: GABRIEL.userId, name: GABRIEL.name },
      { drafts: saleStore, store, clock },
      summaryFor,
      { expectedVersion: (prepared.draft?.version ?? 0) + 99 },
    );
    expect(outcome.kind).toBe('version-conflict');
    expect(ledgerLengths(store)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('(56b) price-policy change recalculates the draft instead of executing stale', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, (raw) => repos.searchCustomersByPhone(raw), {
      saleExec: {
        mockStore: store,
        clock,
        priceTable: {
          ...PRICE_TABLE_V1,
          policyVersion: 'v2',
          unitPrice: { ...PRICE_TABLE_V1.unitPrice, 'netflix-profile': 6 },
        },
      },
    });
    await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    const recalc = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(recalc.kind).toBe('summary');
    expect(recalc.text).toContain('política de precios cambió');
    expect(recalc.draft?.price?.policyVersion).toBe('v2');
    expect(recalc.draft?.price?.suggestedAmount).toBe(12);
    expect(store.saleOperations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// WhatsApp 57–63 (post-confirm datos only, Fase 3 templates EXACTLY)
// ---------------------------------------------------------------------------

describe('sale whatsapp (57–63)', () => {
  it('(57) Netflix confirm delivers PIN + long expiry + wa.me (Fase 3 template)', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    const confirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(confirmed.kind).toBe('confirmed');
    expect(confirmed.text).toContain('✅ VENTA CONFIRMADA');
    expect(confirmed.text).toContain('🔐 DATOS DE ACCESO');
    expect(confirmed.text).toContain('Contraseña');
    expect(confirmed.text).toContain('PIN: 0657');
    expect(confirmed.text).toContain('7 de noviembre de 2026');
    expect(confirmed.text).toContain('💬 WhatsApp preparado.');
    expect(confirmed.whatsappUrl).toMatch(/^https:\/\/wa\.me\/584145460657\?text=/);
    // The wa.me payload reuses the Fase 3 Netflix template EXACTLY.
    const delivered = decodeURIComponent((confirmed.whatsappUrl ?? '').split('text=')[1] ?? '');
    expect(delivered).toContain('¡Hola, Anny Tovar!');
    expect(delivered).toContain('🔑 Contraseña: juan8727');
    expect(delivered).toContain('🔒 PIN: 0657');
    expect(delivered).toContain('7 de noviembre de 2026');
  });

  it('(58) FlujoTV shared uses its own template (Usuario + Perfil, never PIN)', async () => {
    const { store } = await syntheticWorld([
      saleRow({ servicio: 'flujotv', correo: 'cmaxnet099', perfil: '1 PERFIL', nombre: 'Ocupa A', numero: '4145460657' }),
      saleRow({ servicio: 'flujotv', correo: 'cmaxnet099', perfil: '1 PERFIL', nombre: '', numero: '' }),
    ]);
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, () => [
      stubCustomer('anny tovar', 'Anny Tovar', '4145460657'),
    ]);
    const prepared = await prepareNewSaleFromText(
      GABRIEL,
      'vende flujotv compartida para 4145460657 por 1 mes, pagó 5 USD por zelle, lo recibió Gabriel',
      deps,
    );
    expect(prepared.kind).toBe('summary');
    const confirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(confirmed.kind).toBe('confirmed');
    expect(confirmed.text).toContain('Usuario:');
    expect(confirmed.text).toContain('Perfil:');
    expect(confirmed.text).not.toContain('PIN:');
    expect(confirmed.text).toContain('💬 WhatsApp preparado.');
    expect(confirmed.whatsappUrl).toMatch(/^https:\/\/wa\.me\/584145460657\?text=/);
    expect(store.saleOperations[0]).toMatchObject({
      modality: 'flujotv-shared',
      monthsGranted: 1,
    });
    expect(store.saleOperations[0]?.price.suggestedAmount).toBe(5);
    expect(store.saleOperations[0]?.cost.recognizedCost).toBe(1.5);
  });

  it('(59) FlujoTV complete uses the exclusive template', async () => {
    const { store } = await syntheticWorld([
      saleRow({ servicio: 'flujotv', correo: 'maxnet099', perfil: 'CUENTA COMPLETA', nombre: '', numero: '' }),
    ]);
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, () => [
      stubCustomer('anny tovar', 'Anny Tovar', '4145460657'),
    ]);
    const prepared = await prepareNewSaleFromText(
      GABRIEL,
      'vende flujotv completa para 4145460657 por 1 mes, zelle 9 usd, lo recibió Gabriel',
      deps,
    );
    expect(prepared.kind).toBe('summary');
    const confirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(confirmed.kind).toBe('confirmed');
    expect(confirmed.text).toContain('Completa / Exclusiva');
    expect(confirmed.text).toContain('Usuario:');
    expect(confirmed.whatsappUrl).toMatch(/^https:\/\/wa\.me\/584145460657\?text=/);
    const delivered = decodeURIComponent((confirmed.whatsappUrl ?? '').split('text=')[1] ?? '');
    expect(delivered).toContain('cuenta completa');
    expect(store.saleOperations[0]?.price.suggestedAmount).toBe(9);
    expect(store.saleOperations[0]?.cost.recognizedCost).toBe(3.5);
  });

  it('(60) no pre-confirm creds: summary has no password/PIN/wa.me, no URL attached', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    const prepared = await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    expect(prepared.kind).toBe('summary');
    expect(prepared.whatsappUrl).toBeUndefined();
    expect(prepared.text).not.toContain('wa.me');
    expect(prepared.text).not.toContain('Contraseña');
    expect(prepared.text).not.toMatch(/PIN/);
    expect(prepared.text).not.toContain('juan8727');
    expect(JSON.stringify(prepared.draft)).not.toContain('juan8727');
  });

  it('(61) audit + alerts carry safe refs only (no secrets anywhere)', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    const auditPayload = JSON.stringify(store.saleAudits);
    expect(auditPayload).not.toContain('juan8727');
    expect(auditPayload).not.toMatch(/contrasena|password|Contraseña|PIN/);
    expect(store.saleAudits[0]?.refs).toMatchObject({
      serviceAccountId: 'netflix:hfghfgbghfghg@hotmail.com',
      modality: 'netflix-profile',
      months: 2,
      amount: 8,
      receivedBy: 'Edward',
    });
  });

  it('(62) WhatsApp targets the customer phone, never the receiver', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    const confirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    // Edward received the money; the delivery still goes to Anny.
    expect(store.salePayments[0]?.receivedBy).toBe('Edward');
    expect(confirmed.whatsappUrl).toMatch(/^https:\/\/wa\.me\/584145460657\?text=/);
  });

  it('(63) manual-send semantics: preparado, never sent', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    await prepareNewSaleFromText(GABRIEL, FULL_COMBO, deps);
    const confirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(confirmed.text).toContain('preparado');
    expect(confirmed.text).not.toMatch(/enviado|sent/i);
  });
});

// ---------------------------------------------------------------------------
// Concurrency, recalc, receiver, amounts, new-customer, emergency, no-stock
// ---------------------------------------------------------------------------

describe('sale contention + flows', () => {
  it('race: Gabriel+Edward on the same slot → one wins, other recalculates (never double-assign)', async () => {
    const { store } = await syntheticWorld([
      saleRow({ servicio: 'netflix', correo: 'race@test.com', perfil: '1 PERFIL (1)', nombre: 'Ocupa', numero: '7000000' }),
      saleRow({ servicio: 'netflix', correo: 'race@test.com', perfil: '1 PERFIL (2)', nombre: '', numero: '' }),
      saleRow({ servicio: 'netflix', correo: 'race@test.com', perfil: '1 PERFIL (3)', nombre: '', numero: '' }),
    ]);
    const lookup = (raw: string): Customer[] => {
      if (raw.includes('7111111')) {
        return [stubCustomer('g-buyer', 'G Buyer', '7111111')];
      }
      return [stubCustomer('e-buyer', 'E Buyer', '7222222')];
    };
    const gabrielStore = new NewSaleDraftStore();
    const edwardStore = new NewSaleDraftStore();
    const gabrielDeps = depsFor(gabrielStore, store, lookup);
    const edwardDeps = depsFor(edwardStore, store, lookup);
    const gPrepared = await prepareNewSaleFromText(
      GABRIEL,
      'vende netflix para 7111111 por 1 mes, zelle 4 usd, lo recibió Gabriel',
      gabrielDeps,
    );
    const ePrepared = await prepareNewSaleFromText(
      EDWARD,
      'vende netflix para 7222222 por 1 mes, zelle 4 usd, lo recibió Edward',
      edwardDeps,
    );
    expect(gPrepared.kind).toBe('summary');
    expect(ePrepared.kind).toBe('summary');
    // Both proposals evidence the SAME first free slot.
    expect(ePrepared.draft?.proposal?.slotId).toBe(gPrepared.draft?.proposal?.slotId);

    const gConfirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, gabrielDeps);
    expect(gConfirmed.kind).toBe('confirmed');
    const eRecalc = await prepareNewSaleFromAction(EDWARD, { type: 'confirm-sale' }, edwardDeps);
    expect(eRecalc.kind).toBe('summary');
    expect(eRecalc.text).toContain('inventario cambió');
    const eConfirmed = await prepareNewSaleFromAction(EDWARD, { type: 'confirm-sale' }, edwardDeps);
    expect(eConfirmed.kind).toBe('confirmed');

    expect(store.saleOperations).toHaveLength(2);
    const slots = store.saleOperations.map((op) => op.slotId).sort();
    expect(new Set(slots).size).toBe(2);
    // Both buyers hold distinct assigned rows (names fall back to the
    // stated phone when synthetic rows carry no fixture customer).
    const winners = store.accounts.filter((row) => row.fechaInicio === '2026-09-07');
    expect(winners).toHaveLength(2);
    expect(winners.map((row) => row.nombre).sort()).toEqual(['7111111', '7222222']);
  });

  it('race with a single free slot → loser lands on Sin inventario (fail-closed)', async () => {
    const { store } = await syntheticWorld([
      saleRow({ servicio: 'netflix', correo: 'race@test.com', perfil: '1 PERFIL (1)', nombre: 'Ocupa', numero: '7000000' }),
      saleRow({ servicio: 'netflix', correo: 'race@test.com', perfil: '1 PERFIL (2)', nombre: '', numero: '' }),
    ]);
    const lookup = (raw: string): Customer[] => {
      if (raw.includes('7111111')) {
        return [stubCustomer('g-buyer', 'G Buyer', '7111111')];
      }
      return [stubCustomer('e-buyer', 'E Buyer', '7222222')];
    };
    const gabrielStore = new NewSaleDraftStore();
    const edwardStore = new NewSaleDraftStore();
    const gabrielDeps = depsFor(gabrielStore, store, lookup);
    const edwardDeps = depsFor(edwardStore, store, lookup);
    await prepareNewSaleFromText(
      GABRIEL,
      'vende netflix para 7111111 por 1 mes, zelle 4 usd, lo recibió Gabriel',
      gabrielDeps,
    );
    await prepareNewSaleFromText(
      EDWARD,
      'vende netflix para 7222222 por 1 mes, zelle 4 usd, lo recibió Edward',
      edwardDeps,
    );
    expect(await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, gabrielDeps)).toMatchObject({
      kind: 'confirmed',
    });
    const loser = await prepareNewSaleFromAction(EDWARD, { type: 'confirm-sale' }, edwardDeps);
    expect(loser.kind).toBe('no-inventory');
    expect(loser.text).toContain('No hay inventario disponible.');
    expect(store.saleOperations).toHaveLength(1);
  });

  it('receiver≠operator: Gabriel operates, Edward receives (payment + movement)', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    const prepared = await prepareNewSaleFromText(
      EDWARD,
      'vende netflix para 4145460657 por 1 mes, zelle 4 usd, lo recibió Gabriel',
      deps,
    );
    expect(prepared.kind).toBe('summary');
    expect(prepared.draft?.operator).toBe('Edward');
    expect(prepared.draft?.payment.receivedBy).toBe('Gabriel');
    const confirmed = await prepareNewSaleFromAction(EDWARD, { type: 'confirm-sale' }, deps);
    expect(confirmed.kind).toBe('confirmed');
    expect(store.saleOperations[0]).toMatchObject({ operator: 'Edward' });
    expect(store.saleOperations[0]?.payment.receivedBy).toBe('Gabriel');
    expect(store.salePayments[0]?.receivedBy).toBe('Gabriel');
    expect(store.saleMovements[0]?.holder).toBe('Gabriel');
  });

  it('actual≠suggested stay visible (payment records the real amount)', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    const prepared = await prepareNewSaleFromText(
      GABRIEL,
      'vende un perfil de netflix para 4145460657 por 2 meses, pagó 10 USD por zelle, lo recibió Edward',
      deps,
    );
    expect(prepared.kind).toBe('summary');
    expect(prepared.draft?.price?.suggestedAmount).toBe(8);
    expect(prepared.draft?.payment.actualAmount).toBe(10);
    expect(prepared.text).toContain('Sugerido');
    expect(prepared.text).toContain('Recibido');
    const confirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(confirmed.kind).toBe('confirmed');
    expect(store.salePayments[0]?.amount).toBe(10);
    expect(store.saleMovements[0]?.amount).toBe(10);
  });

  it('new customer (B): create-on-confirm-only, then WhatsApp to the new number', async () => {
    const { store, repos } = await fixtureWorld();
    const before = store.accounts.length;
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    const started = await prepareNewSaleFromText(
      GABRIEL,
      'vende perfil netflix para 04149990001 por 1 mes, zelle 4 usd, lo recibió Gabriel',
      deps,
    );
    expect(started.kind).toBe('new-customer');
    expect(await repos.searchCustomersByPhone('04149990001')).toEqual([]);
    const named = await prepareNewSaleFromAction(
      GABRIEL,
      { type: 'provide-name', name: 'Cliente Nuevo' },
      deps,
    );
    expect(named.kind).toBe('summary');
    expect(named.text).toContain('(nuevo)');
    expect(store.accounts.length).toBe(before);
    const confirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(confirmed.kind).toBe('confirmed');
    expect(store.saleOperations[0]).toMatchObject({
      customerId: 'cliente nuevo',
      customerName: 'Cliente Nuevo',
      phone: '04149990001',
    });
    expect(await repos.searchCustomersByPhone('04149990001')).toHaveLength(1);
    expect(groupRowsIntoCustomers(store.accounts).some((c) => c.nombre === 'Cliente Nuevo')).toBe(true);
    expect(confirmed.whatsappUrl).toMatch(/^https:\/\/wa\.me\/584149990001\?text=/);
  });

  it('emergency: confirm refuses until explicit auth (auth≠sale-confirm), then executes once', async () => {
    const { store } = await syntheticWorld([
      saleRow({ servicio: 'netflix', correo: 'llena@test.com', perfil: '1 PERFIL (1)', nombre: 'Ocupa', numero: '7000000' }),
      saleRow({ servicio: 'netflix', correo: 'emer@test.com', perfil: '1 PERFIL (5)', nombre: '', numero: '' }),
    ]);
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, () => [
      stubCustomer('carlos', 'Carlos Prueba', '999888777'),
    ]);
    const started = await prepareNewSaleFromText(
      GABRIEL,
      'vende netflix para 999888777 por 1 mes, zelle 4 usd, lo recibió Gabriel',
      deps,
    );
    expect(started.kind).toBe('emergency-auth');
    const refused = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(refused.kind).toBe('emergency-auth');
    expect(ledgerLengths(store)).toEqual([0, 0, 0, 0, 0, 0]);
    const authed = await prepareNewSaleFromAction(GABRIEL, { type: 'authorize-emergency' }, deps);
    expect(authed.draft?.proposal?.emergencyAuthorized).toBe(true);
    const confirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(confirmed.kind).toBe('confirmed');
    expect(store.saleOperations).toHaveLength(1);
    expect(store.saleOperations[0]?.serviceAccountId).toBe('netflix:emer@test.com');
  });

  it('no-inventory fails closed: no customer, no waitlist artifacts, nothing persisted', async () => {
    const { store, repos } = await fixtureWorld();
    const accountsBefore = JSON.stringify(store.accounts);
    const customersBefore = groupRowsIntoCustomers(store.accounts).length;
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    const prepared = await prepareNewSaleFromText(
      GABRIEL,
      'vende flujotv completa para 4145460657 por 1 mes, zelle 9 usd, lo recibió Gabriel',
      deps,
    );
    expect(prepared.kind).toBe('no-inventory');
    const result = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(result.kind).toBe('no-inventory');
    expect(result.text).toContain('No hay inventario disponible.');
    expect(ledgerLengths(store)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(JSON.stringify(store.accounts)).toBe(accountsBefore);
    expect(groupRowsIntoCustomers(store.accounts)).toHaveLength(customersBefore);
  });

  it('reference passthrough: optional ref lands on payment + summary', async () => {
    const { store, repos } = await fixtureWorld();
    const saleStore = new NewSaleDraftStore();
    const deps = depsFor(saleStore, store, (raw) => repos.searchCustomersByPhone(raw));
    const prepared = await prepareNewSaleFromText(
      GABRIEL,
      'vende netflix para 4145460657 por 1 mes, zelle 4 usd ref ABC123, lo recibió Gabriel',
      deps,
    );
    expect(prepared.kind).toBe('summary');
    expect(prepared.text).toContain('Referencia');
    const confirmed = await prepareNewSaleFromAction(GABRIEL, { type: 'confirm-sale' }, deps);
    expect(confirmed.kind).toBe('confirmed');
    expect(store.salePayments[0]?.reference).toBe('ABC123');
  });
});
