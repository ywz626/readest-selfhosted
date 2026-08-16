import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { QuotaType, UserPlan } from '@/types/quota';
import { getStoragePlanData, getTranslationPlanData, getUserProfilePlan } from '@/utils/access';
import { SELFHOSTED } from '@/utils/supabase';
import { getStorageStats } from '@/libs/storage';
import { setCachedUserPlan } from '@/services/sync/cloudSyncProvider';
import { useTranslation } from './useTranslation';

export const useQuotaStats = (briefName = false) => {
  const _ = useTranslation();
  const { token, user } = useAuth();
  const [quotas, setQuotas] = useState<QuotaType[]>([]);
  const [userProfilePlan, setUserProfilePlan] = useState<UserPlan | undefined>(undefined);
  const [selfhostedStorageUsage, setSelfhostedStorageUsage] = useState<number | null>(null);

  // Self-hosted sync servers do not embed live usage in the JWT; fetch the
  // actual server-side storage consumption so the menu reflects real usage.
  useEffect(() => {
    if (!SELFHOSTED || !token) return;

    let cancelled = false;
    getStorageStats()
      .then((stats) => {
        if (!cancelled) {
          setSelfhostedStorageUsage(stats.usage);
        }
      })
      .catch((error) => {
        console.error('Failed to fetch self-hosted storage stats:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!user || !token) return;

    const storagPlan = getStoragePlanData(token);
    // In self-hosted mode prefer the actual server-side usage over the static
    // (often zero) value decoded from the JWT.
    const storageUsage = SELFHOSTED
      ? (selfhostedStorageUsage ?? storagPlan.usage)
      : storagPlan.usage;
    const inGB = storagPlan.quota > 1e9;
    const storageQuota: QuotaType = {
      name: briefName ? _('Storage') : _('Cloud Sync Storage'),
      tooltip: _('{{percentage}}% of Cloud Sync Space Used.', {
        percentage: Math.round((storageUsage / storagPlan.quota) * 100),
      }),
      used: parseFloat((storageUsage / 1024 / 1024 / (inGB ? 1024 : 1)).toFixed(2)),
      total: Math.round((storagPlan.quota / 1024 / 1024 / (inGB ? 1024 : 1)) * 10) / 10,
      unit: inGB ? 'GB' : 'MB',
    };
    const translationPlan = getTranslationPlanData(token);
    const now = new Date();
    const translationResetAt = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
    const translationQuota: QuotaType = {
      name: briefName ? _('Translation') : _('Translation Characters'),
      tooltip: _('{{percentage}}% of Daily Translation Characters Used.', {
        percentage: Math.round((translationPlan.usage / translationPlan.quota) * 100),
      }),
      used: Math.round(translationPlan.usage / 1024),
      total: Math.round(translationPlan.quota / 1024),
      unit: 'K',
      resetAt: translationResetAt,
    };
    const profilePlan = getUserProfilePlan(token);
    setUserProfilePlan(profilePlan);
    // Non-React modules (transferManager, syncCategories) need the plan
    // synchronously for the cloud-sync provider gate; cache it here, the
    // one place the plan is resolved from the JWT.
    setCachedUserPlan(profilePlan);
    setQuotas([storageQuota, translationQuota]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, selfhostedStorageUsage]);

  return {
    quotas,
    userProfilePlan,
  };
};
