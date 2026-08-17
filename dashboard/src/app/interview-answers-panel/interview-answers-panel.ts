import { Component, ElementRef, effect, input, output, signal, viewChild } from '@angular/core';
import type { Application } from '../applications-service';
import type { Profile } from '../profile-service';
import { generateAnswer, toApplicationContext } from '../assistant-api';
import { JobDescriptionGate } from '../job-description-gate/job-description-gate';

const PRESET_QUESTIONS = ['Tell me about yourself', 'Why this role?', 'Why should we hire you?', 'What are your strengths?'];

@Component({
  selector: 'app-interview-answers-panel',
  imports: [JobDescriptionGate],
  templateUrl: './interview-answers-panel.html',
  styleUrl: './interview-answers-panel.css',
})
export class InterviewAnswersPanel {
  readonly application = input.required<Application>();
  readonly profile = input<Profile | null>(null);
  readonly close = output<void>();

  readonly presetQuestions = PRESET_QUESTIONS;

  private readonly customQuestionRef = viewChild.required<ElementRef<HTMLInputElement>>('customQuestionInput');

  readonly busy = signal(false);
  readonly error = signal('');
  readonly result = signal('');
  readonly askedQuestion = signal('');
  readonly copied = signal(false);
  // Same working-copy pattern as cover-letter-panel.ts — see
  // JobDescriptionGate's docstring for why.
  readonly workingApplication = signal<Application | null>(null);

  // Never generate without a real job description — user feedback: an
  // interview answer is "about the job" just as much as a cover letter is,
  // and one that never engages with the actual posting isn't worth
  // generating either. Mirrors the server's own hard block in
  // assistant/views.py's answer() (job_description_missing).
  readonly jobDescriptionMissing = () => !this.workingApplication()?.jobDescription;

  constructor() {
    effect(() => {
      this.workingApplication.set(this.application());
    });
  }

  onDescriptionSaved(jobDescription: string): void {
    const current = this.workingApplication();
    if (current) this.workingApplication.set({ ...current, jobDescription });
  }

  askPreset(question: string): void {
    void this.ask(question);
  }

  askCustom(): void {
    const question = this.customQuestionRef().nativeElement.value.trim();
    if (!question) return;
    void this.ask(question);
  }

  private async ask(question: string): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.result.set('');
    this.askedQuestion.set(question);
    try {
      const answer = await generateAnswer(this.profile() || {}, toApplicationContext(this.workingApplication()!), question);
      this.result.set(answer);
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
}
