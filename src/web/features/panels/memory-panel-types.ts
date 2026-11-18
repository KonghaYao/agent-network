import type { WebIdentity } from '../../lib/identity';
import type { MemoryRecord } from './memory-format';

export type TabName = 'recall' | 'context' | 'experience' | 'host' | 'governance';

export interface MemoryCatalog {
  enabled?: boolean;
  capture?: boolean;
  host_modes?: string[];
  recall_modes?: string[];
  supported?: string[];
  unsupported?: string[];
  reason?: string | null;
}

export interface MemoryMe extends WebIdentity {
  service?: { memory?: MemoryCatalog };
}

export interface MemoryStatus {
  enabled?: boolean;
  capture?: boolean;
  host_level?: string;
  counts?: Record<string, number>;
  unsupported?: string[];
  supported_host_modes?: string[];
}

export interface RecallResult {
  status?: string;
  coverage?: string;
  evidence_complete?: boolean;
  context_ref?: string | null;
  budget_used?: { candidates?: number; packaged_bytes?: number; truncated?: boolean };
  items?: MemoryRecord[];
  freshness?: { as_of?: string };
}

export interface ContextPage {
  items?: MemoryRecord[];
  next_cursor?: string | null;
  has_more?: boolean;
}

export interface ContextDetail {
  available?: boolean;
  reason?: string | null;
  context_id?: string;
  kind?: string;
  body?: string;
  items?: MemoryRecord[];
  validity?: string;
  injection?: { eligible?: boolean; reason?: string };
}

export interface ExperiencePage extends ContextPage {}

export interface ExperienceDetail {
  available?: boolean;
  reason?: string | null;
  experience_id?: string;
  item?: MemoryRecord;
  text?: string;
}

export interface ManifestResult {
  manifest_id?: string;
  status?: string;
  submitted_evidence?: string | null;
  retain_eligible?: boolean;
  retain_ids?: string[];
  receipt_disposition?: string | null;
  manifest_sha256?: string;
  payload_sha256?: string;
  created_at?: number;
}

export interface MemoryListPage {
  items?: MemoryRecord[];
  next_cursor?: string | null;
  has_more?: boolean;
}
