-- Solo si creaste la base de datos con la primera versión (sin formatos, permisos, caja ni OCR).
-- Si la creas ahora con schema.sql, NO hace falta ejecutar esto.
ALTER TABLE order_lines ADD COLUMN input_qty REAL;
ALTER TABLE order_lines ADD COLUMN input_unit TEXT;
ALTER TABLE order_lines ADD COLUMN unit_label TEXT;
ALTER TABLE receipt_lines ADD COLUMN input_qty REAL;
ALTER TABLE receipt_lines ADD COLUMN input_unit TEXT;
ALTER TABLE receipt_lines ADD COLUMN unit_label TEXT;
ALTER TABLE receipt_lines ADD COLUMN input_price REAL;
ALTER TABLE recipe_lines ADD COLUMN input_qty REAL;
ALTER TABLE recipe_lines ADD COLUMN input_unit TEXT;
CREATE TABLE IF NOT EXISTS product_formats (
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, name TEXT NOT NULL, factor REAL NOT NULL,
  price REAL, is_default INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, UNIQUE (product_id, name));
CREATE INDEX IF NOT EXISTS idx_formats_product ON product_formats(product_id);
CREATE TABLE IF NOT EXISTS inventory_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
  expected REAL, counted REAL NOT NULL, detail TEXT);
ALTER TABLE users ADD COLUMN is_super INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN perms TEXT;
UPDATE users SET is_super = 1 WHERE role = 'direccion';
ALTER TABLE suppliers ADD COLUMN cif TEXT;
CREATE TABLE IF NOT EXISTS cash_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL UNIQUE, cash REAL NOT NULL DEFAULT 0, card REAL NOT NULL DEFAULT 0,
  bizum REAL NOT NULL DEFAULT 0, other REAL NOT NULL DEFAULT 0, cash_out REAL NOT NULL DEFAULT 0, pos_total REAL, covers INTEGER,
  notes TEXT, user_id INTEGER, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);

-- Escaneos de albaranes/facturas y lo aprendido de cada proveedor
CREATE TABLE IF NOT EXISTS ocr_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  provider TEXT,
  supplier_id INTEGER,
  receipt_id INTEGER,
  result TEXT,                          -- datos leídos (JSON)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ocr_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL,
  source TEXT NOT NULL,                 -- texto de la línea del albarán, normalizado
  product_id INTEGER NOT NULL,
  unit TEXT,                            -- unidad o formato en que viene (kg, ud, f:<id>)
  UNIQUE (supplier_id, source)
);
