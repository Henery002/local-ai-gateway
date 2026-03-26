import type {
  CodexAccountGroup,
  CodexAccountSessionLike,
} from "./account-groups.js";

export interface AccountSessionViewLike extends CodexAccountSessionLike {
  displayName?: string;
  email?: string;
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
  },
): CodexAccountGroup<TSession>[] {
  const query = options.search.trim().toLowerCase();
  const filtered = groups.filter((group) => matchesAccountSearch(group, query));

  if (options.sortKey === "default") {
    return filtered;
  }

  return [...filtered].sort((left, right) => {
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
}
