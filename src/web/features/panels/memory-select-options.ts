import type { SelectOption } from '../../app/lenso-controls';

export const RECALL_MODE_OPTIONS: SelectOption[] = [
  { value: 'lookup', label: 'lookup · 显式查询' },
  { value: 'reflect', label: 'reflect · 综合分析' },
];

export const RECALL_EVIDENCE_OPTIONS: SelectOption[] = [
  { value: '', label: '不限' },
  { value: 'host_reported_submitted', label: '宿主报告已提交' },
  { value: 'gateway_observed_submitted', label: '网关观察已提交' },
];

export const CONTEXT_KIND_OPTIONS: SelectOption[] = [
  { value: '', label: '全部' },
  { value: 'lookup', label: 'lookup' },
  { value: 'bound', label: 'bound' },
];
