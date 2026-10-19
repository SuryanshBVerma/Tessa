import { Component, inject } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { TicketService } from './ticket.service';

@Component({
  selector: 'app-ticket-new',
  standalone: true,
  imports: [ReactiveFormsModule],
  template: `
    <h1>New ticket</h1>
    <form [formGroup]="form" (ngSubmit)="save()">
      <mat-form-field>
        <mat-label>Title</mat-label>
        <input matInput formControlName="title" data-testid="ticket-title" placeholder="Short summary" />
        @if (form.controls.title.invalid && form.controls.title.touched) {
          <mat-error data-testid="ticket-title-error">Title must be between 3 and 120 characters.</mat-error>
        }
      </mat-form-field>
      <button type="submit" data-testid="ticket-submit" [disabled]="form.invalid">Create ticket</button>
    </form>
  `,
})
export class TicketNewComponent {
  private readonly tickets = inject(TicketService);
  protected readonly form = inject(FormBuilder).group({
    title: ['', [Validators.required, Validators.minLength(3)]],
  });

  save() {
    this.tickets.create(this.form.value.title ?? '').subscribe();
  }
}
