import {
  canonical,
  invariant,
  nonempty,
  requireScope,
  validTime,
  validateRef,
} from "./contracts.ts";
import type { Context, Ref, Scope } from "./contracts.ts";
export type TimeRange = Readonly<{
  earliest: string | null;
  latest: string | null;
}>;
export type KnowledgeValue =
  | Readonly<{
      type: "entity";
      label: string;
      category: "person" | "organization" | "place" | "object" | "unknown";
      description: string;
    }>
  | Readonly<{
      type: "event";
      label: string;
      description: string;
      time: TimeRange;
      entityRefs: readonly Ref[];
    }>
  | Readonly<{
      type: "claim";
      text: string;
      subjectRefs: readonly Ref[];
      time: TimeRange;
      accountType:
        | "attributed_testimony"
        | "document_assertion"
        | "observation"
        | "research_inference";
      limitations: readonly string[];
      assessment: null;
      proceduralPosture: null;
      editorialApproval: null;
    }>;
export type KnowledgeRevision = Readonly<{
  ref: Ref;
  supersedes: Ref | null;
  visibility: "private";
  createdAt: string;
  actorId: string;
  actorKind: Context["actor"]["kind"];
  requestId: string;
  purpose: string;
  value: KnowledgeValue;
}>;
export type KnowledgeState = Scope &
  Readonly<{
    schemaVersion: 1;
    visibility: "private";
    records: readonly KnowledgeRevision[];
  }>;
