export type AccountSelectionLike<TSession extends AccountSessionLike> = {
  key: string;
  sessions: readonly TSession[];
};

export type AccountSessionLike = {
  id: string;
  profileId?: string;
  accountId?: string;
};

export type AccountDeletionTarget = {
  sessionId: string;
  profileId?: string;
  accountId?: string;
};

export function normalizeAccountSelection<
  TAccount extends { key: string },
>(
  accounts: readonly TAccount[],
  selectedKeys: Iterable<string>,
): Set<string> {
  const availableKeys = new Set(accounts.map((account) => account.key));
  const normalized = new Set<string>();
  for (const key of selectedKeys) {
    if (availableKeys.has(key)) {
      normalized.add(key);
    }
  }
  return normalized;
}

export function collectAccountDeletionTargets<
  TSession extends AccountSessionLike,
  TAccount extends AccountSelectionLike<TSession>,
>(
  accounts: readonly TAccount[],
  selectedKeys: Iterable<string>,
): AccountDeletionTarget[] {
  const normalizedSelection = normalizeAccountSelection(accounts, selectedKeys);
  const targets: AccountDeletionTarget[] = [];
  const seenSessionIds = new Set<string>();

  for (const account of accounts) {
    if (!normalizedSelection.has(account.key)) {
      continue;
    }
    for (const session of account.sessions) {
      if (seenSessionIds.has(session.id)) {
        continue;
      }
      seenSessionIds.add(session.id);
      targets.push({
        sessionId: session.id,
        profileId: session.profileId,
        accountId: session.accountId,
      });
    }
  }

  return targets;
}

function buildAccountReferenceSelectors(
  targets: readonly AccountDeletionTarget[],
): Set<string> {
  const selectors = new Set<string>();
  for (const target of targets) {
    for (const value of [
      target.sessionId,
      target.profileId,
      target.accountId,
    ]) {
      const trimmed = value?.trim();
      if (trimmed) {
        selectors.add(trimmed);
      }
    }
  }
  return selectors;
}

export function pruneDeletedAccountPoolMembers<
  TSettings extends { pools?: TPool[] },
  TPool extends { id: string; members?: TMember[] },
  TMember extends { selector: string },
>(
  settings: TSettings,
  targets: readonly AccountDeletionTarget[],
): {
  settings: TSettings;
  removedMemberCount: number;
  affectedPoolIds: string[];
} {
  const deletedSelectors = buildAccountReferenceSelectors(targets);
  if (!deletedSelectors.size || !settings.pools?.length) {
    return {
      settings,
      removedMemberCount: 0,
      affectedPoolIds: [],
    };
  }

  let removedMemberCount = 0;
  const affectedPoolIds: string[] = [];
  const pools = settings.pools.map((pool) => {
    const members = pool.members ?? [];
    const nextMembers = members.filter(
      (member) => !deletedSelectors.has(member.selector.trim()),
    );
    const removedFromPool = members.length - nextMembers.length;
    if (removedFromPool === 0) {
      return pool;
    }
    removedMemberCount += removedFromPool;
    affectedPoolIds.push(pool.id);
    return {
      ...pool,
      members: nextMembers,
    };
  });

  if (removedMemberCount === 0) {
    return {
      settings,
      removedMemberCount,
      affectedPoolIds,
    };
  }

  return {
    settings: {
      ...settings,
      pools,
    },
    removedMemberCount,
    affectedPoolIds,
  };
}
