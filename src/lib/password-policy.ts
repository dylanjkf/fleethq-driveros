import { ApiClientError } from '@/api/client';

/**
 * Client-side password-policy check, mirroring the server rule in the API's
 * `is-strong-password.validator.ts` and the identical helper the office/admin
 * apps use: ≥8 characters AND all four character classes (lowercase, uppercase,
 * digit, symbol). The server remains the real gate — this just gives the driver
 * immediate, offline-friendly feedback before a round-trip.
 */
export function passwordMeetsPolicy(value: string): boolean {
  if (value.length < 8) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(value)).length;
  return classes === 4;
}

/** The single sentence the policy is described by, reused in hints and errors. */
export const PASSWORD_POLICY_HINT =
  'Use at least 8 characters, including lowercase, uppercase, a number, and a symbol.';

/** Map a change-expired-password failure to friendly, code-driven copy. */
export function passwordChangeErrorMessage(err: unknown): string {
  if (err instanceof ApiClientError) {
    switch (err.code) {
      case 'INVALID_TOKEN':
        return 'This session has expired. Sign in again to set a new password.';
      case 'WEAK_PASSWORD':
        return `That password is too weak. ${PASSWORD_POLICY_HINT}`;
      case 'PASSWORD_REUSED':
        return 'That password matches a recent one. Choose a different password.';
      default:
        return err.status === 0
          ? "Couldn't reach the server. Check your connection and try again."
          : 'Could not update your password. Please try again.';
    }
  }
  return 'Could not update your password. Please try again.';
}
