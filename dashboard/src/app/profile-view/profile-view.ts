// Unlike application-form.ts's uncontrolled-form pattern, this uses signals
// for the editable draft — AI-extracted experience/education/projects are
// dynamic lists (add/remove entries), which uncontrolled template refs
// don't handle well. Signal writes are the primitive Angular's zoneless
// change detection is actually built around (the concern that motivated
// avoiding [(ngModel)] elsewhere was two-way *binding sugar*, not signals
// themselves), so this is the more natural fit here, not a regression from
// that earlier decision.
import { Component, effect, signal } from '@angular/core';
import { EducationEntry, ExperienceEntry, Profile, ProfileService, ProjectEntry } from '../profile-service';

@Component({
  selector: 'app-profile-view',
  imports: [],
  templateUrl: './profile-view.html',
  styleUrl: './profile-view.css',
})
export class ProfileView {
  readonly draft = signal<Profile>({});
  readonly savedMessage = signal('');
  readonly showResumeText = signal(false);

  toggleResumeText(): void {
    this.showResumeText.update((v) => !v);
  }

  constructor(private readonly profileService: ProfileService) {
    effect(() => {
      const current = this.profileService.profile();
      // structuredClone so edits here don't mutate the service's signal
      // value directly — only save() below commits the draft back.
      this.draft.set(current ? structuredClone(current) : {});
    });
  }

  updateFullName(value: string): void {
    this.draft.update((d) => ({ ...d, fullName: value }));
  }

  updateEmail(value: string): void {
    this.draft.update((d) => ({ ...d, email: value }));
  }

  updatePhone(value: string): void {
    this.draft.update((d) => ({ ...d, phone: value }));
  }

  updateSummary(value: string): void {
    this.draft.update((d) => ({ ...d, summary: value }));
  }

  skillsText(): string {
    return (this.draft().skills || []).join(', ');
  }

  updateSkills(value: string): void {
    this.draft.update((d) => ({ ...d, skills: splitTags(value) }));
  }

  languagesText(): string {
    return (this.draft().languages || []).join(', ');
  }

  updateLanguages(value: string): void {
    this.draft.update((d) => ({ ...d, languages: splitTags(value) }));
  }

  certificationsText(): string {
    return (this.draft().certifications || []).join(', ');
  }

  updateCertifications(value: string): void {
    this.draft.update((d) => ({ ...d, certifications: splitTags(value) }));
  }

  interestsText(): string {
    return (this.draft().interests || []).join(', ');
  }

  updateInterests(value: string): void {
    this.draft.update((d) => ({ ...d, interests: splitTags(value) }));
  }

  addExperience(): void {
    this.draft.update((d) => ({
      ...d,
      experience: [...(d.experience || []), { title: '', company: '', startDate: '', endDate: '', description: '' }],
    }));
  }

  updateExperience(index: number, field: keyof ExperienceEntry, value: string): void {
    this.draft.update((d) => ({
      ...d,
      experience: (d.experience || []).map((entry, i) => (i === index ? { ...entry, [field]: value } : entry)),
    }));
  }

  removeExperience(index: number): void {
    this.draft.update((d) => ({ ...d, experience: (d.experience || []).filter((_, i) => i !== index) }));
  }

  addEducation(): void {
    this.draft.update((d) => ({
      ...d,
      education: [...(d.education || []), { school: '', degree: '', field: '', startDate: '', endDate: '' }],
    }));
  }

  updateEducation(index: number, field: keyof EducationEntry, value: string): void {
    this.draft.update((d) => ({
      ...d,
      education: (d.education || []).map((entry, i) => (i === index ? { ...entry, [field]: value } : entry)),
    }));
  }

  removeEducation(index: number): void {
    this.draft.update((d) => ({ ...d, education: (d.education || []).filter((_, i) => i !== index) }));
  }

  addProject(): void {
    this.draft.update((d) => ({
      ...d,
      projects: [...(d.projects || []), { name: '', description: '', technologies: '' }],
    }));
  }

  updateProject(index: number, field: keyof ProjectEntry, value: string): void {
    this.draft.update((d) => ({
      ...d,
      projects: (d.projects || []).map((entry, i) => (i === index ? { ...entry, [field]: value } : entry)),
    }));
  }

  removeProject(index: number): void {
    this.draft.update((d) => ({ ...d, projects: (d.projects || []).filter((_, i) => i !== index) }));
  }

  async save(): Promise<void> {
    await this.profileService.save(this.draft());
    this.savedMessage.set('Saved ✓');
    setTimeout(() => this.savedMessage.set(''), 1500);
  }

  async clearProfile(): Promise<void> {
    if (!confirm('Remove the uploaded resume and profile? This cannot be undone.')) return;
    await this.profileService.clear();
  }
}

function splitTags(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
