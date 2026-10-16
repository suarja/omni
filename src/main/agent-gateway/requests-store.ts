import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  parseApprovalReason,
  type ApprovalReason,
  parseAgentApplyOutcome,
  parseAgentWriteRequest,
  type AgentConsent,
  type AgentApplyOutcome,
  type AgentRequest,
  type AgentWriteRequest,
  type AgentPlan,
} from "../../shared/agents-ipc";
import { parseSkillIntent, type SkillIntent } from "../../shared/skill-management-ipc";
import type { ApprovalMode } from "../../shared/settings-ipc";
import {
  readAgentRequestsState,
  writeAgentRequestsState as writeAtomically,
  type AgentRequestsState as State,
} from "./requests-file";

export type RequestInput = Readonly<{
  requestId?: string;
  intentId?: string;
  skillIntent?: SkillIntent;
  request?: AgentWriteRequest;
  plan: AgentPlan;
  createdAt?: string;
  expiresAt?: string;
  harness?: "claude-code" | "codex";
  sessionName?: string;
  cwd?: string;
  approval?: ApprovalMode;
  approvalReason?: ApprovalReason;
}>;
export type AgentRequestsStore = Readonly<{
  onChanged(listener: (requests: readonly AgentRequest[]) => void): () => void;
  list(): Promise<readonly AgentRequest[]>;
  all(): Promise<readonly AgentRequest[]>;
  create(input: RequestInput): Promise<AgentRequest>;
  refresh(requestId: string, input: RequestInput): Promise<AgentRequest>;
  linkSkillIntent(requestId: string, intentId: string, skillIntent: SkillIntent): Promise<AgentRequest>;
  acquireApplyAuthorization(requestId: string): Promise<Readonly<{ leaseId: string; approvedAt: string }>>;
  releaseApplyAuthorization(requestId: string, leaseId: string): Promise<void>;
  resolve(requestId: string, operationId: string, consent?: AgentConsent): Promise<AgentRequest>;
  recordApplyOutcome(
    requestId: string,
    receiptIds: readonly string[],
    outcome: AgentApplyOutcome,
    consent?: AgentConsent,
    leaseId?: string,
  ): Promise<AgentRequest>;
  decline(requestId: string): Promise<AgentRequest>;
  get(requestId: string): Promise<AgentRequest | undefined>;
  wait(requestId: string, maxMs: number): Promise<AgentRequest | undefined>;
}>;

// Serialized for older readers only; this timestamp never authorizes or expires a request.
const LEGACY_EXPIRES_AFTER_MS = 10 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

export function waitForRequestChange<T>(
  getRequest: () => Promise<T | undefined>,
  subscribe: (listener: () => void) => () => void,
  isPending: (request: T) => boolean,
  timeoutMs: (request: T) => number,
): Promise<T | undefined> {
  return getRequest().then((initial) => {
    if (!initial || !isPending(initial)) return initial;
    return new Promise<T | undefined>((resolvePromise, rejectPromise) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;
      let settled = false;
      let checking = false;
      let checkAgain = false;
      let finishOnNextRead = false;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        try {
          unsubscribe?.();
        } catch {
          // Listener cleanup must not change the stored request result.
        }
      };
      const finish = (request: T | undefined): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(request);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(error);
      };
      const inspect = async (finishIfPending = false): Promise<void> => {
        if (finishIfPending) finishOnNextRead = true;
        if (settled) return;
        if (checking) {
          checkAgain = true;
          return;
        }
        checking = true;
        try {
          do {
            checkAgain = false;
            const forceFinish = finishOnNextRead;
            finishOnNextRead = false;
            const current = await getRequest();
            if (!current || forceFinish || !isPending(current)) {
              finish(current);
              return;
            }
          } while (checkAgain && !settled);
        } catch (error: unknown) {
          fail(error);
        } finally {
          checking = false;
        }
      };
      const notify = (): void => {
        void inspect();
      };
      unsubscribe = subscribe(notify);
      if (settled) {
        cleanup();
        return;
      }
      timer = setTimeout(() => void inspect(true), Math.max(0, timeoutMs(initial)));
      void inspect();
    });
  });
}

