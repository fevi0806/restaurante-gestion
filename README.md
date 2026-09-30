# Gestión del restaurante — guía de puesta en marcha

Aplicación web para controlar todo el flujo de consumo:

- **Pedidos** a proveedores en el formato en que compras (cajas, sacos, barriles…), con texto listo para WhatsApp o email.
- **Recepción** de mercancía contra albarán, con **escáner**: foto del albarán con el móvil y la app propone las líneas. Si no lo lee bien, se mete a mano.
- **Stock** teórico en peso, litros o unidades, e **inventarios** contando en cajas + sueltos.
- **Existencias**: todo lo que se compra y se guarda en almacén (ingredientes, bebidas, limpieza…), con edición en lista y alérgenos.
- **Carta y escandallos**: los platos que se venden, con su ficha técnica estándar (bruto/neto, mermas de limpieza y cocción, % de varios, 14 alérgenos, elaboración, emplatado, foto, ficha imprimible), gastos fijos imputados, beneficio neto, edición en lista y exportación compatible con Qamarero.
- **Mermas** y **consumo de personal**, por producto (en g, kg, ud, cajas…) o por plato.
- **Caja real del día**: efectivo, tarjeta, Bizum y otros, con descuadre frente al cierre de Qamarero y contador de billetes.
- **Ventas de Qamarero**: importar Excel/CSV, vincular nombres (incluidas medias raciones) y entrada automática.
- **Panel de control** con pestañas y gráficas: resumen, ventas, compras, mermas, food cost e ingeniería de menú, y caja.
- **Informes** descargables en Excel o PDF: resultados, compras, mermas, personal, food cost, ventas, caja, stock, descuadres y gastos.
- **Gastos fijos**.

Todo se guarda en una base de datos de Cloudflare (D1). Cada empleado entra con su usuario.

**Usuarios y permisos.** El primer usuario que se crea es el **superusuario**: lo puede todo y decide con casillas qué ve y qué hace cada persona. Por ejemplo, alguien puede recibir mercancía pero no ver costes, o cerrar la caja pero no ver el histórico. Hay plantillas para ir rápido:

| Plantilla | Qué incluye |
|---|---|
| Sala | Cerrar la caja del día, registrar mermas y consumo de personal, ver fichas de platos (sin costes) |
| Cocina | Pedidos, recepción y escáner, mermas, stock, inventarios, escandallos, productos y costes |
| Dirección | Todos los permisos (sin gestionar usuarios, que es solo del superusuario) |

Se publica en un **subdominio** (por ejemplo `gestion.turestaurante.com`). **No toca la web de WordPress**: el dominio principal sigue igual.

---

## Módulos de control

- **Elaboraciones intermedias** (Carta → Elaboraciones): bechamel, sofrito, alioli, fondos, masas… Se escandallan una vez indicando cuánto producen (p. ej. 5 l) y se usan como ingrediente en los platos. Su coste por kg/l/ud se recalcula solo al cambiar los precios, y heredan los alérgenos. Al **producir** (Carta → Producción) se descuentan sus ingredientes y se suma la elaboración al stock; al vender un plato se descuenta la elaboración.
- **Descuadre por artículo** (Panel → Descuadres): entre recuentos, compara lo que entró con lo vendido por escandallo, las mermas, el consumo de personal y la producción, y dice cuánto falta de cada artículo, en unidades y en euros. Sugiere qué artículos contar.
- **APPCC**: temperaturas de cámaras mañana y tarde (fuera de rango exige medida correctora), plan de limpieza diario/semanal/mensual, temperatura y comprobación del género en recepción, lote y caducidad por línea, lista de caducidades próximas e informe imprimible para la inspección. Trae equipos y un plan básico para empezar.
- **Aprobación de pedidos**: quien tiene el permiso "Aprobar pedidos" (el socio que compra) revisa los pedidos del resto. Cuando alguien guarda un pedido queda **pendiente de aprobar** y la app ofrece avisarle por WhatsApp o email con un toque (con el enlace al pedido); además le sale en sus avisos. El socio puede modificarlo, rechazarlo con un motivo o **aprobarlo y enviarlo al proveedor** por WhatsApp o email. Todo queda en el registro de actividad. El móvil y el email de cada persona se ponen en Usuarios y permisos.
- **Pedido sugerido** (Pedidos → Nuevo): según el consumo de las últimas 4 semanas (ajustado a los días fuertes de la semana), el stock y el mínimo, propone las cantidades para cubrir N días, redondeadas al formato de compra.
- **Avisos** (Inicio): falta dinero en caja, caja sin registrar, subidas de precio de más del 5 %, food cost disparado, mermas por encima de lo normal, descuadres de inventario, stock bajo, pedidos sin llegar, temperaturas pendientes o fuera de rango, caducidades, copias, alérgenos sin revisar, ventas sin vincular y platos sin escandallo. Cada persona ve solo los de su trabajo.
- **Resumen semanal** (Panel → Resumen semanal): la semana de lunes a domingo frente a la anterior, platos más vendidos, mayores descuadres, subidas de precio y cumplimiento del APPCC. Se imprime o se guarda en PDF.

