import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';

import { orm, schema, toD1 } from '../drizzle';
import type { D1Like } from '../queries';
import type {
  MemoryCatchupItemRow,
  MemoryCatchupPlanRow,
  MemoryContextRow,
  MemoryExperienceRow,
  MemoryHostBindingRow,
  MemoryManifestItemRow,
  MemoryManifestRow,
  MemoryRecallRequestRow,
  MemoryReceiptRow,
  MemoryRepresentationDependencyRow,
  MemoryRepresentationRow,
  MemorySelectionRow,
  MemorySourceRow,
  MemorySpaceRow,
} from '../../memory/rows';

type MemoryInstanceLookup = {
  instance_id: string;
  capture_default: 'enabled' | 'disabled';
};
type MemorySourceRecord = MemorySourceRow;
type MemoryRepresentationRecord = MemoryRepresentationRow;
type MemoryExperienceRecord = MemoryExperienceRow;
type MemoryContextRecord = MemoryContextRow;
type MemoryManifestRecord = MemoryManifestRow;
type MemorySelectionRecord = MemorySelectionRow;
type MemoryReceiptRecord = MemoryReceiptRow;
type MemoryHostBindingRecord = MemoryHostBindingRow;
type MemoryCatchupPlanRecord = MemoryCatchupPlanRow;
type MemoryCatchupItemRecord = MemoryCatchupItemRow;
type MemoryRecallRequestRecord = MemoryRecallRequestRow;

export type MemoryTombstoneTargetKind =
  (typeof schema.memoryTombstones.target_kind.enumValues)[number];

/** 部署稳定 instance；`memory_instances` 至多一行。 */
export async function getMemoryInstance(
  db: D1Like,
): Promise<MemoryInstanceLookup | null> {
  const query = orm(db)
    .select({
      instance_id: schema.memoryInstances.instance_id,
      capture_default: schema.memoryInstances.capture_default,
    })
    .from(schema.memoryInstances)
    .limit(1);
  return toD1(db, query).first<MemoryInstanceLookup>();
}

export async function getActiveMemorySpace(
  db: D1Like,
  agentId: string,
): Promise<MemorySpaceRow | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySpaces)
    .where(
      and(
        eq(schema.memorySpaces.agent_actor_id, agentId),
        eq(schema.memorySpaces.active, 1),
      ),
    );
  return toD1(db, query).first<MemorySpaceRow>();
}

export async function memorySpaceExists(db: D1Like, spaceId: string): Promise<boolean> {
  const query = orm(db)
    .select({ space_id: schema.memorySpaces.space_id })
    .from(schema.memorySpaces)
    .where(eq(schema.memorySpaces.space_id, spaceId))
    .limit(1);
  return (await toD1(db, query).first<{ space_id: string }>()) !== null;
}

export async function getMemorySpaceById(
  db: D1Like,
  spaceId: string,
): Promise<MemorySpaceRow | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySpaces)
    .where(eq(schema.memorySpaces.space_id, spaceId));
  return toD1(db, query).first<MemorySpaceRow>();
}

export async function isMemoryTombstonedBySourceKey(
  db: D1Like,
  sourceKey: string,
): Promise<boolean> {
  const query = orm(db)
    .select({ tombstone_id: schema.memoryTombstones.tombstone_id })
    .from(schema.memoryTombstones)
    .where(
      and(
        eq(schema.memoryTombstones.source_key, sourceKey),
        inArray(schema.memoryTombstones.target_kind, ['source_key', 'source']),
      ),
    )
    .limit(1);
  return (await toD1(db, query).first<{ tombstone_id: string }>()) !== null;
}

export async function isMemoryTargetTombstoned(
  db: D1Like,
  kind: MemoryTombstoneTargetKind,
  targetId: string,
): Promise<boolean> {
  const query = orm(db)
    .select({ tombstone_id: schema.memoryTombstones.tombstone_id })
    .from(schema.memoryTombstones)
    .where(
      and(
        eq(schema.memoryTombstones.target_kind, kind),
        eq(schema.memoryTombstones.target_id, targetId),
      ),
    )
    .limit(1);
  return (await toD1(db, query).first<{ tombstone_id: string }>()) !== null;
}

