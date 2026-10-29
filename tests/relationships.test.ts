import test from "node:test";
import assert from "node:assert/strict";
import * as k from "../src/index.ts";
import type { Context } from "../src/contracts.ts";
const c: Context = {
  tenantId: "fiction",
  projectId: "review",
  actor: { id: "researcher", kind: "human", roles: ["researcher"] },
  purpose: "private-review",
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
};
const entity: k.KnowledgeValue = {
  type: "entity",
  label: "Fictional person",
  category: "person",
  description: "Unresolved identity",
};
function setup() {
  let state = k.createKnowledgeState(c);
  state = k.reviseKnowledge(c, state, {
    id: "person",
    expectedRevision: 0,
    value: entity,
  });
  state = k.reviseKnowledge(c, state, {
    id: "event",
    expectedRevision: 0,
    value: {
      type: "event",
      label: "Fictional meeting",
      description: "Unverified fixture",
      entityRefs: [],
      time: { earliest: null, latest: null },
    },
  });
  const value: Extract<k.KnowledgeValue, { type: "relationship" }> = {
    type: "relationship",
    relationshipType: "role_assertion",
    label: "Reported attendee",
    from: state.records[0]!.ref,
    to: state.records[1]!.ref,
    time: { earliest: null, latest: null },
    limitations: ["Attendance has not been independently verified"],
    assessment: null,
    proceduralPosture: null,
    editorialApproval: null,
  };
  return { state, q: { id: "role", expectedRevision: 0, value } };
}
const append = (x: ReturnType<typeof setup>) =>
  k.reviseKnowledge(c, x.state, x.q);
test("private unassessed role assertion retains exact entity/event editions and unknown time", () => {
  const x = setup(),
    s = append(x),
    r = s.records[2]!;
  assert.equal(r.ref.kind, "relationship");
  assert.equal(r.visibility, "private");
  assert.deepEqual((r.value as typeof x.q.value).time, {
    earliest: null,
    latest: null,
  });
  assert.deepEqual((r.value as typeof x.q.value).from, x.state.records[0]!.ref);
  assert.equal((r.value as typeof x.q.value).assessment, null);
  assert.equal(x.state.records.length, 2);
});
test("relationship revisions preserve predecessor and prior role/association descriptions", () => {
  const x = setup(),
    s = append(x);
  const next = k.reviseKnowledge(c, s, {
    ...x.q,
    expectedRevision: 1,
    value: {
      ...x.q.value,
      relationshipType: "association",
      label: "Unresolved contextual association",
    },
  });
  assert.deepEqual(next.records[3]!.supersedes, s.records[2]!.ref);
  assert.equal(
    (s.records[2]!.value as typeof x.q.value).relationshipType,
    "role_assertion",
  );
  assert.throws(
    () => k.reviseKnowledge(c, next, { ...x.q, expectedRevision: 1 }),
    { code: "revision_conflict" },
  );
});
test("current endpoints required on new assertions while historical endpoints remain unchanged", () => {
  const x = setup(),
    s = append(x);
  const changed = k.reviseKnowledge(c, s, {
    id: "person",
    expectedRevision: 1,
    value: { ...entity, description: "Updated identity description" },
  });
  k.assertKnowledgeState(changed);
  assert.throws(
    () => k.reviseKnowledge(c, changed, { ...x.q, expectedRevision: 1 }),
    { code: "stale_reference" },
  );
  const next = k.reviseKnowledge(c, changed, {
    ...x.q,
    expectedRevision: 1,
    value: { ...x.q.value, from: changed.records[3]!.ref },
  });
  assert.equal((next.records[4]!.value as typeof x.q.value).from.revision, 2);
  assert.equal((next.records[2]!.value as typeof x.q.value).from.revision, 1);
});
test("missing/foreign/wrong-kind/self endpoints and relation cycles cannot enter history", () => {
  const x = setup(),
    s = append(x);
  for (const value of [
    { ...x.q.value, from: { ...x.q.value.from, id: "absent" } },
    { ...x.q.value, to: { ...x.q.value.to, projectId: "foreign" } },
    { ...x.q.value, from: x.q.value.to },
    { ...x.q.value, to: x.q.value.from },
    { ...x.q.value, to: s.records[2]!.ref },
  ])
    assert.throws(() =>
      k.reviseKnowledge(c, s, { ...x.q, expectedRevision: 1, value }),
    );
  assert.equal(s.records.length, 3);
});
test("claims bind relationship editions explicitly; a revised relationship needs deliberate new claim linkage", () => {
  const x = setup(),
    s = append(x);
  const claim: Extract<k.KnowledgeValue, { type: "claim" }> = {
    type: "claim",
    text: "A fictional record attributes attendance.",
    subjectRefs: [s.records[2]!.ref],
    time: { earliest: null, latest: null },
    accountType: "document_assertion",
    limitations: ["Unverified attribution"],
    assessment: null,
    proceduralPosture: null,
    editorialApproval: null,
  };
  const withClaim = k.reviseKnowledge(c, s, {
    id: "attribution",
    expectedRevision: 0,
    value: claim,
  });
  const changed = k.reviseKnowledge(c, withClaim, {
    ...x.q,
    expectedRevision: 1,
    value: { ...x.q.value, label: "Disputed role attribution" },
  });
  k.assertKnowledgeState(changed);
  assert.throws(
    () =>
      k.reviseKnowledge(c, changed, {
        id: "attribution",
        expectedRevision: 1,
        value: claim,
      }),
    { code: "stale_reference" },
  );
  const next = k.reviseKnowledge(c, changed, {
    id: "attribution",
    expectedRevision: 1,
    value: { ...claim, subjectRefs: [changed.records[4]!.ref] },
  });
  assert.equal(
    (next.records[5]!.value as typeof claim).subjectRefs[0]!.revision,
    2,
  );
  assert.equal(
    (next.records[3]!.value as typeof claim).subjectRefs[0]!.revision,
    1,
  );
});
test("injected assessment/legal/editorial tracks, malformed intervals/limits and unauthorized callers deny", () => {
  const x = setup();
  for (const patch of [
    { assessment: "supported" },
    { proceduralPosture: "liable" },
    { editorialApproval: "approved" },
    { relationshipType: "verified" },
    { score: 1 },
    { time: { earliest: "2026-02-30T00:00:00Z", latest: null } },
    { label: "x".repeat(501) },
    { limitations: ["x".repeat(2001)] },
  ])
    assert.throws(() =>
      k.reviseKnowledge(c, x.state, {
        ...x.q,
        value: { ...x.q.value, ...patch } as typeof x.q.value,
      }),
    );
  assert.throws(
    () =>
      k.reviseKnowledge(
        { ...c, actor: { ...c.actor, roles: ["viewer"] } },
        x.state,
        x.q,
      ),
    { code: "forbidden" },
  );
  const s = append(x),
    read = k.inspectKnowledge(c, s);
  Object.assign(read[2]!.value, { label: "Detached" });
  assert.notEqual((s.records[2]!.value as typeof x.q.value).label, "Detached");
});

