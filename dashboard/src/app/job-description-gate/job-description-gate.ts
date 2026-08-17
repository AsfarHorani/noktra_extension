import { Component, ElementRef, input, output, signal, viewChild } from '@angular/core';
import { ApplicationsService } from '../applications-service';

// Shared by cover-letter-panel and interview-answers-panel — both need the
// exact same "paste the job description before generating" gate (user
// feedback: neither should ever generate without one, since the result
// otherwise never engages with what the specific job actually asks for —
// see server/assistant/views.py's job_description_missing() check, which
// this mirrors client-side so the ask shows immediately instead of only
// after a round-trip 400). A real shared component rather than duplicated
// markup/logic in each panel, since both live in the same Angular build —
// unlike the popup/content-script boundary elsewhere in this project, there's
// no reason to hand-duplicate this one.
@Component({
  selector: 'app-job-description-gate',
  imports: [],
  templateUrl: './job-description-gate.html',
  styleUrl: './job-description-gate.css',
})
export class JobDescriptionGate {
  readonly applicationId = input.required<number>();
  // Emits the saved text so the parent panel can update its own working
  // copy of the application immediately, without waiting on a full re-fetch.
  readonly saved = output<string>();

  private readonly textRef = viewChild.required<ElementRef<HTMLTextAreaElement>>('jdInput');

  readonly busy = signal(false);
  readonly error = signal('');

  constructor(private readonly applicationsService: ApplicationsService) {}

  async save(): Promise<void> {
    const text = this.textRef().nativeElement.value.trim();
    if (!text) {
      this.error.set('Paste the job description first.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.applicationsService.update(this.applicationId(), { jobDescription: text });
      this.saved.emit(text);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
