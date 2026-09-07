/**
 * Sale price + operational-cost policies (Slice A — NewSale domain).
 *
 * Single versioned source for every sale price and cost:
 * - BR-SAL-004: Netflix perfil $4; FlujoTV perfil $5; FlujoTV completa $9.
 * - 07-FINANCIAL-RULES §7: Netflix perfil $2.00; FlujoTV perfil $1.50;
 *   FlujoTV cuenta completa $3.50 (recognized per unit sold).
 *
 * Versioning (BR-SAL-005, FIN §7): the draft snapshots policy id +
 * version + unit value + currency + computed amounts, so a later config
 * change never rewrites history. Duration semantics: 1 unit = 1 month;
 * requested and granted months travel as separate fields
 * (BR-REN-006) and are equal until a promotion decision says otherwise.
 *
 * Explicitly NOT modeled (reported, never assumed):
 * - FlujoTV 6→7 / 12→14 promotion (BR-FLW-006 — PENDING DECISION).
 * - Daily proration / rounding (BR-REN-010 — PENDING DECISION).
 * - Netflix completa price/cost (BR-NFX-007 — PENDING DECISION;
 *   Slice A sells Netflix perfil ONLY).
 */

export type SaleModality = 'netflix-profile' | 'flujotv-shared' | 'flujotv-complete';

export type SaleCurrency = 'USD';

export const PRICE_POLICY_ID = 'sale-price-policy';
export const PRICE_POLICY_VERSION = 'v1';
export const COST_POLICY_ID = 'operational-cost-policy';
export const COST_POLICY_VERSION = 'v1';

export interface PriceTable {
  policyId: string;
  policyVersion: string;
  unitPrice: Record<SaleModality, number>;
  currency: SaleCurrency;
}

export interface CostTable {
  policyId: string;
  policyVersion: string;
  unitCost: Record<SaleModality, number>;
  currency: SaleCurrency;
}

/** Approved v1 price table (BR-SAL-004). amounts in USD. */
export const PRICE_TABLE_V1: PriceTable = {
  policyId: PRICE_POLICY_ID,
  policyVersion: PRICE_POLICY_VERSION,
  unitPrice: {
    'netflix-profile': 4,
    'flujotv-shared': 5,
    'flujotv-complete': 9,
  },
  currency: 'USD',
};

/** Approved v1 operational-cost table (FIN §7). amounts in USD. */
export const COST_TABLE_V1: CostTable = {
  policyId: COST_POLICY_ID,
  policyVersion: COST_POLICY_VERSION,
  unitCost: {
    'netflix-profile': 2,
    'flujotv-shared': 1.5,
    'flujotv-complete': 3.5,
  },
  currency: 'USD',
};

export interface PriceSnapshot {
  policyId: string;
  policyVersion: string;
  modality: SaleModality;
  unitPrice: number;
  currency: SaleCurrency;
  /** Granted months the suggestion covers (1 unit = 1 month). */
  months: number;
  suggestedAmount: number;
}

export interface CostSnapshot {
  policyId: string;
  policyVersion: string;
  modality: SaleModality;
  unitCost: number;
  currency: SaleCurrency;
  /** Granted months the recognition covers (1 unit = 1 month). */
  months: number;
  recognizedCost: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Historical price snapshot for a modality × granted months. Pure data —
 * the caller copies it into the draft; later policy changes cannot reach
 * it (BR-SAL-005). `tables` override exists ONLY to simulate a future
 * config change in tests; production always passes the vigente tables.
 */
export function priceSnapshotFor(
  modality: SaleModality,
  monthsGranted: number,
  tables: { price?: PriceTable } = {},
): PriceSnapshot {
  const table = tables.price ?? PRICE_TABLE_V1;
  const unitPrice = table.unitPrice[modality];
  return {
    policyId: table.policyId,
    policyVersion: table.policyVersion,
    modality,
    unitPrice,
    currency: table.currency,
    months: monthsGranted,
    suggestedAmount: round2(unitPrice * monthsGranted),
  };
}

/**
 * Historical cost snapshot (`costo_reconocido = unidades × costo_unitario`
 * — FIN §7). Same history-immunity contract as the price snapshot.
 */
export function costSnapshotFor(
  modality: SaleModality,
  monthsGranted: number,
  tables: { cost?: CostTable } = {},
): CostSnapshot {
  const table = tables.cost ?? COST_TABLE_V1;
  const unitCost = table.unitCost[modality];
  return {
    policyId: table.policyId,
    policyVersion: table.policyVersion,
    modality,
    unitCost,
    currency: table.currency,
    months: monthsGranted,
    recognizedCost: round2(unitCost * monthsGranted),
  };
}

/**
 * Pending financial decisions that Slice A reports instead of assuming
 * (docs 04 §20 + 07 §19). Returned for summaries/audits; never branched
 * on for calculations.
 */
export function pendingPriceDecisions(): string[] {
  return [
    'BR-FLW-006: 6→7 / 12→14 FlujoTV promotion unconfirmed — granted equals requested (1 unit = 1 month).',
    'BR-REN-010: daily proration/rounding unconfirmed — months only, no day fractions.',
    'BR-NFX-007: Netflix completa price/cost unconfirmed — not sold in Slice A.',
  ];
}
