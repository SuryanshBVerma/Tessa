import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { OrderListComponent } from './order-list.component';

@NgModule({
  declarations: [OrderListComponent],
  imports: [
    RouterModule.forChild([
      { path: '', component: OrderListComponent, data: { permission: 'orders:read' } },
    ]),
  ],
})
export class OrdersModule {}