Envío del resumen por email (opcional): Cloudflare solo permite enviar a direcciones verificadas si se activa **Email Routing** en el dominio, y eso **cambia los registros de correo (MX)** del dominio. Si tu correo está en ese dominio con otro proveedor, no lo actives. Si quieres usarlo: activa Email Routing, verifica tu email de destino y añade a `wrangler.toml` `send_email = [{ name = "EMAIL" }]`, `[vars] SUMMARY_TO = "tu@email"`, `SUMMARY_FROM = "resumen@tudominio"` y `[triggers] crons = ["0 7 * * 1"]` (lunes a las 7:00 UTC).

---

## Seguridad y copias

- **Registro de actividad** (solo superusuario): queda anotado quién crea, cambia o borra cada cosa, con el valor anterior (precios, caja, albaranes anulados, mermas borradas…).
- **Bloqueo de contraseña**: tras 5 intentos fallidos desde el mismo dispositivo, ese usuario queda bloqueado 15 minutos.
- **Copias de seguridad**: descarga un archivo con todos los datos para guardarlo fuera de Cloudflare, y permite restaurarlo. La app avisa si pasan más de 7 días sin descargar una copia. Los datos no se borran nunca; Cloudflare además permite volver la base de datos a cualquier momento de los últimos 7 días (Time Travel).

---

## Qué necesitas

- Acceso a la cuenta de Cloudflare donde está el dominio.
- Una cuenta gratuita de GitHub (para la opción recomendada, sin usar terminal).

El plan gratuito de Cloudflare es suficiente para un restaurante.

---

## Opción A (recomendada): sin terminal, con GitHub

### 1. Crear la base de datos

1. En Cloudflare, ve a **Storage & Databases → D1 SQL Database → Create**.
2. Nombre: `restaurante-gestion`. Créala.
3. Entra en la base de datos, pestaña **Console**. Pega todo el contenido de `schema-consola.sql` (la misma estructura que `schema.sql`, sin comentarios) y pulsa **Execute**. Para comprobarlo, escribe `/tables`: deben salir 24 tablas.
4. Copia el **Database ID** que aparece en la página de la base de datos.

### 2. Poner el ID en la configuración

Abre `wrangler.toml` y sustituye `00000000-0000-0000-0000-000000000000` por el Database ID que copiaste.

### 3. Subir el código a GitHub

1. En GitHub: **New repository**, nombre `restaurante-gestion`, **Private**.
2. **Add file → Upload files** y arrastra el contenido de esta carpeta: `src`, `public`, `migrations`, `schema.sql`, `schema-consola.sql`, `wrangler.toml` y este `README.md`.
3. **Commit changes**.

### 4. Crear la aplicación en Cloudflare (Workers)

1. En Cloudflare: **Workers & Pages → Create → Import a repository**.
2. Autoriza GitHub y elige el repositorio `restaurante-gestion`.
3. Deja los valores que propone (el comando de despliegue es `npx wrangler deploy`) y pulsa **Deploy**.

