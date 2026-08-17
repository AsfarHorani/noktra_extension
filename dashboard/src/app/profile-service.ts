// Candidate profile storage — talks to the Django server's GET/PUT
// /api/profile/ (see server/tracker/) instead of chrome.storage.local.
// Unlike applications, nothing outside the dashboard ever reads or writes
// this, so it still doesn't need to live in the shared api-client.ts beyond
// the apiFetch helper itself.
import { Injectable, signal } from '@angular/core';
import { apiFetch } from './api-client';

export interface ExperienceEntry {
  title: string;
  company: string;
  startDate?: string;
  endDate?: string;
  description?: string;
}

export interface EducationEntry {
  school: string;
  degree?: string;
  field?: string;
  startDate?: string;
  endDate?: string;
}

export interface ProjectEntry {
  name: string;
  description?: string;
  technologies?: string;
}

export interface Profile {
  resumeFileName?: string;
  resumeText?: string;
  uploadedAt?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  summary?: string;
  experience?: ExperienceEntry[];
  education?: EducationEntry[];
  projects?: ProjectEntry[];
  skills?: string[];
  languages?: string[];
  certifications?: string[];
  interests?: string[];
}

// PUT only overwrites fields actually present in the body (see
// server/tracker/serializers.py's apply_profile_fields) — clear() has to
// name every field explicitly, an empty {} would leave the existing row
// untouched rather than blanking it.
const EMPTY_PROFILE: Profile = {
  resumeFileName: '',
  resumeText: '',
  uploadedAt: '',
  fullName: '',
  email: '',
  phone: '',
  summary: '',
  experience: [],
  education: [],
  projects: [],
  skills: [],
  languages: [],
  certifications: [],
  interests: [],
};

// Mirrors server/assistant/prompts.py's profile_is_empty() field list —
// kept in sync by hand, same as every other client/server duplication in
// this project (no shared module across the Python/TypeScript boundary).
// Used to gate cover-letter generation client-side too, so the "set up your
// profile first" message shows immediately rather than only after a
// round-trip to the server's own 400.
export function isProfileEmpty(profile: Profile | null): boolean {
  if (!profile) return true;
  return !(
    profile.summary ||
    profile.resumeText ||
    (profile.experience && profile.experience.length) ||
    (profile.education && profile.education.length) ||
    (profile.projects && profile.projects.length) ||
    (profile.skills && profile.skills.length) ||
    (profile.languages && profile.languages.length) ||
    (profile.certifications && profile.certifications.length) ||
    (profile.interests && profile.interests.length)
  );
}

@Injectable({ providedIn: 'root' })
export class ProfileService {
  // The server get-or-creates a row on first GET, so this is never really
  // "null" once loaded — but the signal starts null before the first
  // reload() so templates can tell "not loaded yet" from "loaded and
  // empty" if that distinction ever matters.
  readonly profile = signal<Profile | null>(null);

  async reload(): Promise<void> {
    this.profile.set(await apiFetch<Profile>('/profile/'));
  }

  async save(profile: Profile): Promise<void> {
    this.profile.set(await apiFetch<Profile>('/profile/', { method: 'PUT', body: JSON.stringify(profile) }));
  }

  async clear(): Promise<void> {
    this.profile.set(await apiFetch<Profile>('/profile/', { method: 'PUT', body: JSON.stringify(EMPTY_PROFILE) }));
  }
}
