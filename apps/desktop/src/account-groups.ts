export type CodexAccountSessionStatus = "available" | "expired" | "invalid";
export type CodexAccountSourceKind = "openclaw" | "local-import";

export interface CodexAccountSessionLike {
  id: string;
  profileId: string;
  accountId?: string;
  status: CodexAccountSessionStatus;
  expiresAt?: number;
  sourceKind?: CodexAccountSourceKind;
  sourceLabel?: string;
}

export interface CodexAccountGroup<TSession extends CodexAccountSessionLike = CodexAccountSessionLike> {
  key: string;
  sourceKind: CodexAccountSourceKind;
  sourceLabel: string;
  displayName: string;
  sessions: TSession[];
  representative: TSession;
  isActive: boolean;
}

export interface CodexAccountGroupSummary<TSession extends CodexAccountSessionLike = CodexAccountSessionLike> {
  total: number;
  openclaw: number;
  localImport: number;
  groups: CodexAccountGroup<TSession>[];
}

function rankSessionStatus(status: CodexAccountSessionStatus): number {
  if (status === "available") {
    return 3;
  }
  if (status === "expired") {
    return 2;
  }
  return 1;
}

function normalizeSourceKind(session: CodexAccountSessionLike): CodexAccountSourceKind {
  return session.sourceKind === "local-import" ? "local-import" : "openclaw";
}

function defaultSourceLabel(sourceKind: CodexAccountSourceKind): string {
  return sourceKind === "local-import" ? "桌面端 Codex 账号" : "外部可复用授权";
}

function getLogicalAccountKey(session: CodexAccountSessionLike, sourceKind: CodexAccountSourceKind): string {
  const accountId = session.accountId?.trim();
  if (accountId) {
    return accountId;
  }

  if (sourceKind === "local-import") {
    return session.profileId.trim() || session.id;
  }

  return session.id;
}

function compareAccountGroups<TSession extends CodexAccountSessionLike>(
  left: CodexAccountGroup<TSession>,
  right: CodexAccountGroup<TSession>,
): number {
  if (left.isActive !== right.isActive) {
    return left.isActive ? -1 : 1;
  }

  const statusDelta = rankSessionStatus(right.representative.status) - rankSessionStatus(left.representative.status);
  if (statusDelta !== 0) {
    return statusDelta;
  }

  const expiryDelta = (right.representative.expiresAt ?? 0) - (left.representative.expiresAt ?? 0);
  if (expiryDelta !== 0) {
    return expiryDelta;
  }

  return left.displayName.localeCompare(right.displayName, "zh-CN");
}

export function buildCodexAccountGroups<TSession extends CodexAccountSessionLike>(
  sessions: TSession[],
  activeSessionId?: string,
): CodexAccountGroupSummary<TSession> {
  const groups = new Map<
    string,
    {
      sourceKind: CodexAccountSourceKind;
      sourceLabel: string;
      displayName: string;
      sessions: TSession[];
    }
  >();

  for (const session of sessions) {
    const sourceKind = normalizeSourceKind(session);
    const sourceLabel = defaultSourceLabel(sourceKind);
    const accountKey = getLogicalAccountKey(session, sourceKind);
    const groupKey = `${sourceKind}:${accountKey}`;
    const existing = groups.get(groupKey);

    if (existing) {
      existing.sessions.push(session);
      continue;
    }

    groups.set(groupKey, {
      sourceKind,
      sourceLabel,
      displayName: session.accountId?.trim() || session.profileId || session.id,
      sessions: [session],
    });
  }

  const aggregated = Array.from(groups.entries())
    .map(([key, group]) => {
      const representative =
        group.sessions.find((session) => session.id === activeSessionId) ??
        [...group.sessions].sort((left, right) => {
          const statusDelta = rankSessionStatus(right.status) - rankSessionStatus(left.status);
          if (statusDelta !== 0) {
            return statusDelta;
          }
          return (right.expiresAt ?? 0) - (left.expiresAt ?? 0);
        })[0];

      return {
        key,
        ...group,
        representative,
        isActive: group.sessions.some((session) => session.id === activeSessionId),
      };
    })
    .sort(compareAccountGroups);

  return {
    total: aggregated.length,
    openclaw: aggregated.filter((group) => group.sourceKind === "openclaw").length,
    localImport: aggregated.filter((group) => group.sourceKind === "local-import").length,
    groups: aggregated,
  };
}
