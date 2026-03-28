import type {
  CodexAccountGroup,
  CodexAccountSessionLike,
} from "./account-groups.js";

export interface AccountSessionViewLike extends CodexAccountSessionLike {
  displayName?: string;
  email?: string;
  activity?: {
    requestCount: number;
    recentRequestCount1h?: number;
    recentRequestCount24h?: number;
    recentByClientTag5m?: Array<{
      clientTag: string;
      requestCount: number;
    }>;
    lastRequestAt?: number;
  };
  quota?: {
    scope?: "hourly" | "weekly";
    percentage?: number;
    resetAt?: number;
    windowMinutes?: number;
    updatedAt?: number;
  };
}

export type AccountSortKey = "default" | "name" | "quota" | "resetAt";
export type AccountSortDirection = "asc" | "desc";

export interface AccountActivitySummary {
  totalRequestCount1h: number;
  totalRequestCount24h: number;
  activeAccountCount1h: number;
  activeAccountCount24h: number;
  topClientTag5m?: {
    clientTag: string;
    requestCount: number;
  };
  topAccount1h?: {
    sessionId: string;
    title: string;
    requestCount: number;
  };
}

export function getSessionTitle(session: AccountSessionViewLike): string {
  return (
    session.email ??
    session.displayName ??
    session.accountId ??
    session.profileId
  );
}

export function getQuotaPercentage(
  session: AccountSessionViewLike,
): number | undefined {
  const value = session.quota?.percentage;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, value));
}

export function formatQuotaWindowLabel(session: AccountSessionViewLike): string {
  const quota = session.quota;
  if (!quota) {
    return "剩余额度";
  }

  if (typeof quota.windowMinutes === "number") {
    if (quota.windowMinutes >= 60 * 24 * 6) {
      return "剩余额度（7天）";
    }
    if (quota.windowMinutes >= 60) {
      return `剩余额度（${Math.round(quota.windowMinutes / 60)}小时）`;
    }
    return `剩余额度（${quota.windowMinutes}分钟）`;
  }

  return quota.scope === "weekly" ? "剩余额度（周）" : "剩余额度（小时）";
}

export function getQuotaToneClass(percentage?: number): string {
  if (typeof percentage !== "number") {
    return "quota-unknown";
  }
  if (percentage <= 20) {
    return "quota-low";
  }
  if (percentage <= 50) {
    return "quota-medium";
  }
  return "quota-high";
}

export function getAvatarToneIndex(id: string, toneCount = 12): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % toneCount;
}

export function buildAccountActivitySummary<
  TSession extends AccountSessionViewLike,
>(groups: CodexAccountGroup<TSession>[]): AccountActivitySummary {
  let totalRequestCount1h = 0;
  let totalRequestCount24h = 0;
  let activeAccountCount1h = 0;
  let activeAccountCount24h = 0;
  const clientTagCounts = new Map<string, number>();
  let topAccount1h: AccountActivitySummary["topAccount1h"];

  for (const group of groups) {
    let groupRequestCount1h = 0;
    let groupRequestCount24h = 0;

    for (const session of group.sessions) {
      const activity = session.activity;
      if (!activity) {
        continue;
      }

      groupRequestCount1h += activity.recentRequestCount1h ?? 0;
      groupRequestCount24h += activity.recentRequestCount24h ?? 0;

      for (const row of activity.recentByClientTag5m ?? []) {
        clientTagCounts.set(
          row.clientTag,
          (clientTagCounts.get(row.clientTag) ?? 0) + row.requestCount,
        );
      }
    }

    totalRequestCount1h += groupRequestCount1h;
    totalRequestCount24h += groupRequestCount24h;

    if (groupRequestCount1h > 0) {
      activeAccountCount1h += 1;
    }
    if (groupRequestCount24h > 0) {
      activeAccountCount24h += 1;
    }

    if (
      groupRequestCount1h > 0 &&
      (!topAccount1h ||
        groupRequestCount1h > topAccount1h.requestCount ||
        (groupRequestCount1h === topAccount1h.requestCount &&
          getSessionTitle(group.representative).localeCompare(
            topAccount1h.title,
            "zh-CN",
          ) < 0))
    ) {
      topAccount1h = {
        sessionId: group.representative.id,
        title: getSessionTitle(group.representative),
        requestCount: groupRequestCount1h,
      };
    }
  }

  const topClientTagEntry = [...clientTagCounts.entries()].sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }
    return left[0].localeCompare(right[0], "zh-CN");
  })[0];

  return {
    totalRequestCount1h,
    totalRequestCount24h,
    activeAccountCount1h,
    activeAccountCount24h,
    topClientTag5m: topClientTagEntry
      ? {
          clientTag: topClientTagEntry[0],
          requestCount: topClientTagEntry[1],
        }
      : undefined,
    topAccount1h,
  };
}

function compareOptionalNumbers(
  left: number | undefined,
  right: number | undefined,
  direction: AccountSortDirection,
): number {
  if (left === undefined && right === undefined) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  return direction === "asc" ? left - right : right - left;
}

export function matchesAccountSearch<
  TSession extends AccountSessionViewLike,
>(group: CodexAccountGroup<TSession>, query: string): boolean {
  if (!query) {
    return true;
  }

  const haystack = [
    getSessionTitle(group.representative),
    group.representative.email,
    group.representative.accountId,
    group.representative.profileId,
    ...group.sessions.map((session) => session.email),
    ...group.sessions.map((session) => session.accountId),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

  return haystack.includes(query);
}

export function sortAccountGroups<TSession extends AccountSessionViewLike>(
  groups: CodexAccountGroup<TSession>[],
  options: {
    search: string;
    sortKey: AccountSortKey;
    sortDirection: AccountSortDirection;
    pinnedSessionId?: string;
  },
): CodexAccountGroup<TSession>[] {
  const query = options.search.trim().toLowerCase();
  const filtered = groups.filter((group) => matchesAccountSearch(group, query));
  const sorted =
    options.sortKey === "default"
      ? [...filtered]
      : [...filtered].sort((left, right) => {
    let delta = 0;

    if (options.sortKey === "name") {
      delta =
        getSessionTitle(left.representative).localeCompare(
          getSessionTitle(right.representative),
          "zh-CN",
        ) * (options.sortDirection === "asc" ? 1 : -1);
    }

    if (options.sortKey === "quota") {
      delta = compareOptionalNumbers(
        left.representative.quota?.percentage,
        right.representative.quota?.percentage,
        options.sortDirection,
      );
    }

    if (options.sortKey === "resetAt") {
      delta = compareOptionalNumbers(
        left.representative.quota?.resetAt,
        right.representative.quota?.resetAt,
        options.sortDirection,
      );
    }

    if (delta === 0) {
      delta = getSessionTitle(left.representative).localeCompare(
        getSessionTitle(right.representative),
        "zh-CN",
      );
    }

    return delta;
  });

  const pinnedSessionId = options.pinnedSessionId?.trim();
  if (!pinnedSessionId) {
    return sorted;
  }

  const pinned: CodexAccountGroup<TSession>[] = [];
  const regular: CodexAccountGroup<TSession>[] = [];

  for (const group of sorted) {
    const isPinned = group.sessions.some(
      (session) => session.id === pinnedSessionId,
    );
    if (isPinned) {
      pinned.push(group);
      continue;
    }
    regular.push(group);
  }

  return [...pinned, ...regular];
}