export type KnowledgeCommand = Readonly<{
  id: string;
  expectedRevision: number;
  value: KnowledgeValue;
}>;
const categories = ["person", "organization", "place", "object", "unknown"];
const accounts = [
  "attributed_testimony",
  "document_assertion",
  "observation",
  "research_inference",
];
function exact(
  v: unknown,
  keys: readonly string[],
): void {
  invariant(
    v !== null &&
      typeof v === "object" &&
      Object.getPrototypeOf(v) === Object.prototype &&
      Object.keys(v).length === keys.length &&
      keys.every((k) => Object.hasOwn(v, k)),
    "invalid_knowledge",
    "Exact plain record fields required",
  );
}
function scope(s: Scope) {
  nonempty(s.tenantId, "Tenant", 128);
  nonempty(s.projectId, "Project", 128);
}
function instant(v: unknown) {
  invariant(
    typeof v === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v),
    "invalid_time",
    "UTC instant required",
  );
  const n = validTime(v);
  invariant(
    new Date(n).toISOString() ===
      v.replace(/Z$/, v.includes(".") ? "Z" : ".000Z"),
    "invalid_time",
    "Calendar instant required",
  );
  return n;
}
function time(t: TimeRange) {
  exact(t, ["earliest", "latest"]);
  const a = t.earliest === null ? null : instant(t.earliest),
    b = t.latest === null ? null : instant(t.latest);
  invariant(
    a === null || b === null || a <= b,
    "invalid_time",
    "Time bounds reversed",
  );
}
function same(a: Ref, b: Ref) {
  return canonical(a) === canonical(b);
}
function reference(r: Ref, s: KnowledgeState) {
  validateRef(r);
  requireScope(s, r);
  invariant(
    ["entity", "event", "claim"].includes(r.kind),
    "invalid_reference",
    "Knowledge reference required",
  );
  invariant(
    s.records.some((x) => same(x.ref, r)),
    "missing_reference",
    "Exact referenced edition required",
  );
}
function refs(v: readonly Ref[], s: KnowledgeState, kinds: readonly string[]) {
  invariant(
    Array.isArray(v) && v.length <= 128,
    "invalid_knowledge",
    "Bounded references required",
  );
  const seen = new Set<string>();
  for (const r of v) {
    reference(r, s);
    invariant(
      kinds.includes(r.kind) && !seen.has(canonical(r)),
      "invalid_reference",
      "Distinct allowed references required",
    );
    seen.add(canonical(r));
  }
}
function value(v: KnowledgeValue, s: KnowledgeState) {
  invariant(
    v && ["entity", "event", "claim"].includes(v.type),
    "invalid_knowledge",
    "Known record type required",
  );
  if (v.type === "entity") {
    exact(v, ["type", "label", "category", "description"]);
    nonempty(v.label, "Label", 500);
    nonempty(v.description, "Description", 8000);
    invariant(
      categories.includes(v.category),
      "invalid_knowledge",
      "Known entity category required",
    );
  } else if (v.type === "event") {
    exact(v, ["type", "label", "description", "time", "entityRefs"]);
    nonempty(v.label, "Label", 500);
    nonempty(v.description, "Description", 8000);
    time(v.time);
    refs(v.entityRefs, s, ["entity"]);
  } else {
    exact(v, [
      "type",
      "text",
      "subjectRefs",
      "time",
      "accountType",
      "limitations",
      "assessment",
      "proceduralPosture",
      "editorialApproval",
    ]);
    nonempty(v.text, "Claim", 16000);
    refs(v.subjectRefs, s, ["entity", "event"]);
    time(v.time);
    invariant(
      accounts.includes(v.accountType) &&
        Array.isArray(v.limitations) &&
        v.limitations.length <= 64,
      "invalid_knowledge",
      "Bounded account and limitations required",
    );
    for (const l of v.limitations) nonempty(l, "Limitation", 2000);
    invariant(
      v.assessment === null &&
        v.proceduralPosture === null &&
        v.editorialApproval === null,
      "unassessed_required",
      "Assessment, procedure and editorial tracks require separate future records",
    );
  }
}
/** Validate serialized private history; this does not authenticate the host or establish evidence truth. */
export function assertKnowledgeState(s: KnowledgeState): void {
  exact(s, ["tenantId", "projectId", "schemaVersion", "visibility", "records"]);
  scope(s);
  invariant(
    s.schemaVersion === 1 &&
      s.visibility === "private" &&
      Array.isArray(s.records) &&
      s.records.length <= 2048,
    "invalid_knowledge",
    "Bounded private history required",
  );
  const prior: KnowledgeRevision[] = [];
  const latest = new Map<string, Ref>();
  for (const r of s.records) {
    exact(r, [
      "ref",
      "supersedes",
      "visibility",
      "createdAt",
      "actorId",
      "actorKind",
      "requestId",
      "purpose",
      "value",
    ]);
    validateRef(r.ref);
    requireScope(s, r.ref);
    nonempty(r.ref.id, "Record", 128);
    invariant(
      r.ref.kind === r.value?.type && r.visibility === "private",
      "invalid_knowledge",
      "Private typed record required",
    );
    instant(r.createdAt);
    nonempty(r.actorId, "Actor", 128);
    nonempty(r.requestId, "Request", 128);
    nonempty(r.purpose, "Purpose", 200);
    invariant(
      ["human", "agent", "service"].includes(r.actorKind),
      "invalid_knowledge",
      "Known actor kind required",
    );
    const key = canonical([r.ref.kind, r.ref.id]),
      old = latest.get(key);
    invariant(
      r.ref.revision === (old?.revision ?? 0) + 1 &&
        (old
          ? r.supersedes !== null && same(r.supersedes, old)
          : r.supersedes === null),
      "invalid_revision",
      "Contiguous exact revision lineage required",
    );
    value(r.value, { ...s, records: prior });
    prior.push(r);
    latest.set(key, r.ref);
  }
  invariant(
    Buffer.byteLength(canonical(s)) <= 2 * 1024 * 1024,
    "knowledge_full",
    "Private history byte budget exceeded",
  );
}
function context(c: Context, s: Scope) {
  scope(c);
  requireScope(c, s);
  nonempty(c.actor.id, "Actor", 128);
  nonempty(c.requestId, "Request", 128);
  nonempty(c.purpose, "Purpose", 200);
  instant(c.now);
  invariant(
    ["human", "agent", "service"].includes(c.actor.kind) &&
      Array.isArray(c.actor.roles) &&
      c.actor.roles.length <= 128 &&
      c.actor.roles.every((r) => typeof r === "string" && r.length <= 128),
    "invalid_context",
    "Bounded actor required",
  );
  invariant(
    c.actor.roles.some((r) => r === "owner" || r === "researcher"),
    "forbidden",
    "Trusted research role required",
  );
}
export function createKnowledgeState(c: Context): KnowledgeState {
  const captured = structuredClone(c);
  context(captured, captured);
  return {
    tenantId: captured.tenantId,
    projectId: captured.projectId,
    schemaVersion: 1,
    visibility: "private",
    records: [],
  };
}
/** Append one revision; earlier state/records remain unchanged. No SQL, I/O, model or assessment. */
export function reviseKnowledge(
  contextInput: Context,
  state: KnowledgeState,
  commandInput: KnowledgeCommand,
): KnowledgeState {
  const c = structuredClone(contextInput),
    s = structuredClone(state),
    command = structuredClone(commandInput);
  context(c, s);
  assertKnowledgeState(s);
  exact(command, ["id", "expectedRevision", "value"]);
  nonempty(command.id, "Record", 128);
  invariant(
    Number.isSafeInteger(command.expectedRevision) &&
      command.expectedRevision >= 0 &&
      command.expectedRevision < Number.MAX_SAFE_INTEGER,
    "invalid_revision",
    "Finite expected revision required",
  );
  value(command.value, s);
  const previous = s.records
    .filter((r) => r.ref.kind === command.value.type && r.ref.id === command.id)
    .at(-1);
  invariant(
    (previous?.ref.revision ?? 0) === command.expectedRevision,
    "revision_conflict",
    "Current logical record edition changed",
  );
  // New assertions must deliberately select current known subjects; historical records retain old links.
  const dependencies =
    command.value.type === "event"
      ? command.value.entityRefs
      : command.value.type === "claim"
        ? command.value.subjectRefs
        : [];
  for (const ref of dependencies)
    invariant(
      !s.records.some(
        (r) =>
          r.ref.kind === ref.kind &&
          r.ref.id === ref.id &&
          r.ref.revision > ref.revision,
      ),
      "stale_reference",
      "Select current subject edition",
    );
  const ref: Ref = {
    tenantId: s.tenantId,
    projectId: s.projectId,
    kind: command.value.type,
    id: command.id,
    revision: command.expectedRevision + 1,
  };
  const record: KnowledgeRevision = {
    ref,
    supersedes: previous?.ref ?? null,
    visibility: "private",
    createdAt: c.now,
    actorId: c.actor.id,
    actorKind: c.actor.kind,
    requestId: c.requestId,
    purpose: c.purpose,
    value: command.value,
  };
  const next: KnowledgeState = { ...s, records: [...s.records, record] };
  assertKnowledgeState(next);
  return next;
}
/** Authorized in-memory inspection; exact containing history, not evidence/current-policy verification. */
export function inspectKnowledge(
  contextInput: Context,
  state: KnowledgeState,
): readonly KnowledgeRevision[] {
  const c = structuredClone(contextInput),
    s = structuredClone(state);
  context(c, s);
  assertKnowledgeState(s);
  return s.records;
}
