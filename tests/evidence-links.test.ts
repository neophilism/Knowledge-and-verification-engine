import test from "node:test";
import assert from "node:assert/strict";
import * as e from "@accountability/evidence";
import * as k from "../src/index.ts";
import * as l from "../src/evidence-links.ts";
import type { Context } from "../src/contracts.ts";
const c: Context = {
  tenantId: "fixture",
  projectId: "private",
  actor: { id: "reviewer", kind: "human", roles: ["researcher"] },
  requestId: "request",
  purpose: "review",
  now: "2026-01-01T00:00:00Z",
};
const claim: k.KnowledgeValue = {
  type: "claim",
  text: "A fictional signal was observed.",
  subjectRefs: [],
  time: { earliest: null, latest: null },
  accountType: "attributed_testimony",
  limitations: ["Synthetic assertion only"],
  assessment: null,
  proceduralPosture: null,
  editorialApproval: null,
};
function setup(family: string | null = null) {
  let evidence = e.createEvidenceState(c);
  if (family)
    evidence = e.addSourceFamily(evidence, c, {
      id: family,
      label: family,
      parentIds: [],
      reason: "Fixture family",
    });
  evidence = add(evidence, "a", "A😀B fixture", family);
  const v = evidence.versions[0]!;
  evidence = e.addRepresentation(evidence, c, {
    id: "rep",
    evidence: v.ref,
    sourceSha256: v.sha256,
    text: "A😀B fixture",
    pages: ["A😀B fixture", "second"],
    durationMs: 1000,
    toolVersion: "fixture-parser",
  });
  const r = evidence.representations[0]!;
  const selector: e.EvidenceSelector = {
    kind: "text",
    evidence: v.ref,
    sha256: v.sha256,
    representationId: r.id,
    representationDigest: r.digest,
    page: null,
    start: 1,
    end: 3,
    quote: "😀",
  };
  const knowledge = k.reviseKnowledge(c, k.createKnowledgeState(c), {
    id: "claim",
    expectedRevision: 0,
    value: claim,
  });
  const q: l.EvidenceLinksCommand = {
    claim: knowledge.records[0]!.ref,
    expectedRevision: 0,
    links: [{ id: "citation", relation: "supports", selector }],
  };
  return {
    evidence,
    knowledge,
    selector,
    q,
    state: l.createEvidenceLinksState(c),
  };
}
function add(
  s: e.EvidenceState,
  id: string,
  text: string,
  family: string | null,
) {
  s = e.acquireEvidence(s, c, {
    id,
    bytes: Buffer.from(text),
    acquisitionId: "acq-" + id,
    storageVersionRef: "object-" + id,
    mediaType: "text/plain",
    sourceFamilyId: family,
    capturedAt: c.now,
    originalLanguage: "und",
    allowedPurposes: ["review"],
    supersedes: null,
  });
  const v = s.versions.at(-1)!;
  s = e.beginScan(s, c, {
    id: "start-" + id,
    evidence: v.ref,
    attemptId: "scan-" + id,
    engineVersion: "synthetic-only",
  });
  return e.completeScan(s, c, {
    id: "end-" + id,
    evidence: v.ref,
    attemptId: "scan-" + id,
    sha256: v.sha256,
    status: "clean",
    reason: "Synthetic test result, not malware qualification",
  });
}
function append(f: ReturnType<typeof setup>, q = f.q) {
  return l.reviseEvidenceLinks(c, f.knowledge, f.evidence, f.state, q);
}
function review(
  f: ReturnType<typeof setup>,
  s: l.EvidenceLinksState,
  evidence = f.evidence,
) {
  return l.reviewEvidenceLinks(
    c,
    f.knowledge,
    evidence,
    s,
    s.records.at(-1)!.ref,
  );
}
const code = (code: string) => ({ code });
test("actual pinned Evidence text/page/time/whole anchors bind private exact claim editions", () => {
  const f = setup();
  const a = f.selector as Extract<e.EvidenceSelector, { kind: "text" }>;
  const s = append(f, {
    ...f.q,
    links: [
      f.q.links[0]!,
      {
        id: "p",
        relation: "challenges",
        selector: {
          evidence: a.evidence,
          sha256: a.sha256,
          representationId: a.representationId,
          representationDigest: a.representationDigest,
          kind: "page",
          fromPage: 1,
          toPage: 2,
        },
      },
      {
        id: "t",
        relation: "quotes",
        selector: {
          evidence: a.evidence,
          sha256: a.sha256,
          representationId: a.representationId,
          representationDigest: a.representationDigest,
          kind: "time",
          startMs: 0,
          endMs: 1000,
        },
      },
      {
        id: "w",
        relation: "quotes",
        selector: { kind: "whole", evidence: a.evidence, sha256: a.sha256 },
      },
    ],
  });
  const r = review(f, s);
  assert.equal(r.revision.visibility, "private");
  assert.equal(r.sources.supports.sourceGroupCount, 1);
  assert.equal(r.sources.challenges.sourceGroupCount, 1);
  assert.equal(r.sources.quotes.sourceGroupCount, 1);
  assert.equal(r.sources.supports.independentFamilyCount, null);
  assert.equal(
    (f.knowledge.records[0]!.value as { assessment: null }).assessment,
    null,
  );
  assert.equal(f.state.records.length, 0);
});
test("fabricated quote, surrogate split, digest and out-of-bounds selectors reject without history", () => {
  const f = setup();
  const a = f.selector as Extract<e.EvidenceSelector, { kind: "text" }>;
  for (const selector of [
    { ...a, quote: "invented" },
    { ...a, start: 2, quote: "\uDE00" },
    { ...a, representationDigest: "0".repeat(64) },
    { ...a, sha256: "0".repeat(64) },
    { ...a, end: 9000 },
  ])
    assert.throws(
      () => append(f, { ...f.q, links: [{ ...f.q.links[0]!, selector }] }),
      code("invalid_selector"),
    );
  assert.equal(f.state.records.length, 0);
});
test("quarantine/integrity/purpose and newer Evidence revisions deny capture or review", () => {
  const f = setup();
  const s = append(f);
  const v = f.evidence.versions[0]!;
  const quarantined = e.quarantineEvidence(f.evidence, c, {
    id: "q",
    evidence: v.ref,
    reason: "Fixture hold",
  });
  assert.throws(() => review(f, s, quarantined), code("evidence_quarantined"));
  const corrupt = e.recordIntegrityCheck(f.evidence, c, {
    id: "bad",
    evidence: v.ref,
    bytes: Buffer.from("wrong"),
  });
  assert.throws(() => review(f, s, corrupt));
  assert.throws(
    () =>
      l.reviseEvidenceLinks(
        { ...c, purpose: "other" },
        f.knowledge,
        f.evidence,
        f.state,
        f.q,
      ),
    code("purpose_denied"),
  );
  const newer = e.acquireEvidence(f.evidence, c, {
    id: v.ref.id,
    bytes: Buffer.from("new"),
    acquisitionId: "acq-new",
    storageVersionRef: "object-new",
    mediaType: "text/plain",
    sourceFamilyId: null,
    capturedAt: c.now,
    originalLanguage: "und",
    allowedPurposes: ["review"],
    supersedes: v.ref,
  });
  assert.throws(() => review(f, s, newer), code("stale_revision"));
  assert.equal(l.inspectEvidenceLinks(c, s).length, 1);
});
test("dependency changes require explicit new links while original capture remains immutable", () => {
  const f = setup();
  const s = append(f);
  const original = structuredClone(s);
  const v = f.evidence.versions[0]!;
  const checked = e.recordIntegrityCheck(f.evidence, c, {
    id: "ok",
    evidence: v.ref,
    bytes: Buffer.from("A😀B fixture"),
  });
  assert.throws(() => review(f, s, checked), code("stale_evidence_links"));
  const next = l.reviseEvidenceLinks(c, f.knowledge, checked, s, {
    ...f.q,
    expectedRevision: 1,
  });
  assert.deepEqual(s, original);
  assert.deepEqual(next.records[1]!.supersedes, s.records[0]!.ref);
  assert.notEqual(
    next.records[0]!.links[0]!.fingerprint,
    next.records[1]!.links[0]!.fingerprint,
  );
  assert.throws(
    () =>
      l.reviewEvidenceLinks(
        c,
        f.knowledge,
        checked,
        next,
        next.records[0]!.ref,
      ),
    code("stale_links"),
  );
  assert.equal(
    l.reviewEvidenceLinks(c, f.knowledge, checked, next, next.records[1]!.ref)
      .sources.supports.sourceGroupCount,
    1,
  );
});
test("copies/mirrors never inflate support; contrary evidence has a separate analysis", () => {
  const f = setup("root");
  let evidence = e.addSourceFamily(f.evidence, c, {
    id: "mirror",
    label: "Mirror",
    parentIds: ["root"],
    reason: "Fixture copy",
  });
  evidence = add(evidence, "copy", "A😀B fixture", "mirror");
  evidence = add(evidence, "contrary", "Different account", null);
  const links: l.EvidenceLinkInput[] = [
    f.q.links[0]!,
    ...evidence.versions
      .slice(1)
      .map((v, i) => ({
        id: v.ref.id,
        relation: i === 0 ? ("supports" as const) : ("challenges" as const),
        selector: { kind: "whole" as const, evidence: v.ref, sha256: v.sha256 },
      })),
  ];
  const s = l.reviseEvidenceLinks(c, f.knowledge, evidence, f.state, {
    ...f.q,
    links,
  });
  const r = review(f, s, evidence);
  assert.equal(r.sources.supports.sourceGroupCount, 1);
  assert.equal(r.sources.supports.uniqueByteCount, 1);
  assert.equal(r.sources.challenges.sourceGroupCount, 1);
  assert.equal(r.sources.challenges.independentFamilyCount, null);
  assert.equal(r.sources.quotes.sourceGroupCount, 0);
});
test("current human independence records can change analysis without asserting truth", () => {
  const f = setup("root");
  let evidence = e.addSourceFamily(f.evidence, c, {
    id: "other",
    label: "Other",
    parentIds: [],
    reason: "Fixture",
  });
  evidence = add(evidence, "b", "Different bytes", "other");
  const v = evidence.versions[1]!;
  const q = {
    ...f.q,
    links: [
      ...f.q.links,
      {
        id: "b",
        relation: "supports" as const,
        selector: { kind: "whole" as const, evidence: v.ref, sha256: v.sha256 },
      },
    ],
  };
  const s = l.reviseEvidenceLinks(c, f.knowledge, evidence, f.state, q);
  assert.equal(
    review(f, s, evidence).sources.supports.independentFamilyCount,
    null,
  );
  evidence = e.recordFamilyIndependence(evidence, c, {
    id: "independent",
    familyIds: ["root", "other"],
    rationale: "Synthetic human assessment",
  });
  const r = review(f, s, evidence);
  assert.equal(r.sources.supports.independentFamilyCount, 2);
  assert.equal(r.revision.links.length, 2);
  assert.equal(
    (f.knowledge.records[0]!.value as { assessment: null }).assessment,
    null,
  );
});
test("current claim revision and scope/role are mandatory; historical inspection is explicitly separate", () => {
  const f = setup();
  const s = append(f);
  const knowledge = k.reviseKnowledge(c, f.knowledge, {
    id: "claim",
    expectedRevision: 1,
    value: { ...claim, text: "Changed assertion" },
  });
  assert.throws(
    () => l.reviewEvidenceLinks(c, knowledge, f.evidence, s, s.records[0]!.ref),
    code("stale_claim"),
  );
  assert.throws(
    () =>
      l.reviseEvidenceLinks(c, knowledge, f.evidence, s, {
        ...f.q,
        expectedRevision: 1,
      }),
    code("stale_claim"),
  );
  const next = l.reviseEvidenceLinks(c, knowledge, f.evidence, s, {
    ...f.q,
    claim: knowledge.records[1]!.ref,
    expectedRevision: 1,
  });
  assert.equal(next.records[1]!.claim.revision, 2);
  assert.equal(s.records[0]!.claim.revision, 1);
  assert.throws(
    () => l.inspectEvidenceLinks({ ...c, projectId: "other" }, s),
    code("scope_denied"),
  );
  assert.throws(
    () =>
      l.inspectEvidenceLinks(
        { ...c, actor: { ...c.actor, roles: ["viewer"] } },
        s,
      ),
    code("forbidden"),
  );
  const selected = { ...s.records[0]!.ref, projectId: "other" };
  assert.throws(() =>
    l.reviewEvidenceLinks(c, f.knowledge, f.evidence, s, selected),
  );
});
test("exact profiles, duplicate links, injected approvals and captured-state tampering deny", () => {
  const f = setup();
  const bad = (q: unknown) =>
    assert.throws(() => append(f, q as l.EvidenceLinksCommand));
  bad({ ...f.q, assessment: "verified" });
  bad({ ...f.q, links: [{ ...f.q.links[0]!, approval: true }] });
  bad({
    ...f.q,
    links: [
      { ...f.q.links[0]!, selector: { ...f.selector, command: "publish" } },
    ],
  });
  bad({
    ...f.q,
    links: [f.q.links[0]!, { ...f.q.links[0]!, id: "duplicate-selector" }],
  });
  bad({
    ...f.q,
    links: [
      {
        ...f.q.links[0]!,
        selector: {
          ...f.selector,
          evidence: { ...f.selector.evidence, projectId: "other" },
        },
      },
    ],
  });
  bad({ ...f.q, expectedRevision: -1 });
  const s = append(f);
  for (const update of [
    { visibility: "public" },
    { supersedes: s.records[0]!.ref },
    { claim: { ...f.q.claim, revision: 0 } },
  ]) {
    const changed = structuredClone(s);
    Object.assign(changed.records[0]!, update);
    assert.throws(() => l.assertEvidenceLinksState(changed));
  }
  const read = l.inspectEvidenceLinks(c, s);
  (read[0]!.links as l.EvidenceLink[]).length = 0;
  assert.equal(s.records[0]!.links.length, 1);
  const changed = structuredClone(s);
  (changed.records[0]!.links[0]!.family.roots as string[]).push("forged");
  assert.throws(() => review(f, changed), code("stale_evidence_links"));
});
