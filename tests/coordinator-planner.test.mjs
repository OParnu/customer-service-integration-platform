import assert from "node:assert/strict";
import test from "node:test";
import { buildQueryPlan, QueryPlanningError } from "../dist/services/coordinator/src/planner.js";

test("plans a customer-only request", () => {
  const plan = buildQueryPlan("Show customer C001");
  assert.equal(plan.intent, "customer_lookup");
  assert.deepEqual(plan.steps.map((step) => step.skillId), ["get-customer"]);
});

test("plans customer lookup followed by the latest order", () => {
  const plan = buildQueryPlan("Name of C001 and their Order");
  assert.deepEqual(plan.steps.map((step) => step.skillId), ["get-customer", "get-latest-order"]);
  assert.equal(plan.steps[1].action, "latest_order");
});

test("plans all orders and an order ID lookup", () => {
  assert.equal(buildQueryPlan("Show all orders for C001").steps[1].skillId, "get-all-orders");
  assert.equal(buildQueryPlan("Find order O1001").steps[0].skillId, "get-order-by-id");
});

test("supports Thai order requests with a customer ID adjacent to Thai text", () => {
  const plan = buildQueryPlan("ขอคำสั่งซื้อทั้งหมดของลูกค้าC001");
  assert.equal(plan.customerId, "C001");
  assert.equal(plan.steps[1].skillId, "get-all-orders");
});

test("plans an explicit customer/order pair in customer-first order", () => {
  const plan = buildQueryPlan("Show customer C001 and order O1001");
  assert.equal(plan.intent, "customer_order_lookup");
  assert.deepEqual(plan.steps.map((step) => step.skillId), ["get-customer", "get-order-by-id"]);
});

test("rejects multiple customer IDs instead of silently choosing the first", () => {
  assert.throws(() => buildQueryPlan("Compare C001 and C002"), (error) =>
    error instanceof QueryPlanningError && error.code === "AMBIGUOUS_QUERY");
});

test("rejects missing, malformed, and ambiguous queries", () => {
  for (const query of [undefined, "  ", "hello", "all latest orders for C001"]) {
    assert.throws(() => buildQueryPlan(query), QueryPlanningError);
  }
});