export async function getMemorySourceRevision(
  db: D1Like,
  sourceId: string,
  revision: number,
): Promise<MemorySourceRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySources)
    .where(
      and(
        eq(schema.memorySources.source_id, sourceId),
        eq(schema.memorySources.revision, revision),
      ),
    );
  return toD1(db, query).first<MemorySourceRecord>();
}

export async function getLatestMemorySource(
  db: D1Like,
  sourceId: string,
): Promise<MemorySourceRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySources)
    .where(eq(schema.memorySources.source_id, sourceId))
    .orderBy(desc(schema.memorySources.revision))
    .limit(1);
  return toD1(db, query).first<MemorySourceRecord>();
}

export async function getActiveMemorySourceByKey(
  db: D1Like,
  instanceId: string,
  sourceKey: string,
): Promise<MemorySourceRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySources)
    .where(
      and(
        eq(schema.memorySources.instance_id, instanceId),
        eq(schema.memorySources.source_key, sourceKey),
        eq(schema.memorySources.state, 'active'),
      ),
    )
    .limit(1);
  return toD1(db, query).first<MemorySourceRecord>();
}

export async function getMemoryRepresentation(
  db: D1Like,
  representationId: string,
): Promise<MemoryRepresentationRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryRepresentations)
    .where(eq(schema.memoryRepresentations.representation_id, representationId));
  return toD1(db, query).first<MemoryRepresentationRecord>();
}

export async function getMemoryRepresentationSourceId(
  db: D1Like,
  representationId: string,
): Promise<{ source_id: string | null } | null> {
  const query = orm(db)
    .select({ source_id: schema.memoryRepresentations.source_id })
    .from(schema.memoryRepresentations)
    .where(eq(schema.memoryRepresentations.representation_id, representationId));
  return toD1(db, query).first<{ source_id: string | null }>();
}

export async function listMemoryRepresentationDependencyLinks(
  db: D1Like,
  representationId: string,
): Promise<{ source_id: string; depends_on_representation_id: string | null }[]> {
  const query = orm(db)
    .select({
      source_id: schema.memoryRepresentationDependencies.source_id,
      depends_on_representation_id:
        schema.memoryRepresentationDependencies.depends_on_representation_id,
    })
    .from(schema.memoryRepresentationDependencies)
    .where(
      eq(
        schema.memoryRepresentationDependencies.representation_id,
        representationId,
      ),
    );
  const result = await toD1(db, query).all<{
    source_id: string;
    depends_on_representation_id: string | null;
  }>();
  return result.results;
}

export async function listMemoryRepresentationDependencies(
  db: D1Like,
  representationId: string,
): Promise<MemoryRepresentationDependencyRow[]> {
  const query = orm(db)
    .select()
    .from(schema.memoryRepresentationDependencies)
    .where(
      eq(
        schema.memoryRepresentationDependencies.representation_id,
        representationId,
      ),
    )
    .orderBy(schema.memoryRepresentationDependencies.dependency_index);
  const result = await toD1(db, query).all<MemoryRepresentationDependencyRow>();
  return result.results;
}

export async function getMemoryExperience(
  db: D1Like,
  experienceId: string,
): Promise<MemoryExperienceRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryExperiences)
    .where(eq(schema.memoryExperiences.experience_id, experienceId));
  return toD1(db, query).first<MemoryExperienceRecord>();
}

export async function getMemoryExperienceByDedupe(
  db: D1Like,
  dedupeKey: string,
): Promise<{ experience_id: string } | null> {
  const query = orm(db)
    .select({ experience_id: schema.memoryExperiences.experience_id })
    .from(schema.memoryExperiences)
    .where(eq(schema.memoryExperiences.dedupe_key, dedupeKey));
  return toD1(db, query).first<{ experience_id: string }>();
}

export async function getMemoryContext(
  db: D1Like,
  contextId: string,
): Promise<MemoryContextRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryContexts)
    .where(eq(schema.memoryContexts.context_id, contextId));
  return toD1(db, query).first<MemoryContextRecord>();
}

export async function listMemoryContextItems(
  db: D1Like,
  contextId: string,
): Promise<{ representation_id: string; evidence: string | null; origin_scope_json: string }[]> {
  const query = orm(db)
    .select({
      representation_id: schema.memoryContextItems.representation_id,
      evidence: schema.memoryContextItems.evidence,
      origin_scope_json: schema.memoryContextItems.origin_scope_json,
    })
    .from(schema.memoryContextItems)
    .where(eq(schema.memoryContextItems.context_id, contextId))
    .orderBy(schema.memoryContextItems.item_index);
  const result = await toD1(db, query).all<{
    representation_id: string;
    evidence: string | null;
    origin_scope_json: string;
  }>();
  return result.results;
}

