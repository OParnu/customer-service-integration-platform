CREATE ROLE customer_app LOGIN PASSWORD 'customer_demo_password';
CREATE ROLE order_app LOGIN PASSWORD 'order_demo_password';

CREATE DATABASE customer_db OWNER customer_app;
CREATE DATABASE order_db OWNER order_app;

\connect customer_db
SET ROLE customer_app;
CREATE TABLE customers (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO customers (id, name, email, phone) VALUES
  ('C001', 'Avery Chen', 'avery.chen@example.test', '+66-80-100-1001'),
  ('C002', 'Mina Patel', 'mina.patel@example.test', '+66-80-100-1002');

\connect order_db
SET ROLE order_app;
CREATE TABLE orders (
  id text PRIMARY KEY,
  customer_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'shipped', 'delivered', 'cancelled')),
  total numeric(10, 2) NOT NULL CHECK (total >= 0),
  created_at timestamptz NOT NULL
);
CREATE INDEX orders_customer_created_at_idx ON orders (customer_id, created_at DESC);
INSERT INTO orders (id, customer_id, status, total, created_at) VALUES
  ('O1001', 'C001', 'shipped', 1299.00, '2026-09-15T09:00:00Z'),
  ('O1002', 'C001', 'delivered', 249.50, '2026-08-02T10:30:00Z'),
  ('O2001', 'C002', 'processing', 799.00, '2026-09-20T15:15:00Z');

