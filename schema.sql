-- Esquema de la base de datos (Cloudflare D1 / SQLite)
-- Ejecutar una sola vez al crear la base de datos.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO settings(key, value) VALUES ('restaurant_name', 'Mi restaurante');
INSERT OR IGNORE INTO settings(key, value) VALUES ('iva_pct', '10');
INSERT OR IGNORE INTO settings(key, value) VALUES ('food_cost_target', '30');
INSERT OR IGNORE INTO settings(key, value) VALUES ('misc_pct', '3');

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('direccion','cocina','sala')),  -- plantilla de partida
  is_super INTEGER NOT NULL DEFAULT 0,  -- superusuario: lo puede todo y gestiona permisos
  phone TEXT,                           -- para avisos por WhatsApp
  email TEXT,
  perms TEXT,                           -- lista JSON de permisos elegidos para esta persona
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT, phone TEXT, email TEXT, cif TEXT,
  order_days TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'kg',
  price REAL NOT NULL DEFAULT 0,          -- precio de compra por unidad (sin IVA)
  supplier_id INTEGER,
  min_stock REAL NOT NULL DEFAULT 0,
  allergens TEXT,                       -- alérgenos que contiene (lista separada por comas)
  allergens_checked INTEGER NOT NULL DEFAULT 0, -- 1 = alérgenos revisados por una persona
  prep_recipe_id INTEGER,               -- si es una elaboración propia, su ficha
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  old_price REAL, new_price REAL,
  receipt_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'enviado' CHECK (status IN ('borrador','pendiente','enviado','recibido','cancelado')),
  order_date TEXT NOT NULL,
  expected_date TEXT,
  notes TEXT,
  user_id INTEGER,
  approved_by INTEGER,                  -- quién lo aprobó y lo envió al proveedor
  approved_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty REAL NOT NULL,                    -- cantidad en unidad base (kg, l, ud)
  price REAL,                           -- precio por unidad base
  input_qty REAL,                       -- cantidad tal como se pidió (p. ej. 3)
  input_unit TEXT,                      -- unidad elegida: kg, g, l, ml, cl, ud o f:<id de formato>
  unit_label TEXT                       -- texto de la unidad (p. ej. "Caja 24 × 35 cl")
);

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL,
  order_id INTEGER,
  doc_type TEXT NOT NULL DEFAULT 'albaran',  -- 'albaran' o 'factura'
  delivery_note TEXT,          -- nº de albarán o factura
  receipt_date TEXT NOT NULL,
  total REAL NOT NULL DEFAULT 0,
  notes TEXT,
  rec_temp REAL,                        -- temperatura del género al recibirlo (APPCC)
  rec_check INTEGER,                    -- 1 = envases, etiquetado, caducidades y temperatura correctos
  user_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS receipt_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,                  -- por unidad base
  ordered_qty REAL,                     -- en la unidad de entrada
  input_qty REAL,
  input_unit TEXT,
  unit_label TEXT,
  input_price REAL,                     -- precio por unidad de entrada (p. ej. por caja)
  lot TEXT,                             -- lote (trazabilidad)
  expiry TEXT,                          -- fecha de caducidad o consumo preferente
  expiry_done INTEGER NOT NULL DEFAULT 0 -- 1 = ya consumido o retirado
);

-- Todos los movimientos de stock. qty con signo: + entra, - sale.
CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('entrada','merma','consumo_personal','venta','ajuste','produccion')),
  qty REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  reason TEXT,
  notes TEXT,
  label TEXT,
  grp TEXT,
  ref_type TEXT,
  ref_id INTEGER,
  user_id INTEGER,
  mov_date TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inv_date TEXT NOT NULL,
  notes TEXT,
  total_diff_value REAL,
  user_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  category TEXT,
  pvp REAL NOT NULL DEFAULT 0,          -- precio de venta con IVA
  portions REAL NOT NULL DEFAULT 1,
  pos_name TEXT,                        -- nombre tal como aparece en Qamarero
  pos_raw TEXT,                         -- fila original del archivo de Qamarero (para exportar igual)
  notes TEXT,                           -- elaboración
  plating TEXT,                         -- emplatado / presentación
  conservation TEXT,                    -- conservación y regeneración
  prep_time TEXT,                       -- tiempo de elaboración
  misc_pct REAL,                        -- % de varios (sal, especias, aceite de fritura); vacío = el general
  allergens_extra TEXT,                 -- alérgenos añadidos a mano (además de los de sus ingredientes)
  photo TEXT,                           -- foto del emplatado (imagen comprimida)
  author TEXT,
  kind TEXT NOT NULL DEFAULT 'plato',   -- 'plato' (se vende) o 'elaboracion' (bechamel, sofrito, fondos…)
  yield_qty REAL,                       -- elaboración: cantidad que produce la receta
  yield_unit TEXT,                      -- elaboración: kg, l o ud
  product_id INTEGER,                   -- elaboración: su artículo en Existencias
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS recipe_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty REAL NOT NULL,                    -- cantidad neta en unidad base para todas las raciones
  waste_pct REAL NOT NULL DEFAULT 0,    -- % de merma de limpieza
  cook_loss_pct REAL NOT NULL DEFAULT 0,-- % de merma de cocción
  input_qty REAL,                       -- cantidad tal como se escribió (p. ej. 180)
  input_unit TEXT                       -- unidad escrita (p. ej. g)
);

