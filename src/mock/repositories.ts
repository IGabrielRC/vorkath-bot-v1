import type { ServiceAccount } from './accounts';
import { groupRowsIntoAccounts } from './accounts';
import type { CredentialBundle } from './credentials';
import { buildCredentialBundles } from './credentials';
import type { Customer } from './customers';
import { groupRowsIntoCustomers } from './customers';
import type { MockAccount, MockService } from './excelLoader';
import type { MockStore } from './mockStore';

/**
 * Repository seam for the MOCK plane.
 *
 * `MockRepositories` is the interface every consumer (webhook, tools)
 * programs against; `MockAccountRepositories` is the MOCK implementation
 * backed by `MockStore`. A future `PostgresRepositories` can satisfy the
 * same interface without touching consumers — tools consume repos,
 * never spreadsheet columns.
 *
 * Every read returns `SafeAccount`: NOMBRE/PERFIL/SERVICIO/PAIS/ESTATUS
 * only. CORREO/CONTRASEÑA never leave the store through this seam, so
 * chat replies and logs stay secret-free by construction.
 */

export interface SafeAccount {
  nombre: string;
  perfil: string;
  servicio: MockService;
  pais: string;
  estatus: string;
}

export interface InventorySummary {
  servicio: string;
  total: number;
}

export interface MockRepositories {
  searchAccounts(query: string): Promise<SafeAccount[]>;
  /**
   * Read-only phone search: phone-identity row matching
   * (`MockStore.searchByPhone`) grouped into customers HERE (domain
   * layer — CLIENTE ≠ TELÉFONO). Safe by construction: customers carry
   * no CORREO/CONTRASEÑA/PIN.
   */
  searchCustomersByPhone(query: string): Promise<Customer[]>;
  searchServiceAccounts(identifier: string): Promise<ServiceAccount[]>;
  /**
   * Explicit-credential path (Slice A — SHOW_CREDENTIALS ONLY): ONE
   * customer's assignments as CredentialBundles, built in the domain
   * layer from raw rows. `customerId` is the MOCK-stable normalized
   * name. Raw `contrasena` values never leave through any other seam —
   * normal search stays secret-free by construction.
   */
  getCredentialBundlesForCustomer(customerId: string): Promise<CredentialBundle[]>;
  /**
   * Explicit-credential path (Slice A — SHOW_CREDENTIALS ONLY): ONE
   * account's assignments as CredentialBundles. `accountId` is the
   * MOCK-stable `${servicio}:${normalized identifier}`.
   */
  getCredentialBundlesForAccount(accountId: string): Promise<CredentialBundle[]>;
  getExpiredAccounts(): Promise<SafeAccount[]>;
  getInventorySummary(): Promise<InventorySummary[]>;
}

/** Strips CORREO/CONTRASEÑA — the only sanctioned path to chat/log output. */
export function toSafeAccount(account: MockAccount): SafeAccount {
  return {
    nombre: account.nombre,
    perfil: account.perfil,
    servicio: account.servicio,
    pais: account.pais,
    estatus: account.estatus,
  };
}

export class MockAccountRepositories implements MockRepositories {
  constructor(private readonly store: MockStore) {}

  async searchAccounts(query: string): Promise<SafeAccount[]> {
    return this.store.search(query).map(toSafeAccount);
  }

  async searchCustomersByPhone(query: string): Promise<Customer[]> {
    return groupRowsIntoCustomers(this.store.searchByPhone(query));
  }

  /**
   * Read-only neutral account search: exact-identifier row matching
   * (`MockStore.searchByAccountIdentifier`, both services, no service
   * question) grouped into accounts HERE (domain layer — one account
   * per service+identifier, rows = profiles/slots). Safe by
   * construction: accounts carry derived status + PAIS_CUENTA only,
   * no CORREO-adjacent secrets (no CONTRASEÑA/PIN).
   */
  async searchServiceAccounts(identifier: string): Promise<ServiceAccount[]> {
    return groupRowsIntoAccounts(this.store.searchByAccountIdentifier(identifier));
  }

  async getCredentialBundlesForCustomer(customerId: string): Promise<CredentialBundle[]> {
    const key = customerId.trim().toLowerCase();
    const scoped = this.store.accounts.filter(
      (row) => row.nombre.trim().toLowerCase() === key,
    );
    return buildCredentialBundles(scoped, this.store.accounts);
  }

  async getCredentialBundlesForAccount(accountId: string): Promise<CredentialBundle[]> {
    const scoped = this.store.accounts.filter(
      (row) => `${row.servicio}:${row.correo.trim().toLowerCase()}` === accountId,
    );
    return buildCredentialBundles(scoped, this.store.accounts);
  }

  async getExpiredAccounts(): Promise<SafeAccount[]> {
    return this.store.getExpired().map(toSafeAccount);
  }

  async getInventorySummary(): Promise<InventorySummary[]> {
    return this.store.countByService();
  }
}
