/// <reference types="@cloudflare/workers-types" />
declare namespace App {
  interface Locals {
    cfContext: ExecutionContext;
  }
}