export interface MemoryContextPageQuery {
  spaceId: string;
  ownershipEpoch: number;
  agentId: string;
  kind?: 'lookup' | 'bound' | null;
  cursor?: { seq: number; key: string } | null;
  limit: number;
}

export interface MemoryContextSummaryRow {
  context_id: string;
  recall_id: string | null;
  kind: 'lookup' | 'bound';
  body_sha256: string;
  body_bytes: number;
  status: 'ready' | 'invalidated' | 'expired' | 'purged';
  created_at: number;
  expires_at: number | null;
}

export async function listMemoryContextSummaries(
  db: D1Like,
  input: MemoryContextPageQuery,
): Promise<MemoryContextSummaryRow[]> {
  const conditions = [
    eq(schema.memoryContexts.space_id, input.spaceId),
    eq(schema.memoryContexts.ownership_epoch, input.ownershipEpoch),
    eq(schema.memoryContexts.agent_actor_id, input.agentId),
  ];
  if (input.kind) conditions.push(eq(schema.memoryContexts.kind, input.kind));
  if (input.cursor) {
    conditions.push(
      or(
        lt(schema.memoryContexts.created_at, input.cursor.seq),
        and(
          eq(schema.memoryContexts.created_at, input.cursor.seq),
          lt(schema.memoryContexts.context_id, input.cursor.key),
        ),
      )!,
    );
  }
  const query = orm(db)
    .select({
      context_id: schema.memoryContexts.context_id,
      recall_id: schema.memoryContexts.recall_id,
      kind: schema.memoryContexts.kind,
      body_sha256: schema.memoryContexts.body_sha256,
      body_bytes: schema.memoryContexts.body_bytes,
      status: schema.memoryContexts.status,
      created_at: schema.memoryContexts.created_at,
      expires_at: schema.memoryContexts.expires_at,
    })
    .from(schema.memoryContexts)
    .where(and(...conditions))
    .orderBy(desc(schema.memoryContexts.created_at), desc(schema.memoryContexts.context_id))
    .limit(input.limit);
  const result = await toD1(db, query).all<MemoryContextSummaryRow>();
  return result.results;
}

export async function getMemoryManifest(
  db: D1Like,
  manifestId: string,
): Promise<MemoryManifestRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryManifests)
    .where(eq(schema.memoryManifests.manifest_id, manifestId));
  return toD1(db, query).first<MemoryManifestRecord>();
}

export async function getMemoryManifestByInvocation(
  db: D1Like,
  input: {
    spaceId: string;
    ownershipEpoch: number;
    agentId: string;
    hostBindingId: string;
    invocationId: string;
  },
): Promise<MemoryManifestRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryManifests)
    .where(
      and(
        eq(schema.memoryManifests.space_id, input.spaceId),
        eq(schema.memoryManifests.ownership_epoch, input.ownershipEpoch),
        eq(schema.memoryManifests.agent_actor_id, input.agentId),
        eq(schema.memoryManifests.host_binding_id, input.hostBindingId),
        eq(schema.memoryManifests.invocation_id, input.invocationId),
      ),
    );
  return toD1(db, query).first<MemoryManifestRecord>();
}

export async function listMemoryManifestItems(
  db: D1Like,
  manifestId: string,
): Promise<MemoryManifestItemRow[]> {
  const query = orm(db)
    .select()
    .from(schema.memoryManifestItems)
    .where(eq(schema.memoryManifestItems.manifest_id, manifestId))
    .orderBy(schema.memoryManifestItems.item_index);
  const result = await toD1(db, query).all<MemoryManifestItemRow>();
  return result.results;
}

export async function getMemorySelection(
  db: D1Like,
  selectionId: string,
): Promise<MemorySelectionRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySelections)
    .where(eq(schema.memorySelections.selection_id, selectionId));
  return toD1(db, query).first<MemorySelectionRecord>();
}

