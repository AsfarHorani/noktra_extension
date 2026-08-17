import { Component, ElementRef, signal, viewChild } from '@angular/core';
import { ProfileService } from '../profile-service';
import { extractResumeText, UnsupportedResumeFileError } from '../resume-parsing';
import { parseResume } from '../assistant-api';

@Component({
  selector: 'app-resume-upload',
  imports: [],
  templateUrl: './resume-upload.html',
  styleUrl: './resume-upload.css',
})
export class ResumeUpload {
  private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  readonly busy = signal(false);
  readonly error = signal('');
  readonly statusMessage = signal('');

  constructor(private readonly profileService: ProfileService) {}

  triggerFilePicker(): void {
    this.fileInput().nativeElement.click();
  }

  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-selecting the same file later
    if (!file) return;

    this.busy.set(true);
    this.error.set('');
    this.statusMessage.set('Reading file…');

    try {
      const resumeText = await extractResumeText(file);
      if (!resumeText) {
        throw new Error('No text could be extracted from that file — is it a scanned image rather than a text-based document?');
      }

      this.statusMessage.set('Analyzing with Ollama… this can take a little while.');
      const parsed = await parseResume(resumeText);

      await this.profileService.save({
        ...parsed,
        resumeFileName: file.name,
        resumeText,
        uploadedAt: new Date().toISOString(),
      });
      this.statusMessage.set('Profile updated ✓');
    } catch (err) {
      if (err instanceof UnsupportedResumeFileError) {
        this.error.set(err.message);
      } else {
        this.error.set(err instanceof Error ? err.message : String(err));
      }
      this.statusMessage.set('');
    } finally {
      this.busy.set(false);
    }
  }
}
