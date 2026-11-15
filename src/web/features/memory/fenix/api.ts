/**
 * Local adapter boundary for the vendored FenixAgent memory UI.
 *
 * Upstream `api/hindsight.ts` talks to Fenix's own `/web/hindsight` HTTP routes.
 * Agent Network must not add those routes in the vendor phase, so this module keeps
 * the exact call shape used by the ported components while delegating to an injected
 * adapter.
 *
 * The adapter is provided through React context rather than a module-level mutable
 * singleton: switching the target actor/token creates a new provider value, and an
 * unmounting dialog cannot clear the adapter used by a newer dialog (the previous
 * render-time `configureFenixMemoryApi` + cleanup had exactly that race).
 *
 * Not ported from upstream: no network client, no credentials, no fetch.
 */

import { createContext, useContext } from 'react';

import type {
  BankStats,
  EntityGraphResponse,
  EntityItem,
  GraphApiData,
  HindsightStatus,
  MemoryDetail,
} from './types';

export class FenixApiError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'FenixApiError';
    this.code = code;
  }
}

export interface GraphQuery {
  type: string;
  q?: string;
  tags?: string[];
  document_id?: string;
  chunk_id?: string;
}

export interface EntityPage {
  items: EntityItem[];
  total: number;
}

export interface FenixMemoryApi {
  getStatus(): Promise<HindsightStatus>;
  getGraph(params: GraphQuery): Promise<GraphApiData>;
  getBankStats(): Promise<BankStats>;
  getMemory(id: string): Promise<MemoryDetail>;
  listEntities(params?: { limit?: number; offset?: number }): Promise<EntityPage>;
  getEntity(id: string): Promise<EntityItem>;
  getEntityGraph(params?: { limit?: number; min_count?: number }): Promise<EntityGraphResponse>;
}

/**
 * Injected by `AgentMemoryDialog` (production) and the vendor render fixture.
 *
 * The context value must be stable for the lifetime of one dialog instance; callers
 * create it with `useMemo` from the target actor and token.
 */
export const FenixMemoryApiContext = createContext<FenixMemoryApi | null>(null);

/**
 * Read the currently provided adapter.
 *
 * Throwing instead of falling back to a rejecting stub keeps a missing provider a
 * visible integration error rather than a silent "记忆加载失败" in the UI.
 */
export function useFenixMemoryApi(): FenixMemoryApi {
  const api = useContext(FenixMemoryApiContext);
  if (!api) {
    throw new Error('FenixMemoryApiContext is missing; wrap the memory UI in a provider.');
  }
  return api;
}