CREATE TABLE IF NOT EXISTS sales_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  filename TEXT,
  rows INTEGER,
  revenue REAL,
  user_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL,
  recipe_id INTEGER NOT NULL,
  sale_date TEXT NOT NULL,
  units REAL NOT NULL,
  revenue REAL NOT NULL DEFAULT 0       -- ventas sin IVA
);

CREATE TABLE IF NOT EXISTS fixed_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concept TEXT NOT NULL,
  category TEXT,
  amount REAL NOT NULL DEFAULT 0,
  frequency TEXT NOT NULL DEFAULT 'mensual' CHECK (frequency IN ('mensual','trimestral','anual')),
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_mov_product ON movements(product_id);
CREATE INDEX IF NOT EXISTS idx_mov_date ON movements(mov_date, type);
CREATE INDEX IF NOT EXISTS idx_mov_grp ON movements(grp);
CREATE INDEX IF NOT EXISTS idx_mov_ref ON movements(ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date);
CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(receipt_date);
CREATE INDEX IF NOT EXISTS idx_rl_recipe ON recipe_lines(recipe_id);

-- Nombres de Qamarero vinculados a un plato (p. ej. "1/2 Calamares" -> Calamares × 0,5)
CREATE TABLE IF NOT EXISTS pos_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pos_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  recipe_id INTEGER NOT NULL,
  factor REAL NOT NULL DEFAULT 1,       -- raciones del plato que representa 1 unidad vendida
  pvp REAL                              -- PVP con IVA de esta variante (opcional)
);

-- Ventas recibidas cuyo nombre aún no está vinculado a un plato
CREATE TABLE IF NOT EXISTS pos_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pos_name TEXT NOT NULL,
  units REAL NOT NULL,
  revenue REAL,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  source TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Formatos de compra y recuento de cada producto
-- Ej.: Coca-Cola 35 cl (unidad base: ud) -> "Caja 24" = 24 ud
--      Harina (unidad base: kg)         -> "Saco 25 kg" = 25 kg
CREATE TABLE IF NOT EXISTS product_formats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  factor REAL NOT NULL,                 -- cuántas unidades base contiene
  price REAL,                           -- último precio de este formato (sin IVA)
  is_default INTEGER NOT NULL DEFAULT 0,-- formato habitual de compra
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (product_id, name)
);
CREATE INDEX IF NOT EXISTS idx_formats_product ON product_formats(product_id);

-- Detalle de cada recuento de inventario
CREATE TABLE IF NOT EXISTS inventory_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inventory_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  expected REAL,
  counted REAL NOT NULL,
  detail TEXT                           -- p. ej. "2 × Caja 24 + 5 ud"
);

-- Caja real de cada día (lo que de verdad entra) y su cuadre con el cierre de Qamarero
CREATE TABLE IF NOT EXISTS cash_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL UNIQUE,
  cash REAL NOT NULL DEFAULT 0,         -- ventas cobradas en efectivo
  card REAL NOT NULL DEFAULT 0,         -- tarjeta / datáfono
  bizum REAL NOT NULL DEFAULT 0,        -- Bizum / transferencia
  other REAL NOT NULL DEFAULT 0,        -- otros (vales, plataformas de reparto…)
  cash_out REAL NOT NULL DEFAULT 0,     -- pagos hechos con dinero de la caja
  pos_total REAL,                       -- total del cierre Z de Qamarero (con IVA)
  covers INTEGER,                       -- comensales
  notes TEXT,
  user_id INTEGER,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

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

-- Registro de actividad: quién hizo qué y cuándo
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT DEFAULT CURRENT_TIMESTAMP,
  user_id INTEGER,
  user_name TEXT,
  action TEXT,                          -- alta, modificación, baja, anulación…
  entity TEXT,                          -- artículo, albarán, caja…
  entity_id TEXT,
  summary TEXT,                         -- descripción legible
  detail TEXT                           -- datos (JSON)
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

-- Intentos fallidos de entrada (para bloquear ataques de contraseña)
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  k TEXT NOT NULL,
  at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_login_k ON login_attempts(k, at);

-- APPCC: equipos de frío/calor y sus temperaturas
CREATE TABLE IF NOT EXISTS appcc_equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'refrigeracion',  -- refrigeracion, congelacion, caliente, otro
  min_temp REAL,
  max_temp REAL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS appcc_temps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  shift TEXT,                           -- mañana / tarde
  temp REAL NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  action TEXT,                          -- medida correctora si está fuera de rango
  user_id INTEGER,
  at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_temps_day ON appcc_temps(day);
-- APPCC: plan de limpieza
CREATE TABLE IF NOT EXISTS appcc_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  zone TEXT,
  frequency TEXT NOT NULL DEFAULT 'diaria',    -- diaria, semanal, mensual
  product TEXT,                         -- producto de limpieza / método
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS appcc_cleaning (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  notes TEXT,
  user_id INTEGER,
  at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_clean_day ON appcc_cleaning(day);
