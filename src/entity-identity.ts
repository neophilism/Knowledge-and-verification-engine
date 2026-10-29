import {
  canonical,
  digest,
  invariant,
  nonempty,
  requireScope,
  validateRef,
} from "./contracts.ts";
import type { Context, Ref, Scope } from "./contracts.ts";
import { inspectKnowledge } from "./index.ts";
import type { KnowledgeState } from "./index.ts";
export type EntityIdentityInput = Readonly<{
  left: Ref;
  right: Ref;
  expectedRevision: number;
  decision: "same" | "different" | "unresolved";
  rationale: string;
}>;
export type EntityIdentityRecord = Omit<
  EntityIdentityInput,
  "expectedRevision"
> &
  Readonly<{
    ref: Ref;
    supersedes: Ref | null;
    visibility: "private";
    actorId: string;
    createdAt: string;
    requestId: string;
    purpose: string;
  }>;
export type EntityIdentityState = Scope &
  Readonly<{
    schemaVersion: 1;
    visibility: "private";
    records: readonly EntityIdentityRecord[];
  }>;
function exact(v: unknown, keys: readonly string[]) {
  invariant(
    v !== null &&
      typeof v === "object" &&
      Object.getPrototypeOf(v) === Object.prototype &&
      Object.keys(v).length === keys.length &&
      keys.every((k) => Object.hasOwn(v, k)),
    "invalid_identity",
    "Exact plain fields required",
  );
}
function same(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}
function authorize(c: Context, s: Scope) {
  inspectKnowledge(c, {
    tenantId: s.tenantId,
    projectId: s.projectId,
    schemaVersion: 1,
    visibility: "private",
    records: [],
  });
}
function reference(r: Ref, s: Scope, kind: string) {
  validateRef(r);
  requireScope(s, r);
  invariant(
    r.kind === kind,
    "invalid_reference",
    "Exact typed reference required",
  );
}
function pair(left: Ref, right: Ref, s: Scope) {
  reference(left, s, "entity");
  reference(right, s, "entity");
  invariant(
    left.id < right.id,
    "invalid_identity",
    "Select distinct entity IDs in lexical order",
  );
  return digest({
    kind: "entity-identity-pair-v1",
    leftId: left.id,
    rightId: right.id,
  });
}
/** Private syntax/history validation only; recorded judgments do not authenticate identity or a human. */
export function assertEntityIdentityState(s: EntityIdentityState): void {
  exact(s, ["tenantId", "projectId", "schemaVersion", "visibility", "records"]);
  nonempty(s.tenantId, "Tenant", 128);
  nonempty(s.projectId, "Project", 128);
  invariant(
    s.schemaVersion === 1 &&
      s.visibility === "private" &&
      Array.isArray(s.records) &&
      s.records.length <= 512,
    "invalid_identity",
    "Bounded private identity history required",
  );
  invariant(
    Buffer.byteLength(canonical(s)) <= 2 * 1024 * 1024,
    "identity_full",
    "Identity history byte budget exceeded",
  );
  const latest = new Map<string, EntityIdentityRecord>();
  for (const r of s.records) {
    exact(r, [
      "ref",
      "supersedes",
      "left",
      "right",
      "decision",
      "rationale",
      "visibility",
      "actorId",
      "createdAt",
      "requestId",
      "purpose",
    ]);
    reference(r.ref, s, "entity-identity");
    invariant(
      r.ref.id === pair(r.left, r.right, s) && r.visibility === "private",
      "invalid_identity",
      "Private canonical pair required",
    );
    nonempty(r.rationale, "Identity rationale", 4000);
    invariant(
      ["same", "different", "unresolved"].includes(r.decision),
      "invalid_identity",
      "Explicit pair judgment required",
    );
    authorize(
      {
        tenantId: s.tenantId,
        projectId: s.projectId,
        actor: { id: r.actorId, kind: "human", roles: ["researcher"] },
        now: r.createdAt,
        requestId: r.requestId,
        purpose: r.purpose,
      },
      s,
    );
    const old = latest.get(r.ref.id);
    invariant(
      r.ref.revision === (old?.ref.revision ?? 0) + 1 &&
        (old
          ? same(r.supersedes, old.ref) &&
            r.left.revision >= old.left.revision &&
            r.right.revision >= old.right.revision
          : r.supersedes === null),
      "invalid_revision",
      "Exact contiguous nonregressing pair history required",
    );
    latest.set(r.ref.id, r);
  }
}
export function createEntityIdentityState(
  context: Context,
): EntityIdentityState {
  const c = structuredClone(context);
  authorize(c, c);
  return {
    tenantId: c.tenantId,
    projectId: c.projectId,
    schemaVersion: 1,
    visibility: "private",
    records: [],
  };
}
/** Human-authored pair observation, not entity merge, identity proof, verification, or authority. */
export function recordEntityIdentity(
  context: Context,
  knowledge: KnowledgeState,
  state: EntityIdentityState,
  input: EntityIdentityInput,
): EntityIdentityState {
  const c = structuredClone(context),
    s = structuredClone(state),
    q = structuredClone(input);
  authorize(c, s);
  invariant(
    c.actor.kind === "human",
    "human_review_required",
    "Explicit trusted human review required",
  );
  assertEntityIdentityState(s);
  exact(q, ["left", "right", "expectedRevision", "decision", "rationale"]);
  const id = pair(q.left, q.right, s);
  const entities = inspectKnowledge(c, knowledge);
  for (const ref of [q.left, q.right]) {
    invariant(
      entities.some((r) => same(r.ref, ref)),
      "missing_reference",
      "Exact entity edition required",
    );
    invariant(
      !entities.some(
        (r) =>
          r.ref.kind === "entity" &&
          r.ref.id === ref.id &&
          r.ref.revision > ref.revision,
      ),
      "stale_entity",
      "Explicit current entity editions required",
    );
  }
  const old = s.records.filter((r) => r.ref.id === id).at(-1);
  invariant(
    Number.isSafeInteger(q.expectedRevision) &&
      q.expectedRevision >= 0 &&
      q.expectedRevision < Number.MAX_SAFE_INTEGER,
    "invalid_revision",
    "Safe expected pair revision required",
  );
  invariant(
    (old?.ref.revision ?? 0) === q.expectedRevision,
    "revision_conflict",
    "Pair decision changed",
  );
  const { expectedRevision, ...value } = q;
  const r: EntityIdentityRecord = {
    ...value,
    ref: {
      tenantId: s.tenantId,
      projectId: s.projectId,
      kind: "entity-identity",
      id,
      revision: expectedRevision + 1,
    },
    supersedes: old?.ref ?? null,
    visibility: "private",
    actorId: c.actor.id,
    createdAt: c.now,
    requestId: c.requestId,
    purpose: c.purpose,
  };
  const next: EntityIdentityState = { ...s, records: [...s.records, r] };
  assertEntityIdentityState(next);
  return next;
}
/** Returns exact pair observations only, with changed/missing entity editions explicitly needing review. */
export function inspectEntityIdentities(
  context: Context,
  knowledge: KnowledgeState,
  state: EntityIdentityState,
): Readonly<{
  history: readonly EntityIdentityRecord[];
  latest: readonly Readonly<{
    record: EntityIdentityRecord;
    review: "current-editions" | "needs-review";
  }>[];
}> {
  const c = structuredClone(context),
    s = structuredClone(state);
  authorize(c, s);
  assertEntityIdentityState(s);
  const entities = inspectKnowledge(c, knowledge),
    latest = new Map<string, EntityIdentityRecord>();
  for (const r of s.records) latest.set(r.ref.id, r);
  return {
    history: s.records,
    latest: [...latest.values()].map((record) => ({
      record,
      review: [record.left, record.right].every(
        (ref) =>
          entities.some((r) => same(r.ref, ref)) &&
          !entities.some(
            (r) =>
              r.ref.kind === "entity" &&
              r.ref.id === ref.id &&
              r.ref.revision > ref.revision,
          ),
      )
        ? "current-editions"
        : "needs-review",
    })),
  };
}