export async function getMemoryReceiptByIdempotencyKey(
  db: D1Like,
  idempotencyKey: string,
): Promise<MemoryReceiptRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryReceipts)
    .where(eq(schema.memoryReceipts.idempotency_key, idempotencyKey));
  return toD1(db, query).first<MemoryReceiptRecord>();
}

export async function getMemoryReceipt(
  db: D1Like,
  receiptId: string,
): Promise<MemoryReceiptRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryReceipts)
    .where(eq(schema.memoryReceipts.receipt_id, receiptId));
  return toD1(db, query).first<MemoryReceiptRecord>();
}

export async function getMemoryReceiptByInvocation(
  db: D1Like,
  input: {
    kind: 'input_exposure' | 'context_delivery';
    spaceId: string;
    ownershipEpoch: number;
    agentId: string;
    hostBindingId: string;
    invocationId: string;
  },
): Promise<MemoryReceiptRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryReceipts)
    .where(
      and(
        eq(schema.memoryReceipts.kind, input.kind),
        eq(schema.memoryReceipts.space_id, input.spaceId),
        eq(schema.memoryReceipts.ownership_epoch, input.ownershipEpoch),
        eq(schema.memoryReceipts.agent_actor_id, input.agentId),
        eq(schema.memoryReceipts.host_binding_id, input.hostBindingId),
        eq(schema.memoryReceipts.invocation_id, input.invocationId),
      ),
    );
  return toD1(db, query).first<MemoryReceiptRecord>();
}

export async function hasMemoryReceiptForManifest(
  db: D1Like,
  manifestId: string,
): Promise<boolean> {
  const query = orm(db)
    .select({ receipt_id: schema.memoryReceipts.receipt_id })
    .from(schema.memoryReceipts)
    .where(
      and(
        eq(schema.memoryReceipts.kind, 'input_exposure'),
        eq(schema.memoryReceipts.manifest_id, manifestId),
      ),
    )
    .limit(1);
  return (await toD1(db, query).first<{ receipt_id: string }>()) !== null;
}

export async function getLatestMemoryReceiptForManifest(
  db: D1Like,
  manifestId: string,
): Promise<MemoryReceiptRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryReceipts)
    .where(
      and(
        eq(schema.memoryReceipts.kind, 'input_exposure'),
        eq(schema.memoryReceipts.manifest_id, manifestId),
      ),
    )
    .orderBy(desc(schema.memoryReceipts.recorded_at))
    .limit(1);
  return toD1(db, query).first<MemoryReceiptRecord>();
}

export async function hasMemoryGatewayProof(
  db: D1Like,
  manifestId: string,
): Promise<boolean> {
  const query = orm(db)
    .select({ proof_id: schema.memoryExperienceProofs.proof_id })
    .from(schema.memoryExperienceProofs)
    .where(
      and(
        eq(schema.memoryExperienceProofs.manifest_id, manifestId),
        eq(schema.memoryExperienceProofs.evidence, 'gateway_observed_submitted'),
      ),
    )
    .limit(1);
  return (await toD1(db, query).first<{ proof_id: string }>()) !== null;
}

export async function getMemoryHostBinding(
  db: D1Like,
  bindingId: string,
): Promise<MemoryHostBindingRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryHostBindings)
    .where(eq(schema.memoryHostBindings.binding_id, bindingId));
  return toD1(db, query).first<MemoryHostBindingRecord>();
}

export async function getActiveMemoryHostBindingBySession(
  db: D1Like,
  spaceId: string,
  sessionIncarnation: string,
): Promise<MemoryHostBindingRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryHostBindings)
    .where(
      and(
        eq(schema.memoryHostBindings.space_id, spaceId),
        eq(schema.memoryHostBindings.session_incarnation, sessionIncarnation),
        eq(schema.memoryHostBindings.state, 'active'),
      ),
    );
  return toD1(db, query).first<MemoryHostBindingRecord>();
}

export async function getLatestActiveMemoryHostBinding(
  db: D1Like,
  spaceId: string,
  agentId: string,
): Promise<MemoryHostBindingRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryHostBindings)
    .where(
      and(
        eq(schema.memoryHostBindings.space_id, spaceId),
        eq(schema.memoryHostBindings.agent_actor_id, agentId),
        eq(schema.memoryHostBindings.state, 'active'),
      ),
    )
    .orderBy(desc(schema.memoryHostBindings.created_at))
    .limit(1);
  return toD1(db, query).first<MemoryHostBindingRecord>();
}

