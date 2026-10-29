import type { SurveyStatus } from './statuses.js';

/**
 * Alur review (poin review file):
 *   ONBOARD/REVISED --Mulai Review--> REVIEW
 *   REVIEW --Request Revisi--> REQUEST_REVISE --(surveyor submit revisi)--> REVISED --> REVIEW ...
 *   REVIEW/ONBOARD/REVISED --Approve--> APPROVED | --Reject--> REJECTED
 * REQUEST_REVISE -> REVISED hanya ditempuh surveyor lewat PUT /surveys/:id,
 * jadi PATCH status admin tidak memakainya (lihat penjagaan di route).
 *
 * APPROVED dan REJECTED bersifat terminal — tidak ada transisi keluar.
 */
export const TRANSITIONS: Record<SurveyStatus, SurveyStatus[]> = {
  ONBOARD: ['REVIEW', 'REQUEST_REVISE', 'APPROVED', 'REJECTED'],
  REVISED: ['REVIEW', 'REQUEST_REVISE', 'APPROVED', 'REJECTED'],
  REVIEW: ['REQUEST_REVISE', 'APPROVED', 'REJECTED'],
  REQUEST_REVISE: ['REVISED'],
  REJECTED: [],
  APPROVED: [],
};

export function canTransition(from: SurveyStatus, to: SurveyStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
