/**
 * Vendor entry for the FenixAgent memory UI.
 *
 * Production reaches this tree only through the lazy `AgentMemoryDialog` ->
 * `MemoriesPage` chain. This module is also built in isolation by the vendor guard
 * to prove chunk separation and to render the detail fixture. It intentionally
 * exports only what those entry points need: DataView/EntitiesView stay behind
 * `MemoriesPage`'s lazy imports instead of being re-exported statically.
 */

import './css/fenix.css';

export { MemoriesPage } from './MemoriesPage';
export { MemoryDetailPanel } from './components/MemoryDetailPanel';
export { FenixMemoryApiContext, useFenixMemoryApi, FenixApiError } from './api';
export type { FenixMemoryApi, GraphQuery, EntityPage } from './api';
export type { GraphApiData, MemoryDetail, MemoryTableRow, EntityItem } from './types';

/** Marker used by `scripts/verify-memory-fenix-vendor.ts` to prove chunk separation. */
export const FENIX_MEMORY_VENDOR_MARKER = 'fenix-memory-vendor-chunk';
