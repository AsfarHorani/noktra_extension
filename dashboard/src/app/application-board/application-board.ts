import { Component, computed, effect, input, output, signal } from '@angular/core';
import { CdkDragDrop, DragDropModule } from '@angular/cdk/drag-drop';
import type { Application } from '../applications-service';
import { STATUS_COLORS, STATUSES } from '../constants';

interface Column {
  status: string;
  color: string;
  apps: Application[];
}

// Huntr-style Kanban board — the flagship "cool feature" requested alongside
// the visual refresh (user: "make it interesting... some cool colors and
// features"). One column per status (STATUSES, so the same 8 statuses the
// table view already exposes), drag a card to a new column to change its
// status. Alternative view to app-application-list on the Jobs page — see
// app.html's List/Board toggle.
@Component({
  selector: 'app-application-board',
  imports: [DragDropModule],
  templateUrl: './application-board.html',
  styleUrl: './application-board.css',
})
export class ApplicationBoard {
  readonly applications = input<Application[]>([]);
  readonly statuses = STATUSES;
  readonly dropListIds = STATUSES.map((s) => `board-col-${s}`);

  readonly edit = output<Application>();
  readonly statusChange = output<{ id: number; status: string }>();
  readonly remove = output<number>();
  readonly coverLetter = output<Application>();
  readonly prepAnswers = output<Application>();

  // A local working copy, separate from applications() — a drop needs to
  // move the card to its new column immediately (optimistic), rather than
  // wait out the update-then-reload round trip in ApplicationsService and
  // have the card visually snap back to its old column for a moment first.
  // Re-synced from the real input whenever it changes (including once the
  // round trip above actually completes, which is a no-op here since the
  // optimistic guess already matches).
  private readonly workingApplications = signal<Application[]>([]);

  constructor() {
    effect(() => {
      this.workingApplications.set(this.applications());
    });
  }

  readonly columns = computed<Column[]>(() => {
    const apps = this.workingApplications();
    return STATUSES.map((status) => ({
      status,
      color: STATUS_COLORS[status],
      apps: apps.filter((a) => a.status === status),
    }));
  });

  dropId(status: string): string {
    return `board-col-${status}`;
  }

  onDrop(event: CdkDragDrop<Application[]>, targetStatus: string): void {
    const app = event.item.data as Application;
    if (!app || app.status === targetStatus) return;
    this.workingApplications.set(
      this.workingApplications().map((a) => (a.id === app.id ? { ...a, status: targetStatus } : a))
    );
    this.statusChange.emit({ id: app.id, status: targetStatus });
  }

  onDelete(app: Application): void {
    if (!confirm(`Delete "${app.jobTitle || 'this application'}"?`)) return;
    this.remove.emit(app.id);
  }

  formatDate(dateStr: string | undefined): string {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString();
  }
}
