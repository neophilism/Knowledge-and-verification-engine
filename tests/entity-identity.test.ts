import test from "node:test";
import assert from "node:assert/strict";
import * as k from "../src/index.ts";
import * as m from "../src/entity-identity.ts";
import type { Context } from "../src/contracts.ts";
const c: Context = {
  tenantId: "fiction",
  projectId: "review",
  actor: { id: "reviewer", kind: "human", roles: ["researcher"] },
  purpose: "review",
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
};
const entity: k.KnowledgeValue = {
  type: "entity",
  label: "Fictional person",
  category: "person",
  description: "Identity is ambiguous",
};
function setup() {
  let knowledge = k.createKnowledgeState(c);
  for (const id of ["a", "b", "c"])
    knowledge = k.reviseKnowledge(c, knowledge, {
      id,
      expectedRevision: 0,
      value: entity,
    });
  const q: m.EntityIdentityInput = {
    left: knowledge.records[0]!.ref,
    right: knowledge.records[1]!.ref,
    expectedRevision: 0,
    decision: "unresolved",
    rationale: "Same label alone is insufficient",
  };
  return { knowledge, state: m.createEntityIdentityState(c), q };
}
const append = (x: ReturnType<typeof setup>) =>
  m.recordEntityIdentity(c, x.knowledge, x.state, x.q);
