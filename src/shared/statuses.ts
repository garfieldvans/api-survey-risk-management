export const SURVEY_STATUSES = [
  'ONBOARD',
  'REVIEW',
  'GRADING',
  'DONE',
  'CLOSED',
  'REJECTED',
] as const;

export type SurveyStatus = (typeof SURVEY_STATUSES)[number];

export const GRADE_CATEGORIES = ['POOR', 'MARGINAL', 'AVERAGE', 'GOOD'] as const;

export type GradeCategory = (typeof GRADE_CATEGORIES)[number];

export const USER_ROLES = ['SURVEYOR', 'ADMIN'] as const;

export type UserRole = (typeof USER_ROLES)[number];