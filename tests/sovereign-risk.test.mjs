import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_ECONOMIES,
  getSovereignRiskColor,
  formatSovereignRiskReport,
  fetchSovereignEconomies,
  assessSovereignRisk
} from '../app/sovereign-risk.ts';

test('provides fallback economies with valid properties', () => {
    assert.ok(FALLBACK_ECONOMIES.length >= 8);
    const arg = FALLBACK_ECONOMIES.find(e => e.id === 'argentina');
    assert.ok(arg);
    assert.equal(arg.currencyCode, 'ARS');
    assert.ok(arg.sovereignRiskScore > 80);
  });

test('computes correct risk color based on threshold', () => {
  assert.equal(getSovereignRiskColor(95), 'var(--danger-color, #ef4444)');
  assert.equal(getSovereignRiskColor(70), 'var(--warning-color, #f59e0b)');
  assert.equal(getSovereignRiskColor(45), 'var(--info-color, #3b82f6)');
  assert.equal(getSovereignRiskColor(20), 'var(--success-color, #10b981)');
});

test('formats executive sovereign intelligence brief correctly', () => {
  const report = formatSovereignRiskReport({
    economyId: 'egypt',
    name: 'Egypt',
    currencyCode: 'EGP',
    sovereignRiskScore: 78,
    cdsSpreadBps: 980,
    fx30dDepreciationVelocityPercent: -12.2,
    foreignReservesCoverMonths: 2.6,
    capitalControlStatus: 'Severe Restrictions',
    repatriationHaircutPercent: 28.0,
    estimatedExposureLossUsd: '$2.8M USD',
    treasuryActionPlaybooks: [
      'Mandate USD letter of credit on shipments',
      'Route services contracts through offshore regional hubs'
    ],
    assessedAt: '2026-11-06T00:00:00Z'
  });

  assert.ok(report.includes('# Sovereign Risk & Capital Repatriation Intelligence Brief: Egypt (EGP)'));
  assert.ok(report.includes('78/100'));
  assert.ok(report.includes('980 bps'));
  assert.ok(report.includes('$2.8M USD'));
  assert.ok(report.includes('1. Mandate USD letter of credit on shipments'));
});

test('gracefully falls back when API fetch fails', async () => {
  const failingFetch = async () => {
    throw new Error('Network error');
  };

  const economies = await fetchSovereignEconomies(failingFetch);
  assert.equal(economies.length, FALLBACK_ECONOMIES.length);

  const assessment = await assessSovereignRisk({ economyId: 'pakistan', corporateExposureUsd: 20000000 }, failingFetch);
  assert.equal(assessment.economyId, 'pakistan');
  assert.equal(assessment.repatriationHaircutPercent, 28);
  assert.equal(assessment.estimatedExposureLossUsd, '$5.60M USD');
});
