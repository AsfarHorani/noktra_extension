import { Component, computed, signal } from '@angular/core';
import { StatsFlow } from './stats-flow/stats-flow';
import { ApplicationList } from './application-list/application-list';
import { ApplicationBoard } from './application-board/application-board';
import { ApplicationForm, ApplicationFormValue } from './application-form/application-form';
import { Application, ApplicationsService } from './applications-service';
import { ResumeUpload } from './resume-upload/resume-upload';
import { ProfileView } from './profile-view/profile-view';
import { CoverLetterPanel } from './cover-letter-panel/cover-letter-panel';
import { InterviewAnswersPanel } from './interview-answers-panel/interview-answers-panel';
import { ProfileService } from './profile-service';
import { AuthService } from './auth-service';

type AssistantMode = 'cover-letter' | 'prep-answers' | null;
export type Page = 'overview' | 'jobs' | 'profile';
export type JobsView = 'board' | 'list';

@Component({
  selector: 'app-root',
  imports: [
    StatsFlow,
    ApplicationList,
    ApplicationBoard,
    ApplicationForm,
    ResumeUpload,
    ProfileView,
    CoverLetterPanel,
    InterviewAnswersPanel,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly store: ApplicationsService;
  private readonly profileStore: ProfileService;
  readonly auth: AuthService;

  readonly applications = computed(() => this.store.applications());
  readonly profile = computed(() => this.profileStore.profile());
  readonly formOpen = signal(false);
  readonly editingApp = signal<Application | undefined>(undefined);

  readonly activePage = signal<Page>('overview');
  // Board is the default — the more visual, Huntr-style view is the point
  // of the redesign; List stays available as a toggle for anyone who wants
  // a denser, scannable table instead.
  readonly jobsView = signal<JobsView>('board');

  // Small derived counts for the sidebar/overview/stat-tiles — plain array
  // filters over the same signal applications() already exposes, not a
  // separate stats computation (that's what stats-flow.ts already owns).
  readonly activeCount = computed(
    () => this.applications().filter((a) => a.status === 'Applied' || a.status === 'Interview').length
  );
  readonly interviewCount = computed(() => this.applications().filter((a) => a.status === 'Interview').length);
  readonly offerCount = computed(() => this.applications().filter((a) => a.status === 'Offer').length);

  readonly assistantMode = signal<AssistantMode>(null);
  readonly assistantApp = signal<Application | undefined>(undefined);

  // Login/signup form state — see app.html's auth-gate section.
  readonly authMode = signal<'login' | 'signup'>('login');
  readonly authBusy = signal(false);
  readonly authError = signal('');

  constructor(store: ApplicationsService, profileStore: ProfileService, auth: AuthService) {
    this.store = store;
    this.profileStore = profileStore;
    this.auth = auth;
    // Everything below reads/writes the server now (see applications-service.ts,
    // profile-service.ts) — nothing is fetched until checkAuth() confirms a
    // token exists, since every call would just 401 without one anyway.
    void this.auth.checkAuth().then(() => {
      if (this.auth.isLoggedIn()) this.loadData();
    });
  }

  private loadData(): void {
    void this.store.reload();
    void this.profileStore.reload();
  }

  async submitAuthForm(email: string, password: string, confirmPassword: string): Promise<void> {
    this.authError.set('');

    // Checked client-side, before ever touching the server — signup() would
    // happily create the account with whatever password was typed in the
    // first field alone; this is purely a "did you typo it" catch for the
    // user, not something the backend needs to know about.
    if (this.authMode() === 'signup' && password !== confirmPassword) {
      this.authError.set('Passwords do not match.');
      return;
    }

    this.authBusy.set(true);
    try {
      const action = this.authMode() === 'login' ? this.auth.login(email, password) : this.auth.signup(email, password);
      await action;
      this.loadData();
    } catch (err) {
      this.authError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.authBusy.set(false);
    }
  }

  toggleAuthMode(): void {
    this.authMode.set(this.authMode() === 'login' ? 'signup' : 'login');
    this.authError.set('');
  }

  async logout(): Promise<void> {
    await this.auth.logout();
  }

  setPage(page: Page): void {
    this.activePage.set(page);
  }

  setJobsView(view: JobsView): void {
    this.jobsView.set(view);
  }

  openAddForm(): void {
    this.editingApp.set(undefined);
    this.formOpen.set(true);
  }

  openEditForm(app: Application): void {
    this.editingApp.set(app);
    this.formOpen.set(true);
  }

  closeForm(): void {
    this.formOpen.set(false);
    this.editingApp.set(undefined);
  }

  async onSave(value: ApplicationFormValue): Promise<void> {
    const editing = this.editingApp();
    if (editing) {
      await this.store.update(editing.id, value);
    } else {
      await this.store.add(value);
    }
    this.closeForm();
  }

  async onStatusChange(change: { id: number; status: string }): Promise<void> {
    await this.store.update(change.id, { status: change.status });
  }

  async onDelete(id: number): Promise<void> {
    await this.store.remove(id);
  }

  async onClearAll(): Promise<void> {
    if (this.applications().length === 0) return;
    const confirmed = confirm(
      `Delete all ${this.applications().length} tracked applications? This cannot be undone.`
    );
    if (!confirmed) return;
    await this.store.clearAll();
  }

  openCoverLetter(app: Application): void {
    this.assistantApp.set(app);
    this.assistantMode.set('cover-letter');
  }

  openPrepAnswers(app: Application): void {
    this.assistantApp.set(app);
    this.assistantMode.set('prep-answers');
  }

  closeAssistantPanel(): void {
    this.assistantMode.set(null);
    this.assistantApp.set(undefined);
  }

  // The cover-letter panel's "Set Up Profile" button (shown when
  // profile-is-empty blocks generation) — closes the assistant panel and
  // switches to the Profile page in one action, rather than leaving the
  // user to close the panel and find the sidebar link themselves.
  goToProfileFromAssistant(): void {
    this.closeAssistantPanel();
    this.setPage('profile');
  }
}
