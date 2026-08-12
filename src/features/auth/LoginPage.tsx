import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/hooks/useAuth';
import { ApiClientError } from '@/api/client';
import { requestPasswordReset } from '@/api/auth';
import type { CompanyChoice } from '@/api/types';

// The one message the request screen ever shows on a successful submit. It is
// deliberately account-agnostic: on a SHARED TABLET, confirming whether an
// identifier matches a real account would let anyone probe who has a login here,
// so this text is identical whether or not an account exists (mirroring the
// backend's silent, non-enumerating forgot-password endpoint).
const NEUTRAL_RESET_CONFIRMATION =
  "If an account matches, we've sent a reset link to the email on file.";

/**
 * Which step of the login flow is on screen. Modeled as in-page state (not
 * routes), matching how the existing company-choice step already works — the
 * login screen is a single self-contained view with no deep-linkable sub-pages.
 */
type View = 'login' | 'forgot';

export function LoginPage() {
  const { login, selectCompany } = useAuth();
  const navigate = useNavigate();
  const [view, setView] = useState<View>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [companyChoice, setCompanyChoice] = useState<{
    preAuthToken: string;
    companies: CompanyChoice[];
  } | null>(null);

  // Forgot-password request state. `resetIdentifier` lives only for the duration
  // of this in-memory step and is never persisted — on a shared tablet nothing
  // about who requested a reset should survive to the next driver.
  const [resetIdentifier, setResetIdentifier] = useState('');
  const [resetSent, setResetSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setIsSubmitting(true);
    try {
      const result = await login(username, password);
      if (result.status === 'authenticated') {
        navigate('/', { replace: true });
      } else {
        setCompanyChoice({ preAuthToken: result.preAuthToken, companies: result.companies });
      }
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : 'Could not sign in. Check your connection.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleChooseCompany(companyId: string) {
    if (!companyChoice) return;
    setIsSubmitting(true);
    setFormError(null);
    try {
      await selectCompany(companyChoice.preAuthToken, companyId);
      navigate('/', { replace: true });
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : 'Could not sign in. Check your connection.');
    } finally {
      setIsSubmitting(false);
    }
  }

  /**
   * Trigger a password-reset email and show the SAME neutral confirmation no
   * matter what the backend returns. We do NOT collect a new password here: the
   * reset is completed via the link emailed to the driver's own registered
   * address, opened on the driver's OWN device — never typed into this shared
   * tablet. So the tablet only ever fires the email; it learns nothing about
   * whether the account exists and stores nothing sensitive.
   */
  async function handleForgotSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setIsSubmitting(true);
    try {
      await requestPasswordReset(resetIdentifier);
      // Success is not conditional on a match — the endpoint is non-enumerating.
      setResetSent(true);
    } catch (err) {
      // A network failure is the only thing worth surfacing (the driver can
      // retry). A real server response — even a 4xx — still must not reveal
      // account state, but in practice forgot-password answers 200/204; any
      // ApiClientError here is treated as a transient failure to retry.
      setFormError(
        err instanceof ApiClientError && err.status === 0
          ? 'Could not send the reset link. Check your connection and try again.'
          : 'Could not send the reset link. Please try again.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  function openForgot() {
    // Don't carry the typed password over to the recovery step, and start the
    // identifier from the username field only as a convenience.
    setFormError(null);
    setResetIdentifier(username);
    setResetSent(false);
    setView('forgot');
  }

  function backToLogin() {
    setFormError(null);
    setResetIdentifier('');
    setResetSent(false);
    setView('login');
  }

  const heading =
    view === 'forgot'
      ? 'Reset your password'
      : companyChoice
        ? 'Choose a company'
        : 'Sign in to start your shift';

  return (
    <div className="flex min-h-screen flex-col justify-center px-6 py-10">
      <h1 className="mb-1 text-3xl font-bold">FleetOS</h1>
      <p className="mb-8 text-(--text-secondary)">{heading}</p>

      {view === 'forgot' ? (
        resetSent ? (
          <div className="space-y-6">
            <p className="text-(--text-primary)">{NEUTRAL_RESET_CONFIRMATION}</p>
            <p className="text-sm text-(--text-secondary)">
              Open the link on your own phone or computer to choose a new password, then come
              back here to sign in.
            </p>
            <Button variant="secondary" onClick={backToLogin}>
              Back to sign in
            </Button>
          </div>
        ) : (
          <form onSubmit={handleForgotSubmit} className="space-y-4">
            <p className="text-sm text-(--text-secondary)">
              Enter your username or email and we'll send a reset link to the email on your
              account. Finish resetting on your own device.
            </p>
            <input
              className="min-h-14 w-full rounded-2xl border border-(--border-subtle) bg-(--surface-1) px-4 text-lg"
              placeholder="Username or email"
              autoComplete="username"
              autoFocus
              value={resetIdentifier}
              onChange={(e) => setResetIdentifier(e.target.value)}
            />
            <Button type="submit" disabled={isSubmitting || resetIdentifier.trim() === ''}>
              {isSubmitting ? 'Sending…' : 'Send reset link'}
            </Button>
            <Button variant="secondary" disabled={isSubmitting} onClick={backToLogin}>
              Back to sign in
            </Button>
          </form>
        )
      ) : companyChoice ? (
        <div className="space-y-3">
          {companyChoice.companies.map((company) => (
            <Button
              key={company.id}
              variant="secondary"
              disabled={isSubmitting}
              onClick={() => handleChooseCompany(company.id)}
            >
              {company.name}
            </Button>
          ))}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            className="min-h-14 w-full rounded-2xl border border-(--border-subtle) bg-(--surface-1) px-4 text-lg"
            placeholder="Username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            className="min-h-14 w-full rounded-2xl border border-(--border-subtle) bg-(--surface-1) px-4 text-lg"
            placeholder="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
          <button
            type="button"
            className="mt-2 w-full text-center text-(--text-secondary) underline underline-offset-4"
            onClick={openForgot}
          >
            Forgot your password?
          </button>
        </form>
      )}

      {formError && <p className="mt-4 text-center text-danger-500">{formError}</p>}
    </div>
  );
}
