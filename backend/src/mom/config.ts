export const TAB_NAMES: Record<string, string> = {
  "web-dev": "Web Development",
  "marketing-pr": "Marketing & PR",
  "video-editing": "Video Editing",
  "graphic-design": "Graphic Designing",
  "cp-dsa": "Competitive Programming",
  "data-science": "Data Science & Data Analytics",
  "ai-ml": "AI/ML",
  "app-dev": "App Development",
  "cloud": "Cloud",
};

export const DOMAIN_KEYS = Object.keys(TAB_NAMES);

export const MOM_CONFIG = {
  DEFAULT_MAX_DELEGATION_HOURS: 168,
  DEFAULT_DELEGATION_HOURS: 24,
  MAX_DELEGATIONS_PER_GRANTOR: 10,
  DEFAULT_NONEXEC_MAX_PAST_DAYS: 14,
  DEFAULT_MAX_FUTURE_DAYS: 1,
  TIMEZONE: 'Asia/Kolkata',
  MIN_ROLL_DIGITS: 7,
  MAX_ROLL_DIGITS: 8,
  REQUEST_BODY_LIMIT: '100kb',
  UPSTREAM_TIMEOUT_MS: 10000,
  RATE_LIMIT_MAX: 60,
  RATE_LIMIT_WINDOW_MS: 60 * 1000,
  MEMBERS_CACHE_TTL_MS: 60 * 1000,
  ROSTER_CACHE_TTL_MS: 15 * 1000,
  DELEGATION_SWEEP_INTERVAL_MS: 5 * 60 * 1000,
  SHEETS_SCOPES: ['https://www.googleapis.com/auth/spreadsheets'],
};

