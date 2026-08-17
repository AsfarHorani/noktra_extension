import { Component, ElementRef, effect, input, output, signal, viewChild } from '@angular/core';
import { Application, ApplicationsService } from '../applications-service';
import { isProfileEmpty, type Profile } from '../profile-service';
import { generateCoverLetter, toApplicationContext } from '../assistant-api';
import { JobDescriptionGate } from '../job-description-gate/job-description-gate';

@Component({
  selector: 'app-cover-letter-panel',
  imports: [JobDescriptionGate],
  templateUrl: './cover-letter-panel.html',
  styleUrl: './cover-letter-panel.css',
})
export class CoverLetterPanel {
  readonly application = input.required<Application>();
  readonly profile = input<Profile | null>(null);
  readonly close = output<void>();
  // Lets the "set up your profile first" message send the user straight to
  // the Profile page — app.html handles this by switching activePage and
  // closing this panel (see app.ts's goToProfileFromAssistant()).
  readonly goToProfile = output<void>();

  private readonly notesRef = viewChild.required<ElementRef<HTMLTextAreaElement>>('notesInput');

  readonly busy = signal(false);
  readonly error = signal('');
  readonly result = signal('');
  readonly copied = signal(false);
  // User feedback: a generated letter must be reviewed and explicitly
  // confirmed before it's treated as usable (Copy/Download gated on this) —
  // an unread AI draft going straight into a real application is exactly
  // the failure mode being guarded against here, on top of the generation
  // quality fixes themselves.
  readonly reviewed = signal(false);
  // Working copy of the application, so a job description saved via
  // JobDescriptionGate below is reflected immediately without waiting for
  // the application() input to re-flow from a full list re-fetch — see
  // JobDescriptionGate's docstring.
  readonly workingApplication = signal<Application | null>(null);

  readonly profileEmpty = () => isProfileEmpty(this.profile());
  // Never generate without a real job description — user feedback: a cover
  // letter that doesn't engage with what the specific job asks for isn't
  // worth generating, even as a degraded fallback. Mirrors the server's own
  // hard block in assistant/views.py's cover_letter() (job_description_missing),
  // shown here immediately instead of only after a round-trip 400.
  readonly jobDescriptionMissing = () => !this.workingApplication()?.jobDescription;

  constructor(private readonly applicationsService: ApplicationsService) {
    // A letter already saved on this record (generated earlier, in this
    // session or a past one) is shown immediately — generation is an
    // explicit action the user asks for, not something that should re-run
    // just because the panel was reopened. A previously-saved letter is
    // treated as already reviewed (the user saved it in an earlier session);
    // only a freshly (re)generated letter in *this* session needs a fresh
    // confirmation — see generate() below, which resets this to false.
    effect(() => {
      const app = this.application();
      this.workingApplication.set(app);
      this.result.set(app.coverLetter || '');
      this.reviewed.set(!!app.coverLetter);
    });
  }

  onDescriptionSaved(jobDescription: string): void {
    const current = this.workingApplication();
    if (current) this.workingApplication.set({ ...current, jobDescription });
  }

  async generate(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.reviewed.set(false);
    try {
      const letter = await generateCoverLetter(
        this.profile() || {},
        toApplicationContext(this.workingApplication()!),
        this.notesRef().nativeElement.value.trim()
      );
      this.result.set(letter);
      // Saved automatically the moment it's generated — see the panel's
      // template for why there's no separate Save button: asking the user
      // to remember an extra click just to keep something that already
      // exists is the same "generate it again next time" problem this was
      // built to avoid. Saving early (before the user has ticked "reviewed")
      // is still correct — the confirmation gate is about what the user does
      // with the text (copy/download it elsewhere), not about whether it's
      // allowed to sit on the record for later editing.
      await this.applicationsService.update(this.application().id, { coverLetter: letter });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  async copy(): Promise<void> {
    await navigator.clipboard.writeText(this.result());
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }

  download(): void {
    const app = this.application();
    const fileName = `cover-letter-${(app.company || 'application').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.txt`;
    const blob = new Blob([this.result()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }
}
