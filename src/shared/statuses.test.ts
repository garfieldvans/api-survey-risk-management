import { describe, expect, it } from 'vitest';
import { SURVEY_STATUSES, GRADE_CATEGORIES, USER_ROLES, type SurveyStatus } from './statuses.js';
import { TRANSITIONS, canTransition } from './transitions.js';

describe('SURVEY_STATUSES', () => {
  it('hanya berisi 6 status baru — status lama sudah hilang', () => {
    expect([...SURVEY_STATUSES]).toEqual([
      'ONBOARD',
      'REVIEW',
      'REQUEST_REVISE',
      'REVISED',
      'REJECTED',
      'APPROVED',
    ]);
    const legacy = ['GRADING', 'DONE', 'CLOSED'];
    for (const s of legacy) {
      expect(SURVEY_STATUSES).not.toContain(s as SurveyStatus);
    }
  });
});

describe('GRADE_CATEGORIES & USER_ROLES', () => {
  it('tetap POOR/MARGINAL/AVERAGE/GOOD', () => {
    expect([...GRADE_CATEGORIES]).toEqual(['POOR', 'MARGINAL', 'AVERAGE', 'GOOD']);
  });

  it('role SURVEYOR dan ADMIN', () => {
    expect([...USER_ROLES]).toEqual(['SURVEYOR', 'ADMIN']);
  });
});

describe('TRANSITIONS', () => {
  it('terdefinisi untuk setiap status (tidak ada key yang terlewat)', () => {
    for (const s of SURVEY_STATUSES) {
      expect(TRANSITIONS[s]).toBeDefined();
      expect(Array.isArray(TRANSITIONS[s])).toBe(true);
    }
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...SURVEY_STATUSES].sort());
  });

  it('tujuan transisi selalu status yang sah', () => {
    for (const s of SURVEY_STATUSES) {
      for (const to of TRANSITIONS[s]) {
        expect(SURVEY_STATUSES).toContain(to);
      }
    }
  });

  it('APPROVED dan REJECTED bersifat terminal', () => {
    expect(TRANSITIONS.APPROVED).toEqual([]);
    expect(TRANSITIONS.REJECTED).toEqual([]);
  });

  it('ONBOARD / REVISED → REVIEW, REQUEST_REVISE, APPROVED, REJECTED', () => {
    expect(TRANSITIONS.ONBOARD).toEqual(['REVIEW', 'REQUEST_REVISE', 'APPROVED', 'REJECTED']);
    expect(TRANSITIONS.REVISED).toEqual(['REVIEW', 'REQUEST_REVISE', 'APPROVED', 'REJECTED']);
    expect(canTransition('ONBOARD', 'REVIEW')).toBe(true);
    expect(canTransition('REVISED', 'REVIEW')).toBe(true);
    // tidak boleh lompat kembali ke ONBOARD
    expect(canTransition('REVISED', 'ONBOARD')).toBe(false);
  });

  it('REVIEW → REQUEST_REVISE / APPROVED / REJECTED saja', () => {
    expect(TRANSITIONS.REVIEW).toEqual(['REQUEST_REVISE', 'APPROVED', 'REJECTED']);
    expect(canTransition('REVIEW', 'ONBOARD')).toBe(false);
    expect(canTransition('REVIEW', 'REVISED')).toBe(false);
  });

  it('REQUEST_REVISE → REVISED saja (ditempuh surveyor lewat PUT /surveys/:id)', () => {
    expect(TRANSITIONS.REQUEST_REVISE).toEqual(['REVISED']);
    expect(canTransition('REQUEST_REVISE', 'APPROVED')).toBe(false);
    expect(canTransition('REQUEST_REVISE', 'REJECTED')).toBe(false);
    expect(canTransition('REQUEST_REVISE', 'REVIEW')).toBe(false);
  });

  it('tidak ada status yang bisa menuju dirinya sendiri', () => {
    for (const s of SURVEY_STATUSES) {
      expect(TRANSITIONS[s]).not.toContain(s);
    }
  });

  it('tidak ada jalan kembali dari terminal ke status aktif mana pun', () => {
    for (const s of SURVEY_STATUSES) {
      expect(canTransition('APPROVED', s)).toBe(false);
      expect(canTransition('REJECTED', s)).toBe(false);
    }
  });
});
