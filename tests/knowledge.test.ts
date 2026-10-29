import test from "node:test";
import assert from "node:assert/strict";
import {
  createKnowledgeState,
  reviseKnowledge,
  inspectKnowledge,
  assertKnowledgeState,
} from "../src/index.ts";
import type { KnowledgeValue } from "../src/index.ts";
import type { Context } from "../src/contracts.ts";
const c: Context = {
  tenantId: "fiction",
  projectId: "review",
  actor: { id: "researcher", kind: "human", roles: ["researcher"] },
  purpose: "private-review",
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
};
const entity: KnowledgeValue = {
  type: "entity",
  label: "Witness A",
  category: "person",
  description: "Fictional person; identity unresolved",
};
const claim: KnowledgeValue = {
  type: "claim",
  text: "The demonstration began near dawn.",
  subjectRefs: [],
  time: { earliest: null, latest: null },
  accountType: "attributed_testimony",
  limitations: ["No independent verification"],
  assessment: null,
  proceduralPosture: null,
  editorialApproval: null,
};
test("private entity/event/claim revisions preserve unknown time and independent unassessed tracks", () => {
  let s = reviseKnowledge(c, createKnowledgeState(c), {
    id: "a",
    expectedRevision: 0,
    value: entity,
  });
  s = reviseKnowledge(c, s, {
    id: "event",
    expectedRevision: 0,
    value: {
      type: "event",
      label: "Demonstration",
      description: "Fictional event",
      time: { earliest: null, latest: null },
      entityRefs: [s.records[0]!.ref],
    },
  });
  s = reviseKnowledge(c, s, {
    id: "claim",
    expectedRevision: 0,
    value: { ...claim, subjectRefs: [s.records[1]!.ref] },
  });
  assert.equal(s.visibility, "private");
  assert.deepEqual((s.records[1]!.value as { time: unknown }).time, {
    earliest: null,
    latest: null,
  });
  assert.equal((s.records[2]!.value as { assessment: null }).assessment, null);
  assert.equal(inspectKnowledge(c, s).length, 3);
});
test("changed assertions require exact current predecessor and retain earlier editions", () => {
  const initial = reviseKnowledge(c, createKnowledgeState(c), {
    id: "claim",
    expectedRevision: 0,
    value: claim,
  });
  const next = reviseKnowledge(c, initial, {
    id: "claim",
    expectedRevision: 1,
    value: { ...claim, text: "A later account challenges the stated time." },
  });
  assert.equal(initial.records.length, 1);
  assert.equal(next.records.length, 2);
  assert.deepEqual(next.records[1]!.supersedes, initial.records[0]!.ref);
  assert.throws(
    () =>
      reviseKnowledge(c, next, {
        id: "claim",
        expectedRevision: 1,
        value: claim,
      }),
    { code: "revision_conflict" },
  );
});
test("foreign/missing/stale subject editions cannot enter a new assertion", () => {
  const a = reviseKnowledge(c, createKnowledgeState(c), {
    id: "a",
    expectedRevision: 0,
    value: entity,
  });
  for (const ref of [
    { ...a.records[0]!.ref, projectId: "foreign" },
    { ...a.records[0]!.ref, revision: 2 },
  ])
    assert.throws(() =>
      reviseKnowledge(c, a, {
        id: "c",
        expectedRevision: 0,
        value: { ...claim, subjectRefs: [ref] },
      }),
    );
  const b = reviseKnowledge(c, a, {
    id: "a",
    expectedRevision: 1,
    value: { ...entity, label: "Witness A alias" },
  });
  assert.throws(
    () =>
      reviseKnowledge(c, b, {
        id: "c",
        expectedRevision: 0,
        value: { ...claim, subjectRefs: [a.records[0]!.ref] },
      }),
    { code: "stale_reference" },
  );
});
test("unknown/partial time stays explicit; malformed calendar and reversed intervals reject", () => {
  const event: KnowledgeValue = {
    type: "event",
    label: "Event",
    description: "Fictional event",
    time: { earliest: null, latest: "2026-01-02T00:00:00Z" },
    entityRefs: [],
  };
  assert.equal(
    reviseKnowledge(c, createKnowledgeState(c), {
      id: "e",
      expectedRevision: 0,
      value: event,
    }).records.length,
    1,
  );
  for (const time of [
    { earliest: "2026-01-03T00:00:00Z", latest: "2026-01-02T00:00:00Z" },
    { earliest: "2026-02-30T00:00:00Z", latest: null },
    { earliest: "yesterday", latest: null },
  ])
    assert.throws(() =>
      reviseKnowledge(c, createKnowledgeState(c), {
        id: "e",
        expectedRevision: 0,
        value: { ...event, time },
      }),
    );
});
test("host role/scope checks and immutable copies protect private inspection and appends", () => {
  const input = structuredClone(entity);
  const s = reviseKnowledge(c, createKnowledgeState(c), {
    id: "a",
    expectedRevision: 0,
    value: input,
  });
  (input as { label: string }).label = "changed";
  const rows = inspectKnowledge(c, s);
  (rows[0]!.value as { label: string }).label = "tampered";
  assert.equal((s.records[0]!.value as { label: string }).label, "Witness A");
  assert.throws(
    () =>
      inspectKnowledge({ ...c, actor: { ...c.actor, roles: ["viewer"] } }, s),
    { code: "forbidden" },
  );
  assert.throws(() => inspectKnowledge({ ...c, projectId: "foreign" }, s), {
    code: "scope_denied",
  });
});
test("proposed truth/legal/editorial decisions and extra fields cannot enter claim foundation", () => {
  for (const value of [
    { ...claim, assessment: "supported" },
    { ...claim, editorialApproval: true },
    { ...claim, guiltScore: 99 },
    { ...claim, proceduralPosture: "liable" },
  ])
    assert.throws(() =>
      reviseKnowledge(c, createKnowledgeState(c), {
        id: "c",
        expectedRevision: 0,
        value: value as unknown as KnowledgeValue,
      }),
    );
});
test("tampered serialized lineage, visibility and unknown fields fail closed", () => {
  const s = reviseKnowledge(c, createKnowledgeState(c), {
    id: "a",
    expectedRevision: 0,
    value: entity,
  });
  for (const state of [
    { ...s, visibility: "public" },
    { ...s, extra: true },
    {
      ...s,
      records: [
        { ...s.records[0]!, ref: { ...s.records[0]!.ref, revision: 2 } },
      ],
    },
  ])
    assert.throws(() => assertKnowledgeState(state as typeof s));
});
test("bounded text and append-only capacity reject without mutating input history", () => {
  const s = createKnowledgeState(c);
  assert.throws(() =>
    reviseKnowledge(c, s, {
      id: "c",
      expectedRevision: 0,
      value: { ...claim, text: "x".repeat(16001) },
    }),
  );
  assert.equal(s.records.length, 0);
  assert.throws(() =>
    reviseKnowledge(c, s, {
      id: "c",
      expectedRevision: 0,
      value: { ...claim, limitations: Array(65).fill("limit") },
    }),
  );
});

