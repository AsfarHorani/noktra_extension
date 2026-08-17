// Talks to the Django server (see server/tracker/) via api-client.ts's
// apiFetch rather than chrome.storage.local directly — applications now
// live in the server's SQLite database behind a real login, not in the
// extension's local storage. Same signal-based service shape as before, so
// every consuming component re-renders automatically after a mutation
// without needing changes on their end.
import { Injectable, signal } from '@angular/core';
import { apiFetch } from './api-client';

export interface Application {
  id: number;
  jobKey?: string;
  jobTitle: string;
  company: string;
  location?: string;
  jobUrl?: string;
  employmentType?: string;
  jobDescription?: string;
  status: string;
  applicationDate?: string;
  notes?: string;
  coverLetter?: string;
  createdAt: string;
  updatedAt: string;
}

async function getApplications(): Promise<Application[]> {
  return apiFetch<Application[]>('/applications/');
}

async function addApplication(data: Partial<Application>): Promise<Application> {
  return apiFetch<Application>('/applications/', { method: 'POST', body: JSON.stringify(data) });
}

async function updateApplication(id: number, updates: Partial<Application>): Promise<Application> {
  return apiFetch<Application>(`/applications/${id}/`, { method: 'PATCH', body: JSON.stringify(updates) });
}

async function deleteApplication(id: number): Promise<void> {
  await apiFetch(`/applications/${id}/`, { method: 'DELETE' });
}

async function clearApplications(): Promise<void> {
  await apiFetch('/applications/clear/', { method: 'DELETE' });
}

@Injectable({ providedIn: 'root' })
export class ApplicationsService {
  // Signal-based store so every component reading applications() re-renders
  // automatically after any mutation below, without manual event wiring.
  readonly applications = signal<Application[]>([]);

  async reload(): Promise<void> {
    this.applications.set(await getApplications());
  }

  async add(data: Partial<Application>): Promise<void> {
    await addApplication(data);
    await this.reload();
  }

  async update(id: number, updates: Partial<Application>): Promise<void> {
    await updateApplication(id, updates);
    await this.reload();
  }

  async remove(id: number): Promise<void> {
    await deleteApplication(id);
    await this.reload();
  }

  async clearAll(): Promise<void> {
    await clearApplications();
    await this.reload();
  }
}
