import { describe, expect, it } from 'vitest';

import {
  CALIBRATION_QUESTIONS,
  PERSONA_SCENARIOS,
  TASTE_AXIS_IDS,
  calibratePersona,
} from '@/lib/personaCalibration';

describe('persona calibration', () => {
  it('provides four scenarios while distinguishing evidence from hypotheses', () => {
    expect(PERSONA_SCENARIOS).toHaveLength(4);
    expect(PERSONA_SCENARIOS.filter((persona) => persona.source === 'interview')).toHaveLength(2);
    expect(PERSONA_SCENARIOS.filter((persona) => persona.source === 'hypothesis')).toHaveLength(2);
  });

  it('lets explicit answers outweigh the starting scenario', () => {
    const result = calibratePersona('tamura-health', {
      protect: 'discovery',
      trust: 'intuition',
      atmosphere: 'character',
      tradeoff: 'special',
    });

    expect(result.topTraits[0].axis).toBe('novelty');
    expect(result.scores.novelty).toBeGreaterThan(result.scores.health);
    expect(result.profile.likes).toContain('個人店');
    expect(result.profile.healthGoal).toBe('none');
  });

  it('assigns a health goal only from an explicit answer', () => {
    const result = calibratePersona('tamura-health', {
      protect: 'body',
    });

    expect(result.profile.healthGoal).toBe('diet');
  });

  it('keeps every score in the public 0-100 range', () => {
    const answerIds = Object.fromEntries(
      CALIBRATION_QUESTIONS.map((question) => [question.id, question.options[0].id]),
    );
    const result = calibratePersona('family-safety', answerIds);

    expect(result.completedAnswers).toBe(CALIBRATION_QUESTIONS.length);
    for (const axis of TASTE_AXIS_IDS) {
      expect(result.scores[axis]).toBeGreaterThanOrEqual(0);
      expect(result.scores[axis]).toBeLessThanOrEqual(100);
    }
  });

  it('does not mutate the registered scenario', () => {
    const before = JSON.stringify(PERSONA_SCENARIOS[0]);
    calibratePersona('tamura-health', { protect: 'body' });
    expect(JSON.stringify(PERSONA_SCENARIOS[0])).toBe(before);
  });

  it('rejects unknown scenario ids', () => {
    expect(() => calibratePersona('missing', {})).toThrow('シナリオ');
  });
});
