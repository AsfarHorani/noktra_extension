// Pure client-side counting — no backend, no LLM. Color values now live in
// constants.ts's STATUS_COLORS (see its docstring for the ordinal/status/
// neutral reasoning) — shared with the board/list views so a status is
// always the same color everywhere in the dashboard, not just here.
import { Component, computed, input } from '@angular/core';
import type { Application } from '../applications-service';
import { STATUS_COLORS, STATUSES } from '../constants';

interface FlowRow {
  status: string;
  count: number;
  color: string;
  widthPct: number;
}

const ROW_ORDER: { status: string; color: string }[] = STATUSES.map((status) => ({
  status,
  color: STATUS_COLORS[status],
}));

@Component({
  selector: 'app-stats-flow',
  imports: [],
  templateUrl: './stats-flow.html',
  styleUrl: './stats-flow.css',
})
export class StatsFlow {
  readonly applications = input<Application[]>([]);

  readonly total = computed(() => this.applications().length);

  readonly rows = computed<FlowRow[]>(() => {
    const apps = this.applications();
    const counts = new Map<string, number>();
    for (const app of apps) {
      counts.set(app.status, (counts.get(app.status) ?? 0) + 1);
    }
    const max = Math.max(1, ...ROW_ORDER.map((r) => counts.get(r.status) ?? 0));
    return ROW_ORDER.map((r) => {
      const count = counts.get(r.status) ?? 0;
      return {
        status: r.status,
        count,
        color: r.color,
        // Bar length relative to the largest category, so the biggest bar
        // fills the row and the rest scale honestly against it — never
        // against the (fixed, unrelated) total.
        widthPct: (count / max) * 100,
      };
    });
  });
}
