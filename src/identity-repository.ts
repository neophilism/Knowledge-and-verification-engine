import type { MembershipRegistry } from "@accountability/identity-policy/membership";
import { digest, invariant, nonempty, requireScope } from "./contracts.ts";
import type { Context, Scope } from "./contracts.ts";
import type { KnowledgeRepository, KnowledgeAppend } from "./repository.ts";
export const KNOWLEDGE_RESOURCE_ID = digest({
  kind: "knowledge-private-history-v1",
});
/** Explicit opt-in; host authenticates human kind/id. Current stored roles replace incoming roles. */
export class IdentityKnowledgeRepository {
  readonly #resolve: MembershipRegistry["resolveResource"];
  readonly #load: KnowledgeRepository["load"];
  readonly #append: KnowledgeRepository["append"];
  readonly #policy: Scope & Readonly<{ purpose: string }>;
  readonly #timeout: number;
  constructor(
    repository: KnowledgeRepository,
    membership: MembershipRegistry,
    policy: Scope & Readonly<{ purpose: string }>,
    timeoutMs = 10000,
  ) {
    this.#resolve = membership.resolveResource.bind(membership);
    this.#load = repository.load.bind(repository);
    this.#append = repository.append.bind(repository);
    this.#policy = structuredClone(policy);
    this.#timeout = timeoutMs;
    nonempty(this.#policy.tenantId, "Tenant", 128);
    nonempty(this.#policy.projectId, "Project", 128);
    nonempty(this.#policy.purpose, "Purpose", 128);
    invariant(
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
      "invalid_policy",
      "Bounded Identity acceptance budget required",
    );
  }
  async #context(context: Context, signal?: AbortSignal): Promise<Context> {
    const started = performance.now(),
      c = structuredClone(context);
    requireScope(this.#policy, c);
    invariant(
      c.actor.kind === "human" && c.purpose === this.#policy.purpose,
      "forbidden",
      "Human and fixed purpose required",
    );
    // Caller roles have no authority. Begun Identity SQL is awaited, never raced or terminated.
    const principal = { ...c, actor: { ...c.actor, roles: [] } };
    const admitted = () =>
      !signal?.aborted && performance.now() - started < this.#timeout;
    invariant(
      admitted(),
      "identity_unavailable",
      "Current Identity observation unavailable",
    );
    let resolved: Awaited<ReturnType<MembershipRegistry["resolveResource"]>>;
    try {
      resolved = structuredClone(
        await this.#resolve(principal, KNOWLEDGE_RESOURCE_ID, "investigate"),
      );
    } catch {
      invariant(
        false,
        "identity_unavailable",
        "Current Identity observation unavailable",
      );
    }
    invariant(
      admitted(),
      "identity_unavailable",
      "Current Identity observation unavailable",
    );
    const actual = resolved.context;
    requireScope(this.#policy, actual);
    invariant(
      resolved.resourceId === KNOWLEDGE_RESOURCE_ID &&
        actual.actor.kind === "human" &&
        actual.actor.id === c.actor.id &&
        actual.purpose === c.purpose &&
        actual.requestId === c.requestId,
      "identity_unavailable",
      "Current Identity binding unavailable",
    );
    return actual;
  }
  async load(context: Context, signal?: AbortSignal) {
    return this.#load(await this.#context(context, signal));
  }
  async append(
    context: Context,
    expectedStorageRevision: number,
    command: KnowledgeAppend,
    commandId: string,
    signal?: AbortSignal,
  ) {
    const q = structuredClone(command);
    return this.#append(
      await this.#context(context, signal),
      expectedStorageRevision,
      q,
      commandId,
    );
  }
}
