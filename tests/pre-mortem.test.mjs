import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_INITIATIVES,
  getSeverityBadgeClass,
  formatPreMortemDossier,
  fetchPreMortemInitiatives,
  simulatePreMortem
} from '../app/pre-mortem.ts';

test('provides fallback initiatives with required properties', () => {
  assert.ok(FALLBACK_INITIATIVES.length >= 4);
  const aiInit = FALLBACK_INITIATIVES.find(i => i.id === 'ai-cloud-migration');
  assert.ok(aiInit);
  assert.equal(aiInit.capitalAtStakeUsd, '$45M USD');
  assert.ok(aiInit.baselineRiskScore > 70);
});

test('assigns correct badge classes based on severity level', () => {
  assert.equal(getSeverityBadgeClass('Critical'), 'pre-mortem-badge-critical');
  assert.equal(getSeverityBadgeClass('critical'), 'pre-mortem-badge-critical');
  assert.equal(getSeverityBadgeClass('High'), 'pre-mortem-badge-high');
  assert.equal(getSeverityBadgeClass('high'), 'pre-mortem-badge-high');
  assert.equal(getSeverityBadgeClass('Moderate'), 'pre-mortem-badge-moderate');
});

test('formats boardroom pre-mortem autopsy dossier correctly', () => {
  const dossier = {
    initiativeId: 'ai-cloud-migration',
    title: 'Autonomous Enterprise AI Cloud Transformation',
    horizonMonths: 24,
    executiveSummaryAutopsy: 'Scenario test: Failure cascade across core nodes.',
    overallFatalityProbabilityPercent: 64,
    collapseVectors: [
      {
        vectorId: 'v1',
        name: 'Regulatory Non-Compliance',
        severity: 'Critical',
        failureMechanism: 'Model hallucination breached supervisory rules.',
        earlyWarningIndicators: ['Complaint spike > 15%', 'Vendor API drift'],
        preemptiveHedgingDirective: 'Implement deterministic rule-based verification guardrails.'
      }
    ],
    boardRecommendation: 'HALT CAPITAL DEPLOYMENT UNTIL AUDIT COMPLETE',
    simulatedAt: '2026-11-06T00:00:00Z'
  };

  const text = formatPreMortemDossier(dossier);
  assert.ok(text.includes('# Boardroom Pre-Mortem Autopsy: "Autonomous Enterprise AI Cloud Transformation"'));
  assert.ok(text.includes('Simulated Time Horizon: +24 Months | Fatality Probability: 64%'));
  assert.ok(text.includes('[CRITICAL] Regulatory Non-Compliance'));
  assert.ok(text.includes('Complaint spike > 15%'));
  assert.ok(text.includes('Implement deterministic rule-based verification guardrails.'));
});

test('handles API fallback gracefully on network failure', async () => {
  const failingFetch = async () => {
    throw new Error('Network offline');
  };

  const initiatives = await fetchPreMortemInitiatives(failingFetch);
  assert.equal(initiatives.length, FALLBACK_INITIATIVES.length);

  const dossier = await simulatePreMortem({ initiativeId: 'critical-materials-foundry', horizonMonths: 18 }, failingFetch);
  assert.equal(dossier.initiativeId, 'critical-materials-foundry');
  assert.ok(dossier.overallFatalityProbabilityPercent >= 50);
  assert.ok(dossier.collapseVectors.length >= 2);
});
