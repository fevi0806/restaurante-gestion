# Limpieza del catálogo (octubre 2026)

Scripts usados para limpiar artículos y proveedores a partir de una copia de seguridad de la app.
No tocan la base de datos real: generan una copia nueva para restaurar en *Copias de seguridad*.

Orden:
1. `python3 decidir.py <copia.json>` → `decisiones.json` (fusiones, bajas, nombres, categorías, precios de caja, paso a kg/l)
2. `python3 compras.py <copia.json> arranque-restaurante.xlsx` → `compras.json` (facturas de compra mapeadas al catálogo limpio, sin Carrefour)
3. `node apply.mjs <copia.json> decisiones.json compras.json out/copia_limpia.json <ruta>/src` → copia limpia + informe (usa el propio código de la app sobre SQLite en memoria)
4. `python3 revisar.py <copia.json> out/Limpieza_catalogo_revisar.xlsx` → Excel con todos los cambios

Las compras importadas se compensan con un movimiento de «stock inicial» para no cambiar el stock ya regularizado.