function requestId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new Error("Request id is invalid.");
  return value;
}
export function createAgentRequestsStore(filePath: string, now: () => number = Date.now): AgentRequestsStore {
  const path = resolve(filePath);
  let state: State | undefined;
  let loading: Promise<State> | undefined;
  let queue = Promise.resolve();
  const listeners = new Set<() => void>();
  const changeListeners = new Set<(requests: readonly AgentRequest[]) => void>();
  const applyLeases = new Map<string, Readonly<{ leaseId: string; approvedAt: string }>>();
  const load = async (): Promise<State> => {
    if (state) return state;
    if (!loading) {
      loading = readAgentRequestsState(path)
        .then((loaded) => {
          const cutoff = now() - RETENTION_MS;
          state = {
            schemaVersion: 1,
            requests: loaded.requests.filter(
              (item) => item.status === "pending" || new Date(item.consent?.at ?? item.createdAt).getTime() >= cutoff,
            ),
          };
          return state;
        })
        .finally(() => {
          loading = undefined;
        });
    }
    return loading;
  };
  const serialize = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    const task = queue.then(fn);
    queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
  const notify = (): void => {
    for (const listener of listeners) listener();
    for (const listener of changeListeners) listener(state?.requests ?? []);
  };
  const mutate = async (fn: (current: State) => State): Promise<void> =>
    serialize(async () => {
      const loaded = await load();
      const next = fn(loaded);
      if (next === loaded) return;
      await writeAtomically(path, next);
      state = next;
      notify();
    });
  const current = async (): Promise<State> => {
    const loaded = await load();
    const cutoff = now() - RETENTION_MS;
    if (
      loaded.requests.some(
        (item) =>
          item.status === "awaiting-agent" &&
          new Date(item.createdAt).getTime() < cutoff &&
          !applyLeases.has(item.requestId),
      )
    ) {
      await mutate((latest) => ({
        schemaVersion: 1,
        requests: latest.requests.filter(
          (item) =>
            item.status !== "awaiting-agent" ||
            new Date(item.createdAt).getTime() >= cutoff ||
            applyLeases.has(item.requestId),
        ),
      }));
    }
    return state ?? loaded;
  };
  const get = async (id: string): Promise<AgentRequest | undefined> =>
    (await current()).requests.find((item) => item.requestId === requestId(id));
  const update = async (
    id: string,
    fn: (item: AgentRequest) => AgentRequest,
    assertState?: (item: AgentRequest) => void,
  ): Promise<AgentRequest> => {
    const safeId = requestId(id);
    let result: AgentRequest | undefined;
    await mutate((loaded) => {
      if (applyLeases.has(safeId)) throw new Error("Agent request apply is already in progress.");
      const found = loaded.requests.find((item) => item.requestId === safeId);
      if (!found) throw new Error("This request is no longer available; preview it again.");
      assertState?.(found);
      if (found.status !== "pending" && found.status !== "awaiting-agent") {
        result = found;
        return loaded;
      }
      result = fn(found);
      return {
        schemaVersion: 1,
        requests: loaded.requests.map((item) => (item.requestId === safeId ? result! : item)),
      };
    });
    if (!result) throw new Error("This request is no longer available; preview it again.");
    return result;
  };
  return {
    list: async () =>
      (await current()).requests.filter((item) => item.status === "pending" && item.approval === "omni"),
    all: async () => (await current()).requests,
    create: async (input) => {
      const createdAt = input.createdAt ?? new Date(now()).toISOString();
      const expiresAt = input.expiresAt ?? new Date(now() + LEGACY_EXPIRES_AFTER_MS).toISOString();
      if (!input.request) throw new Error("Agent request payload is required.");
      const item: AgentRequest = {
        requestId: input.requestId === undefined ? randomUUID() : requestId(input.requestId),
        createdAt,
        expiresAt,
        ...(input.harness ? { harness: input.harness } : {}),
        ...(input.sessionName ? { sessionName: input.sessionName } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        request: parseAgentWriteRequest(input.request),
        plan: input.plan,
        approval: input.approval ?? "omni",
        ...(input.approvalReason ? { approvalReason: parseApprovalReason(input.approvalReason) } : {}),
        status: (input.approval ?? "omni") === "conversation" ? "awaiting-agent" : "pending",
        ...(input.intentId === undefined ? {} : { intentId: requestId(input.intentId) }),
        ...(input.skillIntent === undefined ? {} : { skillIntent: parseSkillIntent(input.skillIntent) }),
      };
      if ((item.intentId === undefined) !== (item.skillIntent === undefined))
        throw new Error("Agent skill intent reference is incomplete.");
      await mutate((loaded) => {
        if (loaded.requests.some((candidate) => candidate.requestId === item.requestId))
          throw new Error("Agent request id is already in use.");
        return { schemaVersion: 1, requests: [item, ...loaded.requests] };
      });
      return item;
    },
    refresh: (id, input) =>
      update(
        id,
        (item) => ({
          ...item,
          plan: input.plan,
          approvalReason: input.approvalReason,
          ...(input.intentId ? { intentId: input.intentId, skillIntent: input.skillIntent } : {}),
        }),
        (item) => {
          if (item.status !== "pending") throw new Error("Only pending requests can be refreshed.");
        },
      ),
    linkSkillIntent: (id, intentId, skillIntent) =>
      update(id, (item) => {
        const parsedIntent = parseSkillIntent(skillIntent);
        if (item.intentId || item.skillIntent) {
          if (
            item.intentId === requestId(intentId) &&
            JSON.stringify(item.skillIntent) === JSON.stringify(parsedIntent)
          )
            return item;
          throw new Error("Agent request is already linked to another skill operation.");
        }
        return { ...item, intentId: requestId(intentId), skillIntent: parsedIntent };
      }),
    acquireApplyAuthorization: async (id) => {
      await current();
      return serialize(async () => {
        const safeId = requestId(id);
        if (applyLeases.has(safeId)) throw new Error("Agent request apply is already in progress.");
        const loaded = await load();
        const found = loaded.requests.find((item) => item.requestId === safeId);
        if (!found) throw new Error("This request is no longer available; preview it again.");
        if (found.status !== "pending" && found.status !== "awaiting-agent")
          throw new Error("Agent request cannot begin applying.");
        const nowMs = now();
        const approvedAt = new Date(nowMs).toISOString();
        const lease = { leaseId: randomUUID(), approvedAt } as const;
        applyLeases.set(safeId, lease);
        return lease;
      });
    },
    releaseApplyAuthorization: async (id, leaseId) =>
      serialize(() => {
        const safeId = requestId(id);
        const active = applyLeases.get(safeId);
        if (!active) return;
        if (active.leaseId !== requestId(leaseId)) throw new Error("Agent apply lease does not match.");
        applyLeases.delete(safeId);
      }),
    resolve: (id, operationId, consent) =>
      update(id, (item) => ({
        ...item,
        status: "approved",
        receiptId: requestId(operationId),
        consent: consent ?? {
          mode: item.approval,
          at: new Date(now()).toISOString(),
          ...(item.harness ? { harness: item.harness } : {}),
          ...(item.sessionName ? { sessionName: item.sessionName } : {}),
        },
      })),
    recordApplyOutcome: async (id, receiptIds, outcome, consent, leaseId) => {
      const safeId = requestId(id);
      const safeReceiptIds = receiptIds.map((value) => requestId(value));
      const safeOutcome = parseAgentApplyOutcome(outcome);
      if (
        (safeReceiptIds.length === 0 && ["applied", "partial", "restored"].includes(safeOutcome.status)) ||
        (safeOutcome.status === "no-op" && safeReceiptIds.length > 0) ||
        new Set(safeReceiptIds).size !== safeReceiptIds.length
      )
        throw new Error("Agent apply receipt references are invalid.");
      return serialize(async () => {
        const loaded = await load();
        const found = loaded.requests.find((item) => item.requestId === safeId);
        if (!found) throw new Error("This request is no longer available; preview it again.");
        const activeLease = applyLeases.get(safeId);
        if (activeLease && activeLease.leaseId !== leaseId) throw new Error("Agent apply lease does not match.");
        if (leaseId && activeLease?.leaseId !== leaseId) throw new Error("Agent apply lease is unavailable.");
        const sameOutcome =
          JSON.stringify(found.receiptIds ?? (found.receiptId ? [found.receiptId] : [])) ===
            JSON.stringify(safeReceiptIds) && JSON.stringify(found.applyOutcome) === JSON.stringify(safeOutcome);
        if (found.applyOutcome) {
          if (sameOutcome) return found;
          throw new Error("Agent request already has a terminal apply outcome.");
        }
        if (
          found.status !== "approved" &&
          found.status !== "pending" &&
          found.status !== "awaiting-agent" &&
          found.status !== "expired"
        )
          throw new Error("Agent request cannot record an apply outcome.");
        if (found.status !== "approved" && (!activeLease || activeLease.leaseId !== leaseId))
          throw new Error("An active apply lease is required to complete this request.");
        const authorization = consent ?? found.consent;
        if (!authorization) throw new Error("Explicit consent is required to record an apply outcome.");
        if (activeLease && authorization.at !== activeLease.approvedAt)
          throw new Error("Agent apply consent does not match the active lease.");
        const authorizedAt = new Date(authorization.at).getTime();
        const createdAt = new Date(found.createdAt).getTime();
        const expectedHarness =
          found.harness ?? (found.request.kind === "write-skill" ? found.request.agent?.harness : undefined);
        const expectedSession =
          found.sessionName ?? (found.request.kind === "write-skill" ? found.request.agent?.sessionName : undefined);
        if (
          !Number.isFinite(authorizedAt) ||
          new Date(authorizedAt).toISOString() !== authorization.at ||
          authorization.mode !== found.approval ||
          authorizedAt < createdAt ||
          authorizedAt > now() ||
          authorization.harness !== expectedHarness ||
          authorization.sessionName !== expectedSession
        )
          throw new Error("Agent apply consent does not match the request authorization.");
        const representative = safeReceiptIds.at(-1);
        if (found.receiptId && found.receiptId !== representative)
          throw new Error("Agent request already references a different receipt.");
        const updated: AgentRequest = {
          ...found,
          status: "approved",
          ...(representative ? { receiptId: representative } : { receiptId: undefined }),
          receiptIds: safeReceiptIds,
          applyOutcome: safeOutcome,
          consent: found.consent ?? authorization,
        };
        const next: State = {
          schemaVersion: 1,
          requests: loaded.requests.map((item) => (item.requestId === safeId ? updated : item)),
        };
        await writeAtomically(path, next);
        state = next;
        if (activeLease) applyLeases.delete(safeId);
        notify();
        return updated;
      });
    },
    onChanged: (listener) => {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
    decline: (id) => update(id, (item) => ({ ...item, status: "declined" })),
    get,
    wait: (id, maxMs) =>
      waitForRequestChange(
        () => get(id),
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        (item) => item.status === "pending",
        () => maxMs,
      ),
  };
}
