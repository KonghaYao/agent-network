/**
 * Vendor entry for the FenixAgent memory UI.
 *
 * This module is intentionally not imported by the production SPA in this phase.
 * It is reachable only from the build assertion / preview fixture, so the existing
 * `AgentMemoryDialog`, `memory-data.ts` and the old memory components keep running
 * unchanged.
 */

import './css/fenix.css';

export { MemoriesPage } from './MemoriesPage';
export { DataView } from './components/DataView';
export { EntitiesView } from './components/EntitiesView';
export { Constellation } from './components/Constellation';
export { MemoryDetailBody } from './components/MemoryDetailBody';
export { MemoryDetailModal } from './components/MemoryDetailModal';
export { MemoryDetailPanel } from './components/MemoryDetailPanel';
export { MemoryPagination } from './components/MemoryPagination';
export { MemoryViewSwitcher } from './components/MemoryViewSwitcher';
export { MemoryVisualizationShell } from './components/MemoryVisualizationShell';
export { HindsightFailureNotice } from './components/HindsightFailureNotice';
export { Graph2D } from './components/Graph2d';
export { useTheme } from './theme';
export { useTranslation, translate, NS } from './i18n';
export { copyTextToClipboard, copyDialogTextToClipboard } from './clipboard';
export { hindsightApi, configureFenixMemoryApi, FenixApiError } from './api';
export type { FenixMemoryApi, GraphQuery, EntityPage } from './api';
export type { GraphApiData, MemoryDetail, MemoryTableRow, EntityItem } from './types';

/** Marker used by `scripts/verify-memory-fenix-vendor.ts` to prove chunk separation. */
export const FENIX_MEMORY_VENDOR_MARKER = 'fenix-memory-vendor-chunk';