Cloudflare lee `wrangler.toml`: publica las pantallas (`public`), el servidor (`src`), conecta la base de datos (binding `DB`) y la IA gratuita del escáner (binding `AI`). Te dará una dirección tipo `restaurante-gestion.tu-cuenta.workers.dev`.

Para comprobar que el servidor funciona, abre `…workers.dev/api/setup-status`: debe mostrar `{"needsSetup":true}`.

### 5. Poner el subdominio

1. En el Worker: **Settings → Domains & Routes → Add → Custom domain**.
2. Escribe `gestion.tudominio.com` (o el nombre que prefieras). Como el dominio ya está en Cloudflare, el registro DNS se crea solo.
3. En unos minutos tendrás la app con HTTPS en esa dirección.

### 6. Primer acceso (hazlo nada más publicar)

Entra en la dirección nueva. La primera pantalla pide crear el **usuario de dirección**. Hasta que lo hagas, cualquiera que llegue a la URL podría crearlo, así que hazlo en cuanto la publiques.

Cada cambio que subas después a GitHub se publica solo.

---

## Opción B: con terminal (wrangler)

```bash
npm install -g wrangler
wrangler login
wrangler d1 create restaurante-gestion          # copia el database_id a wrangler.toml
wrangler d1 execute restaurante-gestion --remote --file=schema.sql
wrangler deploy
```

Después, añade el subdominio como en el paso 5.

---

## Activar el escáner de albaranes (gratis)

El escáner usa la IA incluida en tu cuenta de Cloudflare (Workers AI). Ya viene activado en `wrangler.toml` (bloque `[ai]`), así que no hay que hacer nada más.

- **Coste: ninguno** en el plan gratuito de Cloudflare. Incluye 10.000 "neuronas" al día; un albarán gasta unas 250, así que caben unos **40 albaranes diarios**.
- Si se agota el cupo, **no cobra**: el escáner deja de funcionar hasta el día siguiente y la app avisa para meter los datos a mano.
- Si algún día pasas tu cuenta de Cloudflare al plan de pago (Workers Paid), lo que supere el cupo diario sí se cobraría. En ese caso, si no quieres ningún coste, borra el bloque `[ai]` de `wrangler.toml`: el escáner se desactiva y todo se mete a mano.
- Lo que no lea bien se corrige en la misma pantalla. La primera vez que asignas una línea de un proveedor a tu producto, la app lo aprende y la siguiente vez la reconoce sola.
- Consejos para la foto: con luz, recta, sin cortar bordes. Si el albarán tiene varias hojas, sube todas a la vez.

---

## Orden recomendado para arrancar

1. **Ajustes**: nombre, IVA de venta (10 % en restauración) y food cost objetivo.
2. **Usuarios y permisos**: da de alta al equipo y marca qué puede hacer cada uno.
3. **Proveedores y productos**: puedes importar un Excel con tus tarifas (nombre, unidad, precio, categoría, proveedor y, si lo trae, formato: "Caja 24", 24 unidades, 14,40 €).
4. **Escandallos → Importar carta**: sube la carta exportada de Qamarero para crear los platos con su PVP. Luego completa los ingredientes de cada plato, empezando por los que más vendes.
5. **Inventario inicial**: haz un recuento completo en *Stock e inventario → Hacer inventario*. Es el punto de partida del stock.
6. **Día a día**: cocina registra albaranes al recibir y todos apuntan mermas y comidas de personal.
7. **Ventas**: importa las ventas de Qamarero (diario o semanal). La primera vez te pregunta a qué plato corresponde cada nombre; después lo recuerda.
8. **Inventario** semanal o quincenal de lo caro (carne, pescado, bebidas) para ver el descuadre real.

---

## Unidades y formatos

Cada producto se controla en **una sola unidad**: kg, litro o unidad. Encima de eso, cada producto puede tener **formatos**:

| Producto | Se controla en | Formatos |
|---|---|---|
| Harina | kg | Saco 25 kg = 25 kg |
| Calamar | kg | (ninguno: se pesa) |
| Coca-Cola 35 cl | ud | Caja 24 = 24 ud |
| Coca-Cola 20 cl | ud | Caja 24 = 24 ud |
| Cerveza de barril | l | Barril 30 l = 30 l |