test("relationship-subject claim uses actual pinned Evidence links without promoting the relationship", async () => {
  const e = await import("@accountability/evidence");
  const links = await import("../src/evidence-links.ts");
  const x = setup(),
    s = append(x);
  const claim: Extract<k.KnowledgeValue, { type: "claim" }> = {
    type: "claim",
    text: "A fictional record attributes this role.",
    subjectRefs: [s.records[2]!.ref],
    time: { earliest: null, latest: null },
    accountType: "document_assertion",
    limitations: ["Literal attribution, not verified role"],
    assessment: null,
    proceduralPosture: null,
    editorialApproval: null,
  };
  const knowledge = k.reviseKnowledge(c, s, {
    id: "claim",
    expectedRevision: 0,
    value: claim,
  });
  let evidence = e.acquireEvidence(e.createEvidenceState(c), c, {
    id: "source",
    bytes: Buffer.from("Fictional attribution"),
    acquisitionId: "acq",
    storageVersionRef: "private-fixture-object",
    mediaType: "text/plain",
    sourceFamilyId: null,
    capturedAt: c.now,
    originalLanguage: "und",
    allowedPurposes: [c.purpose],
    supersedes: null,
  });
  const v = evidence.versions[0]!;
  evidence = e.beginScan(evidence, c, {
    id: "scan-start",
    evidence: v.ref,
    attemptId: "attempt",
    engineVersion: "synthetic-fixture-only",
  });
  evidence = e.completeScan(evidence, c, {
    id: "scan-end",
    evidence: v.ref,
    attemptId: "attempt",
    sha256: v.sha256,
    status: "clean",
    reason: "Synthetic test scan, not deployment qualification",
  });
  const linked = links.reviseEvidenceLinks(
    c,
    knowledge,
    evidence,
    links.createEvidenceLinksState(c),
    {
      claim: knowledge.records[3]!.ref,
      expectedRevision: 0,
      links: [
        {
          id: "citation",
          relation: "supports",
          selector: { kind: "whole", evidence: v.ref, sha256: v.sha256 },
        },
      ],
    },
  );
  assert.equal(
    links.reviewEvidenceLinks(
      c,
      knowledge,
      evidence,
      linked,
      linked.records[0]!.ref,
    ).sources.supports.independentFamilyCount,
    null,
  );
  assert.equal(
    (knowledge.records[2]!.value as typeof x.q.value).assessment,
    null,
  );
  assert.equal(
    (knowledge.records[3]!.value as typeof claim).editorialApproval,
    null,
  );
});

test("entity-to-entity association supports explicit partial time without identity merge", () => {
  const x = setup();
  const state = k.reviseKnowledge(c, x.state, {
    id: "organization",
    expectedRevision: 0,
    value: {
      type: "entity",
      label: "Fictional group",
      category: "organization",
      description: "Unverified group",
    },
  });
  const value: typeof x.q.value = {
    ...x.q.value,
    relationshipType: "association",
    to: state.records[2]!.ref,
    time: { earliest: "2026-01-01T00:00:00Z", latest: null },
  };
  const next = k.reviseKnowledge(c, state, { ...x.q, value });
  assert.equal((next.records[3]!.value as typeof value).to.kind, "entity");
  assert.equal((next.records[3]!.value as typeof value).time.latest, null);
  assert.equal(next.records.filter((r) => r.ref.kind === "entity").length, 2);
  assert.throws(
    () =>
      k.reviseKnowledge(c, state, {
        ...x.q,
        value: {
          ...value,
          time: {
            earliest: "2026-01-02T00:00:00Z",
            latest: "2026-01-01T00:00:00Z",
          },
        },
      }),
    { code: "invalid_time" },
  );
});
