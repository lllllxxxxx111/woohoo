export const TOKENS_PER_CREDIT = 1000;

type CreditFormatOptions = {
  fractionDigits?: number;
};

function formatNumber(value: number, fractionDigits: number) {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

export function formatCreditAmount(value: number, options: CreditFormatOptions = {}) {
  const fractionDigits = options.fractionDigits ?? 2;
  if (!Number.isFinite(value)) {
    return formatNumber(0, fractionDigits);
  }
  return formatNumber(value, fractionDigits);
}

export function formatCreditsFromTokens(tokens: number, options: CreditFormatOptions = {}) {
  return formatCreditAmount(tokens / TOKENS_PER_CREDIT, options);
}

export function formatTokenCount(tokens: number) {
  if (!Number.isFinite(tokens)) {
    return '0';
  }
  return Math.round(tokens).toLocaleString('zh-CN');
}

export function creditRateLabel() {
  return `约 1 积分 = ${TOKENS_PER_CREDIT.toLocaleString('zh-CN')} token`;
}