- **Refrescos de distinto tamaño**: crea un producto por tamaño (35 cl y 20 cl). Cuestan distinto y se venden por separado en Qamarero, así que así sale bien el coste y el recuento.
- **Pedidos y albaranes**: se escriben en el formato en que llega (3 cajas, 2 sacos). La app lo pasa a unidades o kilos y reparte el precio de la caja por unidad.
- **Escandallos**: se escriben en gramos o mililitros (180 g de calamar, 40 ml de aceite). Al vender, la app descuenta ese peso del stock que entró con los albaranes.
- **Inventario**: cada producto tiene una casilla por formato más "sueltos" (por ejemplo, 4 cajas + 5 botellas, o 2 sacos + 3,5 kg). La app suma el total.

---

## Caja del día

Al cerrar, quien tenga permiso apunta el efectivo, la tarjeta, Bizum y otros, y el **cierre Z de Qamarero**. La app calcula el descuadre y el ticket medio. El botón "Contar billetes y monedas" hace el arqueo y descuenta el fondo de caja que se deja. Sin el permiso "Ver el histórico de caja", solo se ven y editan los últimos 7 días.

---

## Ventas de Qamarero y medias raciones

- Cada nombre que venga de Qamarero se vincula a un plato con un **factor**:
  - "Calamares" → Calamares × 1
  - "1/2 Calamares" → Calamares × 0,5 (descuenta la mitad de ingredientes)
- La app propone 0,5 cuando detecta "1/2", "½", "media" o "medio" en el nombre.
- Si la media ración lleva cantidades distintas, crea un plato propio ("Media calamares") con su escandallo y vincúlalo con factor 1.
- Si el archivo trae el **importe**, se usa el importe real. Si no, se usa el PVP de la variante (o el PVP del plato × factor).
- Bebidas sin control, suplementos o propinas: márcalos como **"No es comida"**.
- Los vínculos se revisan en *Ventas Qamarero → Vínculos*. Una importación se puede **deshacer** desde *Historial*.

### Volcado automático

En *Ventas Qamarero → Automático* se genera una clave secreta. Con ella, cualquier sistema puede enviar las ventas a:

```
POST https://gestion.tudominio.com/api/integrations/sales
Authorization: Bearer <clave>
Content-Type: application/json

{ "date": "2026-09-28",
  "source": "Qamarero",
  "rows": [
    { "name": "Calamares", "units": 14, "revenue": 168.00 },
    { "name": "1/2 Calamares", "units": 6, "revenue": 45.00 } ] }
```

- `revenue` es el importe **con IVA** y es opcional.
- También acepta `date_from` y `date_to` para un periodo.
- Los nombres ya vinculados se vuelcan solos; los nuevos quedan en **Pendientes** y el cuadro de mando avisa.

Qamarero no publica una API abierta, así que hay que preguntarles si pueden enviar las ventas a una URL (API o webhook) o mandar el informe diario por email. Con cualquiera de las dos se puede conectar.

---

## Cómo calcula

- **Stock teórico** = entradas − consumo por ventas (según escandallo) − mermas − consumo de personal ± ajustes de inventario.
- **Food cost teórico** = coste de lo vendido según escandallos ÷ ventas sin IVA.
- **Food cost real** = (teórico + mermas + personal + descuadre de inventario) ÷ ventas sin IVA.
- **Gastos fijos del periodo** = equivalente mensual × días del periodo ÷ 30,44.
- **Resultado estimado** = ventas sin IVA − consumo real − gastos fijos del periodo.

La diferencia entre food cost real y teórico es el dinero que se pierde sin explicación: raciones más grandes de la cuenta, producto que desaparece, albaranes sin registrar o escandallos mal ajustados.

---

## Copias de seguridad

Cloudflare D1 guarda un historial (**Time Travel**: 7 días en el plan gratuito, 30 en el de pago) para restaurar la base de datos a cualquier momento. Para una copia descargable:

```bash
wrangler d1 export restaurante-gestion --remote --output=copia.sql
```

---

## Importación masiva