export async function listActiveMemoryHostBindingIds(
  db: D1Like,
  agentId: string,
): Promise<{ binding_id: string }[]> {
  const query = orm(db)
    .select({ binding_id: schema.memoryHostBindings.binding_id })
    .from(schema.memoryHostBindings)
    .where(
      and(
        eq(schema.memoryHostBindings.agent_actor_id, agentId),
        eq(schema.memoryHostBindings.state, 'active'),
      ),
    );
  const result = await toD1(db, query).all<{ binding_id: string }>();
  return result.results;
}

export async function countActiveMemoryHostBindings(
  db: D1Like,
  spaceId: string,
): Promise<number> {
  const query = orm(db)
    .select({ n: sql<number>`count(*)`.as('n') })
    .from(schema.memoryHostBindings)
    .where(
      and(
        eq(schema.memoryHostBindings.space_id, spaceId),
        eq(schema.memoryHostBindings.state, 'active'),
      ),
    );
  const row = await toD1(db, query).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getCurrentCuratedRevision(
  db: D1Like,
  curatedId: string,
): Promise<{ revision: number } | null> {
  const query = orm(db)
    .select({ revision: schema.memoryCurated.revision })
    .from(schema.memoryCurated)
    .where(
      and(
        eq(schema.memoryCurated.curated_id, curatedId),
        eq(schema.memoryCurated.current, 1),
      ),
    );
  return toD1(db, query).first<{ revision: number }>();
}

export interface MemoryCuratedListRow {
  curated_id: string;
  revision: number;
  title: string;
  content: string;
  content_sha256: string;
  origin: 'manual' | 'imported_external_knowledge';
  created_at: number;
  updated_at: number;
}

export async function listCurrentCuratedMemories(
  db: D1Like,
  spaceId: string,
  ownershipEpoch: number,
  limit?: number,
): Promise<MemoryCuratedListRow[]> {
  const base = orm(db)
    .select({
      curated_id: schema.memoryCurated.curated_id,
      revision: schema.memoryCurated.revision,
      title: schema.memoryCurated.title,
      content: schema.memoryCurated.content,
      content_sha256: schema.memoryCurated.content_sha256,
      origin: schema.memoryCurated.origin,
      created_at: schema.memoryCurated.created_at,
      updated_at: schema.memoryCurated.updated_at,
    })
    .from(schema.memoryCurated)
    .where(
      and(
        eq(schema.memoryCurated.space_id, spaceId),
        eq(schema.memoryCurated.ownership_epoch, ownershipEpoch),
        eq(schema.memoryCurated.current, 1),
      ),
    );
  const query =
    limit === undefined
      ? base.orderBy(desc(schema.memoryCurated.updated_at))
      : base
          .orderBy(desc(schema.memoryCurated.updated_at), schema.memoryCurated.curated_id)
          .limit(limit);
  const result = await toD1(db, query).all<MemoryCuratedListRow>();
  return result.results;
}

export async function getMemoryCatchupPlan(
  db: D1Like,
  planId: string,
): Promise<MemoryCatchupPlanRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryCatchupPlans)
    .where(eq(schema.memoryCatchupPlans.plan_id, planId));
  return toD1(db, query).first<MemoryCatchupPlanRecord>();
}

export async function getMemoryCatchupPlanByRequestKey(
  db: D1Like,
  spaceId: string,
  agentId: string,
  requestKey: string,
): Promise<MemoryCatchupPlanRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryCatchupPlans)
    .where(
      and(
        eq(schema.memoryCatchupPlans.space_id, spaceId),
        eq(schema.memoryCatchupPlans.agent_actor_id, agentId),
        eq(schema.memoryCatchupPlans.request_key, requestKey),
      ),
    );
  return toD1(db, query).first<MemoryCatchupPlanRecord>();
}

export async function listMemoryCatchupItems(
  db: D1Like,
  planId: string,
): Promise<MemoryCatchupItemRecord[]> {
  const query = orm(db)
    .select()
    .from(schema.memoryCatchupItems)
    .where(eq(schema.memoryCatchupItems.plan_id, planId))
    .orderBy(schema.memoryCatchupItems.item_index);
  const result = await toD1(db, query).all<MemoryCatchupItemRecord>();
  return result.results;
}

