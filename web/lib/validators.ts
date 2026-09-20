/** Password validation: 8+ chars with complexity requirements. */

export interface ValidationResult {
  isValid: boolean;
  error?: string;
}

/** 8+ chars, and at least 2 of: lowercase, uppercase, digit, special. */
export const validatePassword = (password: string): ValidationResult => {
  // minimum length
  if (password.length < 8) {
    return {
      isValid: false,
      error: 'Password must be at least 8 characters',
    };
  }

  // at least 2 categories
  let complexity = 0;

  if (/[a-z]/.test(password)) complexity++; // Has lowercase
  if (/[A-Z]/.test(password)) complexity++; // Has uppercase
  if (/[0-9]/.test(password)) complexity++; // Has numbers
  if (/[^a-zA-Z0-9]/.test(password)) complexity++; // Has special characters

  if (complexity < 2) {
    return {
      isValid: false,
      error: 'Password must include at least 2 of: lowercase, uppercase, numbers, or special characters',
    };
  }

  return { isValid: true };
};

/** Email format. */
export const validateEmail = (email: string): ValidationResult => {
  // Require at least 2-char local part, 2-char domain, and 2-char TLD
  const emailRegex = /^[^\s@]{2,}@[^\s@]{2,}\.[^\s@]{2,}$/;

  if (!email || email.trim() === '') {
    return {
      isValid: false,
      error: 'Email is required',
    };
  }

  if (!emailRegex.test(email)) {
    return {
      isValid: false,
      error: 'Please enter a valid email address',
    };
  }

  return { isValid: true };
};

/** Site IDs that cannot be claimed. */
const RESERVED_SITE_IDS: readonly string[] = [
  'admin',
  'api',
  'auth',
  'config',
  'dashboard',
  'deployments',
  'login',
  'logout',
  'register',
  'settings',
  'setup',
  'sites',
  'users',
] as const;

/**
 * Site ID slug: 3-50 chars, lowercase letters/digits/`-`/`_`, must start with a
 * letter, must not be in RESERVED_SITE_IDS.
 */
export const validateSiteId = (siteId: string): ValidationResult => {
  if (!siteId || siteId.trim() === '') {
    return {
      isValid: false,
      error: 'Site ID is required',
    };
  }

  // length
  if (siteId.length < 3) {
    return {
      isValid: false,
      error: 'Site ID must be at least 3 characters',
    };
  }

  if (siteId.length > 50) {
    return {
      isValid: false,
      error: 'Site ID must be 50 characters or less',
    };
  }

  // format
  if (!/^[a-z][a-z0-9_-]*$/.test(siteId)) {
    return {
      isValid: false,
      error: 'Site ID must start with a letter and contain only lowercase letters, numbers, hyphens, and underscores',
    };
  }

  // reserved words
  if (RESERVED_SITE_IDS.includes(siteId)) {
    return {
      isValid: false,
      error: `"${siteId}" is a reserved word and cannot be used as a site ID`,
    };
  }

  return { isValid: true };
};

const ADJECTIVES = [
  'amber', 'bold', 'calm', 'dark', 'eager', 'fair', 'glad', 'hazy', 'keen', 'lush',
  'mild', 'neat', 'pale', 'quick', 'rare', 'safe', 'tall', 'vast', 'warm', 'zesty',
  'airy', 'blue', 'cool', 'deep', 'even', 'fine', 'gold', 'high', 'idle', 'just',
  'kind', 'lean', 'mint', 'nova', 'open', 'pure', 'rich', 'soft', 'tidy', 'wise',
  'aqua', 'bay', 'cozy', 'dusk', 'elm', 'frost', 'gray', 'hue', 'ivy', 'jade',
  'knit', 'lime', 'moss', 'neon', 'oak', 'pine', 'quilt', 'reef', 'sage', 'teal',
];

const NOUNS = [
  'arch', 'barn', 'cave', 'dawn', 'echo', 'fern', 'glen', 'hive', 'isle', 'jade',
  'kite', 'lake', 'mesa', 'nest', 'opal', 'peak', 'quay', 'reef', 'star', 'tide',
  'vale', 'wave', 'yard', 'apex', 'bay', 'cove', 'dell', 'elm', 'fort', 'gate',
  'hall', 'ink', 'jet', 'knoll', 'loft', 'mist', 'nook', 'orb', 'pond', 'ridge',
  'spire', 'trail', 'urn', 'vine', 'wren', 'yew', 'zen', 'bloom', 'crest', 'dune',
  'flint', 'grove', 'heath', 'iron', 'brook', 'cliff', 'drift', 'field', 'glow', 'husk',
];

/** Random two-word site ID, e.g. "calm-reef". */
export const generateRandomSiteId = (): string => {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
};
