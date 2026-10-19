import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

export interface Ticket {
  id: number;
  title: string;
}

@Injectable({ providedIn: 'root' })
export class TicketService {
  constructor(private http: HttpClient) {}

  list() {
    return this.http.get<Ticket[]>('/api/tickets');
  }

  create(title: string) {
    return this.http.post<Ticket>('/api/tickets', { title });
  }

  close(id: number) {
    return this.http.put(`/api/tickets/${id}/close`, {});
  }
}