export async function getMemoryRecallRequest(
  db: D1Like,
  recallId: string,
): Promise<MemoryRecallRequestRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryRecallRequests)
    .where(eq(schema.memoryRecallRequests.recall_id, recallId));
  return toD1(db, query).first<MemoryRecallRequestRecord>();
}

export async function getMemoryRecallRequestByKey(
  db: D1Like,
  spaceId: string,
  requestKey: string,
): Promise<MemoryRecallRequestRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryRecallRequests)
    .where(
      and(
        eq(schema.memoryRecallRequests.space_id, spaceId),
        eq(schema.memoryRecallRequests.request_key, requestKey),
      ),
    );
  return toD1(db, query).first<MemoryRecallRequestRecord>();
}

export interface MemoryRecallCandidateRow {
  experience_id: string;
  origin_room_id: string | null;
  origin_member_generation: number;
  representation_id: string;
  evidence: string | null;
  created_at: number;
}

export async function listMemoryRecallCandidates(
  db: D1Like,
  input: {
    spaceId: string;
    ownershipEpoch: number;
    agentId: string;
    limit: number;
  },
): Promise<MemoryRecallCandidateRow[]> {
  const query = orm(db)
    .select({
      experience_id: schema.memoryExperiences.experience_id,
      origin_room_id: schema.memoryExperiences.origin_room_id,
      origin_member_generation: schema.memoryExperiences.origin_member_generation,
      representation_id: schema.memoryExperiences.representation_id,
      evidence: schema.memoryExperiences.evidence,
      created_at: schema.memoryExperiences.created_at,
    })
    .from(schema.memoryExperiences)
    .where(
      and(
        eq(schema.memoryExperiences.space_id, input.spaceId),
        eq(schema.memoryExperiences.ownership_epoch, input.ownershipEpoch),
        eq(schema.memoryExperiences.agent_actor_id, input.agentId),
        eq(schema.memoryExperiences.available, 1),
        eq(schema.memoryExperiences.origin_kind, 'experienced'),
      ),
    )
    .orderBy(desc(schema.memoryExperiences.created_at))
    .limit(input.limit);
  const result = await toD1(db, query).all<MemoryRecallCandidateRow>();
  return result.results;
}

export interface MemoryCoverageRangeRow {
  source_id: string;
  source_revision: number;
  range_start: number;
  range_end: number;
  text_sha256: string;
}

export async function listMemoryCoverageRanges(
  db: D1Like,
  input: {
    spaceId: string;
    ownershipEpoch: number;
    agentId: string;
    roomId: string;
    memberGeneration: number;
    sourceId?: string | null;
    sourceRevision?: number | null;
  },
): Promise<MemoryCoverageRangeRow[]> {
  const conditions = [
    eq(schema.memoryCoverageRanges.space_id, input.spaceId),
    eq(schema.memoryCoverageRanges.ownership_epoch, input.ownershipEpoch),
    eq(schema.memoryCoverageRanges.agent_actor_id, input.agentId),
    eq(schema.memoryCoverageRanges.origin_room_id, input.roomId),
    eq(schema.memoryCoverageRanges.origin_member_generation, input.memberGeneration),
  ];
  if (input.sourceId) {
    conditions.push(eq(schema.memoryCoverageRanges.source_id, input.sourceId));
  }
  if (input.sourceRevision !== null && input.sourceRevision !== undefined) {
    conditions.push(eq(schema.memoryCoverageRanges.source_revision, input.sourceRevision));
  }
  const query = orm(db)
    .select({
      source_id: schema.memoryCoverageRanges.source_id,
      source_revision: schema.memoryCoverageRanges.source_revision,
      range_start: schema.memoryCoverageRanges.range_start,
      range_end: schema.memoryCoverageRanges.range_end,
      text_sha256: schema.memoryCoverageRanges.text_sha256,
    })
    .from(schema.memoryCoverageRanges)
    .where(and(...conditions))
    .orderBy(
      schema.memoryCoverageRanges.source_id,
      schema.memoryCoverageRanges.source_revision,
      schema.memoryCoverageRanges.range_start,
      schema.memoryCoverageRanges.range_end,
    );
  const result = await toD1(db, query).all<MemoryCoverageRangeRow>();
  return result.results;
}