test("private unresolved pair keeps independent entity IDs and source history unchanged", () => {
  const x = setup(),
    original = structuredClone(x.knowledge),
    s = append(x),
    r = m.inspectEntityIdentities(c, x.knowledge, s);
  assert.equal(r.latest[0]!.record.decision, "unresolved");
  assert.equal(r.latest[0]!.review, "current-editions");
  assert.deepEqual(x.knowledge, original);
  assert.equal(s.records[0]!.visibility, "private");
  assert.equal(x.state.records.length, 0);
});
test("same/different/unresolved changes are reversible without deleting decisions or rewriting entity refs", () => {
  const x = setup();
  const same = m.recordEntityIdentity(c, x.knowledge, x.state, {
    ...x.q,
    decision: "same",
  });
  const different = m.recordEntityIdentity(c, x.knowledge, same, {
    ...x.q,
    expectedRevision: 1,
    decision: "different",
    rationale: "Distinct contextual descriptions",
  });
  const unknown = m.recordEntityIdentity(c, x.knowledge, different, {
    ...x.q,
    expectedRevision: 2,
  });
  const r = m.inspectEntityIdentities(c, x.knowledge, unknown);
  assert.deepEqual(
    r.history.map((x) => x.decision),
    ["same", "different", "unresolved"],
  );
  assert.deepEqual(unknown.records[2]!.supersedes, unknown.records[1]!.ref);
  assert.equal(same.records.length, 1);
  assert.equal(r.latest[0]!.record.decision, "unresolved");
  assert.throws(
    () =>
      m.recordEntityIdentity(c, x.knowledge, unknown, {
        ...x.q,
        expectedRevision: 1,
      }),
    { code: "revision_conflict" },
  );
});
test("changed or absent entity editions require review; new decisions demand current exact entities", () => {
  const x = setup(),
    s = append(x);
  const knowledge = k.reviseKnowledge(c, x.knowledge, {
    id: "a",
    expectedRevision: 1,
    value: { ...entity, description: "Revised contextual detail" },
  });
  assert.equal(
    m.inspectEntityIdentities(c, knowledge, s).latest[0]!.review,
    "needs-review",
  );
  assert.throws(
    () =>
      m.recordEntityIdentity(c, knowledge, s, { ...x.q, expectedRevision: 1 }),
    { code: "stale_entity" },
  );
  const next = m.recordEntityIdentity(c, knowledge, s, {
    ...x.q,
    left: knowledge.records[3]!.ref,
    expectedRevision: 1,
  });
  assert.equal(
    m.inspectEntityIdentities(c, knowledge, next).latest[0]!.review,
    "current-editions",
  );
  assert.equal(
    m.inspectEntityIdentities(c, k.createKnowledgeState(c), s).latest[0]!
      .review,
    "needs-review",
  );
  assert.throws(
    () =>
      m.recordEntityIdentity(c, k.createKnowledgeState(c), s, {
        ...x.q,
        expectedRevision: 1,
      }),
    { code: "missing_reference" },
  );
});
test("pair identity is canonical and scoped, cannot compare self or accept foreign/nonentity/extra fields", () => {
  const x = setup();
  for (const q of [
    { ...x.q, left: x.q.right, right: x.q.left },
    { ...x.q, right: x.q.left },
    { ...x.q, left: { ...x.q.left, projectId: "other" } },
    { ...x.q, left: { ...x.q.left, kind: "claim" } },
    { ...x.q, left: { ...x.q.left, identity: "trusted" } },
    { ...x.q, decision: "verified" },
    { ...x.q, score: 1 },
  ])
    assert.throws(() =>
      m.recordEntityIdentity(
        c,
        x.knowledge,
        x.state,
        q as m.EntityIdentityInput,
      ),
    );
});
test("trusted human research role required; views check scope/role and return detached history", () => {
  const x = setup(),
    s = append(x);
  assert.throws(
    () =>
      m.recordEntityIdentity(
        { ...c, actor: { ...c.actor, kind: "agent" } },
        x.knowledge,
        x.state,
        x.q,
      ),
    { code: "human_review_required" },
  );
  assert.throws(
    () =>
      m.recordEntityIdentity(
        { ...c, actor: { ...c.actor, roles: ["viewer"] } },
        x.knowledge,
        x.state,
        x.q,
      ),
    { code: "forbidden" },
  );
  assert.throws(
    () =>
      m.inspectEntityIdentities({ ...c, projectId: "other" }, x.knowledge, s),
    { code: "scope_denied" },
  );
  const r = m.inspectEntityIdentities(c, x.knowledge, s);
  Object.assign(r.history[0]!, { rationale: "Changed detached result" });
  assert.notEqual(s.records[0]!.rationale, "Changed detached result");
});
test("contradictory transitive pairs stay explicit; no inferred merge group or permission", () => {
  const x = setup();
  let s = m.recordEntityIdentity(c, x.knowledge, x.state, {
    ...x.q,
    decision: "same",
  });
  s = m.recordEntityIdentity(c, x.knowledge, s, {
    ...x.q,
    left: x.knowledge.records[1]!.ref,
    right: x.knowledge.records[2]!.ref,
    decision: "same",
  });
  s = m.recordEntityIdentity(c, x.knowledge, s, {
    ...x.q,
    right: x.knowledge.records[2]!.ref,
    decision: "different",
  });
  const r = m.inspectEntityIdentities(c, x.knowledge, s);
  assert.deepEqual(
    r.latest.map((x) => x.record.decision),
    ["same", "same", "different"],
  );
  assert.equal(Object.hasOwn(r, "groups"), false);
  assert.equal(x.knowledge.records.length, 3);
});
test("512 record and aggregate UTF8 limits preserve history, malformed lineage/private stamps reject", () => {
  const x = setup(),
    s = append(x),
    one = s.records[0]!;
  const full: m.EntityIdentityState = {
    ...s,
    records: Array.from({ length: 512 }, (_, i) => ({
      ...structuredClone(one),
      ref: { ...one.ref, revision: i + 1 },
      supersedes: i ? { ...one.ref, revision: i } : null,
    })),
  };
  m.assertEntityIdentityState(full);
  assert.throws(
    () =>
      m.recordEntityIdentity(c, x.knowledge, full, {
        ...x.q,
        expectedRevision: 512,
      }),
    { code: "invalid_identity" },
  );
  assert.equal(full.records.length, 512);
  const huge = structuredClone(full);
  for (const r of huge.records)
    Object.assign(r, { rationale: "😀".repeat(2000) });
  assert.throws(() => m.assertEntityIdentityState(huge), {
    code: "identity_full",
  });
  for (const patch of [
    { visibility: "public" },
    { supersedes: one.ref },
    { createdAt: "2026-02-30T00:00:00Z" },
    { ref: { ...one.ref, id: "forged" } },
  ]) {
    const bad = structuredClone(s);
    Object.assign(bad.records[0]!, patch);
    assert.throws(() => m.assertEntityIdentityState(bad));
  }
});
