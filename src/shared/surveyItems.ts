export interface SurveyItem {
  code: string;
  name: string;
  order: number;
}

export const SURVEY_ITEMS: SurveyItem[] = [
  { code: 'management', name: 'Management', order: 1 },
  { code: 'construction', name: 'Construction', order: 2 },
  { code: 'occupancy', name: 'Occupancy', order: 3 },
  { code: 'protection', name: 'Protection', order: 4 },
  { code: 'exposure', name: 'Exposure', order: 5 },
  { code: 'natural_hazards', name: 'Natural Hazards', order: 6 },
  { code: 'other_peril', name: 'Other Peril', order: 7 },
  { code: 'loss_estimate', name: 'Loss Estimate', order: 8 },
];

export const SURVEY_ITEM_CODES = SURVEY_ITEMS.map((i) => i.code);