- **Proveedores → Importar Excel**: nombre, CIF, contacto, teléfono, email, días de pedido y notas. Si ya existe uno con el mismo CIF (o, sin CIF, con el mismo nombre), se actualiza; si no, se crea.
- **Productos → Importar Excel**: nombre, unidad, precio, categoría, proveedor, stock mínimo y formato (Caja 24, 24 unidades, 14,40 €). Si el proveedor no existe, se crea.
- En los dos casos hay un botón **Descargar plantilla**. También sirve tu propio Excel: la app pregunta qué columna es cada dato. Las columnas vacías no borran lo que ya había.

---

## Ficha técnica y gastos fijos

Cada plato calcula, por ración:

- **Coste de materia prima** = Σ (peso neto ÷ (1 − merma de limpieza) ÷ (1 − merma de cocción) × precio de compra) + **% de varios** (sal, especias, aceite de fritura; por defecto 3 %, se cambia en Ajustes o en cada ficha).
- **% de coste** sobre el PVP sin IVA, **margen bruto** y **multiplicador**.
- **Gastos fijos imputados** = PVP sin IVA × (gastos fijos mensuales ÷ facturación mensual). La facturación se toma de Ajustes ("facturación mensual prevista") o, si está vacía, de la media real de ventas de Qamarero (o de caja) de los últimos 90 días, con un mínimo de 14 días de datos.
- **Beneficio neto** = PVP sin IVA − materia prima − gastos fijos imputados.
- **PVP recomendado** para el objetivo de coste y **PVP mínimo** sin pérdidas.

Los **alérgenos** se marcan en cada artículo de Existencias y los platos los heredan; en la ficha se añaden los de la elaboración.

**Existencias → Revisar alérgenos** propone los alérgenos de cada artículo: primero con un diccionario de hostelería (harina, gamba, chocos, puntillitas, boquerón, queso, vino…) y, para lo que no reconoce, con la IA gratuita de Cloudflare. Tú confirmas o corriges y se guardan como **revisados**. Los artículos y platos con ingredientes sin revisar se marcan en amarillo. La referencia legal es siempre la etiqueta o ficha técnica del proveedor.

---

## Edición en lista

En **Existencias** y en **Carta** hay un botón **Editar en lista**: una tabla donde se cambian nombre, categoría, precio, proveedor, mínimo o PVP de muchos a la vez, con acciones masivas sobre los marcados (subir o bajar un %, poner categoría, poner proveedor, poner el PVP recomendado). Los cambios se resaltan y se guardan todos juntos.

---

## Exportar la carta a Qamarero

Al importar la carta desde un archivo de Qamarero, la app guarda sus columnas y cada fila. **Carta → Exportar para Qamarero** genera el mismo archivo con los nombres, precios y categorías actuales; los platos nuevos van al final.

---

## Recepción: albarán o factura

Al recibir mercancía se elige si el documento es un **albarán** o una **factura**. El escáner lo detecta solo. Registra una factura solo si la mercancía entra con ella: si la factura agrupa albaranes que ya registraste, no la metas, porque duplicarías el stock.

---

## Actualizaciones

La app **actualiza sola la base de datos** al arrancar una versión nueva: crea las tablas que falten y añade las columnas nuevas, sin tocar los datos. Para actualizar basta con subir a GitHub las carpetas `src` y `public` nuevas.

Si se crea desde cero, tampoco hace falta ejecutar nada: con la base de datos D1 vacía y conectada, la app crea todas las tablas en el primer arranque. (`schema.sql` y `migrations/` quedan como referencia.)

---

## Estructura

```
src/worker.js                Entrada en Cloudflare Workers
src/api.js                   Servidor (login, permisos, toda la lógica)
src/migrate.js               Actualización automática de la base de datos
src/schema.js                Esquema (generado desde schema.sql)
src/email.js                 Resumen semanal por email (opcional)
public/                      Interfaz (HTML, CSS y JS sin compilación)
schema.sql                   Tablas de la base de datos
migrations/                  Cambios para bases de datos creadas con versiones anteriores (se ejecutan en orden)
wrangler.toml                Configuración de Cloudflare
```
