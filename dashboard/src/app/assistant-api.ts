// Thin wrapper around the Django assistant app's three endpoints — same
// server as the popup's Insights tab talks to, same host_permissions-covered
// origin, just a different app/URL prefix (/api/assistant/... vs
// /api/analyze/). Centralized here so resume-upload, cover-letter-panel,
// and interview-answers-panel all get the same request/error shape instead
// of three copies of it. Goes through api-client.ts's apiFetch so these
// authenticated-now endpoints (see accounts/auth.py's require_auth) carry
// the same token as every other request this dashboard makes.
import type { Profile } from './profile-service';
import type { Application } from './applications-service';
import { apiFetch } from './api-client';

function post<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(`/assistant/${path}/`, { method: 'POST', body: JSON.stringify(body) });
}

// application fields the assistant prompts actually use — passing the
// whole Application record would work too, but being explicit keeps the
// request payload (and what the server sees) minimal and intentional.
export interface ApplicationContext {
  jobTitle: string;
  company: string;
  location?: string;
  jobDescription?: string;
}

export function toApplicationContext(app: Application): ApplicationContext {
  return {
    jobTitle: app.jobTitle,
    company: app.company,
    location: app.location,
    jobDescription: app.jobDescription,
  };
}

export function parseResume(resumeText: string): Promise<Profile> {
  return post<Profile>('parse-resume', { resumeText });
}

export function generateCoverLetter(
  profile: Profile,
  application: ApplicationContext,
  userNotes: string
): Promise<string> {
  return post<{ coverLetter: string }>('cover-letter', { profile, application, userNotes }).then(
    (r) => r.coverLetter
  );
}

export function generateAnswer(profile: Profile, application: ApplicationContext, question: string): Promise<string> {
  return post<{ answer: string }>('answer', { profile, application, question }).then((r) => r.answer);
}
