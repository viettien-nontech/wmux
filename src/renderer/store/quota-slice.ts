import { StateCreator } from 'zustand';
import { parseQuota, QuotaState } from '../components/Sidebar/quota';

export interface QuotaSlice {
  quota: QuotaState | null;
  setQuotaRaw: (raw: unknown) => void;
}

export const createQuotaSlice: StateCreator<QuotaSlice, [], [], QuotaSlice> = (set) => ({
  quota: null,
  setQuotaRaw(raw: unknown): void {
    set({ quota: parseQuota(raw) });
  },
});
