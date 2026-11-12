import { User } from 'firebase/auth';

/** "John Doe" -> "JD"; falls back to the first two letters of the email. */
export function getUserInitials(user: User | null): string {
  if (!user) return '?';

  if (user.displayName) {
    const names = user.displayName.trim().split(/\s+/);
    if (names.length >= 2) {
      return (names[0][0] + names[names.length - 1][0]).toUpperCase();
    }
    return user.displayName.substring(0, 2).toUpperCase();
  }

  if (user.email) {
    return user.email.substring(0, 2).toUpperCase();
  }

  return '?';
}

/** Display name, else email. */
export function getUserDisplayText(user: User | null): string {
  if (!user) return '';
  return user.displayName || user.email || 'User';
}

/** "Dylan R." for compact UI; first name alone when there is no surname. */
export function getUserShortName(user: Pick<User, 'displayName' | 'email'> | null): string {
  if (!user) return '';

  if (user.displayName) {
    const names = user.displayName.trim().split(/\s+/);
    if (names.length >= 2) {
      return `${names[0]} ${names[names.length - 1][0]}.`;
    }
    return names[0];
  }

  if (user.email) {
    return user.email.split('@')[0];
  }

  return 'User';
}

/** First name only. */
export function getUserFirstName(user: User | null): string {
  if (!user) return '';

  if (user.displayName) {
    const names = user.displayName.trim().split(/\s+/);
    return names[0];
  }

  if (user.email) {
    return user.email.split('@')[0];
  }

  return 'User';
}