test("valid history at2048 revisions cannot silently evict a record to admit another", () => {
  const first = reviseKnowledge(c, createKnowledgeState(c), {
    id: "a",
    expectedRevision: 0,
    value: entity,
  }).records[0]!;
  const s = {
    ...createKnowledgeState(c),
    records: Array.from({ length: 2048 }, (_, i) => ({
      ...structuredClone(first),
      ref: { ...first.ref, id: "entity-" + i },
    })),
  };
  assertKnowledgeState(s);
  assert.throws(
    () =>
      reviseKnowledge(c, s, { id: "new", expectedRevision: 0, value: entity }),
    { code: "invalid_knowledge" },
  );
  assert.equal(s.records.length, 2048);
});
test("aggregate UTF8 budget is independent of per-field code-unit bounds", () => {
  const first = reviseKnowledge(c, createKnowledgeState(c), {
    id: "a",
    expectedRevision: 0,
    value: { ...entity, description: "𐀀".repeat(2000) },
  }).records[0]!;
  const s = {
    ...createKnowledgeState(c),
    records: Array.from({ length: 300 }, (_, i) => ({
      ...structuredClone(first),
      ref: { ...first.ref, id: "entity-" + i },
    })),
  };
  assert.throws(() => assertKnowledgeState(s), { code: "knowledge_full" });
});
test("historical exact links survive subject revision while new links must be deliberately current", () => {
  let s = reviseKnowledge(c, createKnowledgeState(c), {
    id: "a",
    expectedRevision: 0,
    value: entity,
  });
  const ref = s.records[0]!.ref;
  s = reviseKnowledge(c, s, {
    id: "c",
    expectedRevision: 0,
    value: { ...claim, subjectRefs: [ref] },
  });
  s = reviseKnowledge(c, s, {
    id: "a",
    expectedRevision: 1,
    value: { ...entity, label: "Later alias" },
  });
  assertKnowledgeState(s);
  assert.deepEqual(
    (s.records[1]!.value as { subjectRefs: unknown }).subjectRefs,
    [ref],
  );
  assert.throws(
    () =>
      reviseKnowledge(c, s, {
        id: "new",
        expectedRevision: 0,
        value: { ...claim, subjectRefs: [ref, ref] },
      }),
    { code: "invalid_reference" },
  );
});
test("extra reference fields, injected provenance/visibility and unsafe expected revisions reject", () => {
  const s = reviseKnowledge(c, createKnowledgeState(c), {
    id: "a",
    expectedRevision: 0,
    value: entity,
  });
  assert.throws(() =>
    reviseKnowledge(c, s, {
      id: "c",
      expectedRevision: 0,
      value: {
        ...claim,
        subjectRefs: [
          {
            ...s.records[0]!.ref,
            grant: "forged",
          } as (typeof s.records)[0]["ref"],
        ],
      },
    }),
  );
  for (const n of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(
      () =>
        reviseKnowledge(c, s, { id: "a", expectedRevision: n, value: entity }),
      { code: "invalid_revision" },
    );
  assert.throws(() =>
    reviseKnowledge(c, s, {
      id: "c",
      expectedRevision: 0,
      value: { ...claim, visibility: "public" } as unknown as KnowledgeValue,
    }),
  );
});
