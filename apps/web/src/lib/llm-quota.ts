import { llmDisplayQuota as displayQuota, type LlmCurrency } from '@eat/shared';

const moneyPrecision = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
const amount = (quota: number, currency: LlmCurrency) =>
  (quota / currency.quotaPerUnit) * currency.exchangeRate;

/** Presentation only: keep the original integer quota when saving unchanged fields. */
export function llmAmountInput(quota: number, currency: LlmCurrency | null): string {
  if (!currency) return String(quota);
  const value = amount(quota, currency);
  if (currency.currency === 'QUOTA') return String(value);
  return value.toLocaleString('en-US', { ...moneyPrecision, useGrouping: false });
}

export function llmDisplayQuota(quota: number, currency: LlmCurrency | null): string {
  if (!currency || currency.currency === 'QUOTA') return displayQuota(quota, currency);
  return `${amount(quota, currency).toLocaleString(undefined, moneyPrecision)} ${currency.currency}`;
}
