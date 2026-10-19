import { Component } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Component({
  selector: 'app-order-list',
  template: `<h1>Orders</h1><button data-testid="refresh-orders" (click)="load()">Refresh</button>`,
})
export class OrderListComponent {
  constructor(private httpClient: HttpClient) {}

  load() {
    return this.httpClient.get('/api/orders');
  }
}
