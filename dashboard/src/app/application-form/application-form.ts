// Uncontrolled-form style (read values from the DOM at submit time via
// template refs) rather than two-way [(ngModel)] binding — same pattern
// popup.js already uses (getElementById().value on submit), and avoids any
// reactivity edge cases with this build's zoneless change detection (no
// zone.js dependency was generated — see package.json). [value] bindings for
// pre-filling on edit are one-way and driven by a computed() signal, which
// zoneless change detection tracks natively.
import { Component, ElementRef, computed, input, output, viewChild } from '@angular/core';
import type { Application } from '../applications-service';
import { STATUSES } from '../constants';

export interface ApplicationFormValue {
  jobTitle: string;
  company: string;
  location: string;
  jobUrl: string;
  employmentType: string;
  jobDescription: string;
  status: string;
  applicationDate: string;
  notes: string;
}

@Component({
  selector: 'app-application-form',
  imports: [],
  templateUrl: './application-form.html',
  styleUrl: './application-form.css',
})
export class ApplicationForm {
  // Set to an existing record to edit it; left undefined to add a new one —
  // same dual-purpose form pattern as the popup's "Add Manually" tab.
  readonly editing = input<Application | undefined>(undefined);
  readonly statuses = STATUSES;

  readonly save = output<ApplicationFormValue>();
  readonly cancel = output<void>();

  readonly defaults = computed<ApplicationFormValue>(() => {
    const editing = this.editing();
    return {
      jobTitle: editing?.jobTitle ?? '',
      company: editing?.company ?? '',
      location: editing?.location ?? '',
      jobUrl: editing?.jobUrl ?? '',
      employmentType: editing?.employmentType ?? '',
      jobDescription: editing?.jobDescription ?? '',
      status: editing?.status ?? 'Applied',
      applicationDate: editing?.applicationDate ?? new Date().toISOString().slice(0, 10),
      notes: editing?.notes ?? '',
    };
  });

  private readonly jobTitleRef = viewChild.required<ElementRef<HTMLInputElement>>('jobTitleInput');
  private readonly companyRef = viewChild.required<ElementRef<HTMLInputElement>>('companyInput');
  private readonly locationRef = viewChild.required<ElementRef<HTMLInputElement>>('locationInput');
  private readonly jobUrlRef = viewChild.required<ElementRef<HTMLInputElement>>('jobUrlInput');
  private readonly employmentTypeRef = viewChild.required<ElementRef<HTMLSelectElement>>('employmentTypeInput');
  private readonly jobDescriptionRef = viewChild.required<ElementRef<HTMLTextAreaElement>>('jobDescriptionInput');
  private readonly statusRef = viewChild.required<ElementRef<HTMLSelectElement>>('statusInput');
  private readonly applicationDateRef = viewChild.required<ElementRef<HTMLInputElement>>('applicationDateInput');
  private readonly notesRef = viewChild.required<ElementRef<HTMLTextAreaElement>>('notesInput');

  onSubmit(event: Event): void {
    event.preventDefault();
    this.save.emit({
      jobTitle: this.jobTitleRef().nativeElement.value.trim(),
      company: this.companyRef().nativeElement.value.trim(),
      location: this.locationRef().nativeElement.value.trim(),
      jobUrl: this.jobUrlRef().nativeElement.value.trim(),
      employmentType: this.employmentTypeRef().nativeElement.value,
      jobDescription: this.jobDescriptionRef().nativeElement.value.trim(),
      status: this.statusRef().nativeElement.value,
      applicationDate: this.applicationDateRef().nativeElement.value,
      notes: this.notesRef().nativeElement.value.trim(),
    });
  }
}
