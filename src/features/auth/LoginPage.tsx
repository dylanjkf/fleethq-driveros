import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/hooks/useAuth';
import { ApiClientError } from '@/api/client';
import type { CompanyChoice } from '@/api/types';

export function LoginPage() {
  const { login, selectCompany } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [companyChoice, setCompanyChoice] = useState<{
    preAuthToken: string;
    companies: CompanyChoice[];
  } | null>(null);

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

  return (
    <div className="flex min-h-screen flex-col justify-center px-6 py-10">
      <h1 className="mb-1 text-3xl font-bold">FleetOS</h1>
      <p className="mb-8 text-(--text-secondary)">
        {companyChoice ? 'Choose a company' : 'Sign in to start your shift'}
      </p>

      {companyChoice ? (
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
        </form>
      )}

      {formError && <p className="mt-4 text-center text-danger-500">{formError}</p>}
    </div>
  );
}
