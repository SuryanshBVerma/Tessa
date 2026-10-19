import { Component } from '@angular/core';

@Component({
  selector: 'app-home',
  template: '<h1>Home</h1><a routerLink="/orders">Orders</a>',
})
export class HomeComponent {}
