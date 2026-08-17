import { Component, input, output } from '@angular/core';
import type { Application } from '../applications-service';
import { STATUS_COLORS, STATUSES } from '../constants';

@Component({
  selector: 'app-application-list',
  imports: [],
  templateUrl: './application-list.html',
  styleUrl: './application-list.css',
})
export class ApplicationList {
  readonly applications = input<Application[]>([]);
  readonly statuses = STATUSES;

  statusColor(status: string): string {
    return STATUS_COLORS[status] ?? '#8b86a3';
  }

  readonly edit = output<Application>();
  readonly statusChange = output<{ id: number; status: string }>();
  readonly remove = output<number>();
  readonly coverLetter = output<Application>();
  readonly prepAnswers = output<Application>();

  formatDate(dateStr: string | undefined): string {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString();
  }

  onStatusChange(id: number, event: Event): void {
    const status = (event.target as HTMLSelectElement).value;
    this.statusChange.emit({ id, status });
  }

  onDelete(app: Application): void {
    if (!confirm(`Delete "${app.jobTitle || 'this application'}"?`)) return;
    this.remove.emit(app.id);
  }
}
