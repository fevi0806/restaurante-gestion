import sys, os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# Decide la limpieza del catálogo: fusiones, bajas, nombres, categorías, unidades y precios por caja.
# Genera decisiones.json (para aplicar) y la lista de cambios para revisar.
import json, re, sys, unicodedata, collections

SRC = sys.argv[1]
B = json.load(open(SRC))
T = B['tables']
P = {p['id']: p for p in T['products'] if p['active']}
SUP = {s['id']: s for s in T['suppliers']}

def nk(s):
    s = unicodedata.normalize('NFD', str(s or '')).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'\s+', ' ', s.replace('"', '').strip())

BYNAME = collections.defaultdict(list)
for p in P.values(): BYNAME[nk(p['name'])].append(p['id'])
missing = []
def pid(name):
    ids = BYNAME.get(nk(name))
    if not ids: missing.append(name); return None
    return ids[0]

stock = collections.defaultdict(float)
for m in T['movements']: stock[m['product_id']] += m['qty']
opening_ids = {i['id'] for i in T['inventories'] if (i['notes'] or '').startswith('[arranque]')}
counted = collections.defaultdict(float)
for l in T['inventory_lines']:
    if l['inventory_id'] in opening_ids: counted[l['product_id']] += l['counted']
in_recipe = {l['product_id'] for l in T['recipe_lines']}

merges = []      # (target_id, [(source_id, factor)], nombre_final o None, nota, revisar)
bajas = {}       # id -> motivo
updates = collections.defaultdict(dict)  # id -> {name, category, unit, price, formats:[...]}
review = []      # (tipo, artículo, propuesta, motivo)
used = set()

def merge(target, sources, final=None, note='', revisar=False):
    t = pid(target)
    srcs = []
    for s in sources:
        name, f = (s if isinstance(s, tuple) else (s, 1))
        i = pid(name)
        if i and i != t and i not in used: srcs.append((i, f))
    if not t or not srcs: return
    if t in used and not any(m[0] == t for m in merges): return
    used.add(t); [used.add(i) for i, _ in srcs]
    merges.append((t, srcs, final, note, revisar))

def baja(name_or_id, why):
    i = name_or_id if isinstance(name_or_id, int) else pid(name_or_id)
    if i and i not in used: bajas[i] = why; used.add(i)

# ---------------------------------------------------------------- 1) líneas de factura que no son artículos
JUNK = re.compile(r"\s*(\((factura rectificativa[^)]*|producto regalo|promoci[oó]n|regalo|dto\.? ?100 ?%|abono|canjeo|lote[^)]*|albar[aá]n[^)]*|deposito|depósito)\)|\[rectificativa\]|- albar[aá]n.*$|\(\s*\))", re.I)
def base_name(n): return re.sub(r'\s+', ' ', JUNK.sub('', n)).strip(' -')
for p in list(P.values()):
    if JUNK.search(p['name']) and not re.search(r'dep[oó]sito', p['name'], re.I):
        b = base_name(p['name'])
        tgt = [i for i in BYNAME.get(nk(b), []) if i != p['id']]
        if tgt and P[tgt[0]]['unit'] == p['unit']:
            merges.append((tgt[0], [(p['id'], 1)], None, 'línea de abono/regalo/rectificativa de la misma factura', False)); used.add(p['id'])
        elif tgt:
            bajas[p['id']] = 'abono o regalo en otra unidad: no es género'; used.add(p['id'])
        else:
            updates[p['id']]['name'] = b
# los "merges" anteriores pueden apuntar al mismo destino: se agrupan al aplicar

# ---------------------------------------------------------------- 2) no es género: baja
NOT_STOCK = ['Menaje y utensilios', 'Decoración y otros']
KEEP_FROM_MENAJE = {'ALFALFA GERMINADA BOL.150G', 'BROCHETA MPRO BAMBU AMARILLA', 'BROCHETA UNIC 15CM 100U', 'PINCHO BAMBU 12CM MAYA 200U',
                    'TAPA VASO TO GO 10CL 100U', 'VASO TO GO 4OZ 10CL 80U', 'VASO PP BETIK REU.430ML. 20U', 'ESTROPAJO MICAL ACERO INOX.6U'}
for p in P.values():
    if p['category'] in NOT_STOCK and p['name'] not in KEEP_FROM_MENAJE and p['id'] not in used:
        baja(p['id'], 'utensilio, menaje o decoración: no es género que se consuma')
for n in ['MESA NEGRA BAJA USADA CRUZCAMPO 75*75*70', 'SILLA NEGRA USADA CRUZCAMPO PLASTICO', 'EXPOSITOR PARA INFUSIONES', 'COPA CRUZCAMPO 38CL',
          'VASO CANON CRUZCAMPO 55 CL', 'CUBO CHAMPAGNE GALVANIZADO ZINC 24L.', 'CUCHARA CAFE MADRID', 'PLATO CAFE CON LECHE 138MM CAJA 6UNDS (DROMEDARIO)',
          'PLATO CAFE SOLO 123MM CAJA 6 UNIDADES (DROMEDARIO)', 'TAZA CAFE CON LECHE 19CL CAJA 6UNDS (DROMEDARIO)', 'TAZA PREMIUM CAFE CORTADO 14CL CAJA 6 UNIDADES (DROMEDARIO)',
          'TAZA PREMIUM CAFE SOLO 7CL CAJA 6 UNIDADES (DROMEDARIO)', 'DISPEN.SUPREMINOX SALSAS TRANSP.1L', 'DISPENSADOR SALSAS 720 TRANSP.', 'DOSIFICADOR SALSAS BCO 35CL',
          'MARTILLO ABLANDA CARNE R.60431', 'PELADOR TOMATES INOX 11CM', 'CUCHILLO PUNTILLA UNIV 75MM', 'BANDEJA CAMARERO 40CM', 'BANDEJA MACOPACK ALUM.RDA+TAPA 50L',
          'BANDEJA OVAL BORDE VUELTO 35CM', 'MANTEL AJEDREZ 30X40CM', 'SERVILLETERO CUADRADO NATURAL', 'GUANTE TELA SILICONA', 'CAZO SALSA BAGUETTE INOX 19CM',
          'CUCHILLO PAN RIVIERA 200MM', 'MANGA PASTELERA MPRO 23X45 100', 'MOLDE BRIOCHE ENTERO', 'PINCEL PASTELERIA INOX', 'RACIONADOR HELADO 67066',
          'RACIONADOR HELADO INOX MPRO5CM', 'TARROS CONSERVA VIDRIO 350CC', 'BOWL APERITIVO PORCEL 17,5X4,5CM TAURO 4', 'BÁSCULA PRINCESS KITCHEN SCALE PURE',
          'C DUNKEL 38CL. T 6U', 'C HAVANA 62CL T 6U', 'C MENCIA 58CL. T 6U', 'CESTA MPRO UNI 50X50 10,5CM AL', 'CESTA TEXTIL COLOR NATURAL', 'CONTENEDOR ARAVEN PP C/T 8L',
          'CUBIDRAP BOTELLAS ALG/NEGRO', 'CUCHI SANTOKU AZUL MPRO 180MM', 'ESPOLVOREADOR MALLA MPRO 7X13', 'PAELLERA HONDA ESMALT.45CM VAE', 'PALILLERO REC. REDON',
          'PIEDRA AFILAR DOS CARAS 23CM', 'RASCADOR PLANCHA SUPREMINOX PROFE', 'RECIPIENTE DE 6 COMPARTIMENTOS', 'SET 6 TABLAS MPRO 37X29CM', 'SISTEMA VILEDA FREGADO TURBO SMART',
          'SOPLETE HOSTELERIA MPRO', 'V.CONIL 47CL. T 12U', 'V.MAXI 50CL. T 12U', 'V.TUVO 33CL R 24U', 'VASO HEINEKEN SILVER 35CL', 'VASO MADRIS', 'VASO PAULANER TRIGO 50 CL',
          'Aquaservice 20 L. cortesía', 'CO2 10KG']:
    if n == 'CO2 10KG': continue
    baja(n, 'utensilio, mobiliario o material de promoción: no es género')
for n in ['PRESTACION SERVICIOS', 'SERVICIO AMBIENTACION - CUATRO NEUTRALIZADORES', 'Plan Ahorro hasta 2 unidades', 'Plan Ahorro hasta 2 unidades (Albarán 474177 05/08/2026)',
          'TOTAL', 'CRUZCAMPO ESPECIAL BARRIL 50L (abono)', 'JAMON BELLOTA 100% IBERICO (abono)', 'BOTELLA JOHNNIE WALKER RED 70 CL SCHWEPPES (Promoción)',
          'Queso con pistachos - 28 cm | Tartas de queso 28 cm [rectificativa]', 'Queso Payoyo - 28 cm | Tartas de queso 28 cm (Lote:040826/QPY) [rectificativa]',
          'LIPTON TE MELOCOTON 350 RET (24U) (Promoción)', 'LIPTON TE MELOCOTON 350 RET (24U) (Regalo)', 'SALSA LEA&PERRINS', 'ROMERO BIO CARREFOUR', 'ALBAHACA BIO CARREFOUR',
          'BOLSA BASURA CDC 30L', 'PAPEL HIGIENICO CDC 2C 24R', 'MANZANA GOLDEN CDC', 'ZANAHORIA CDC 500G', 'HOGAZA EL MOLINO DIA', 'BARRA DE PAN DIANA', 'PAN CANDEAL 500 G',
          'SECAMANOS LAMINADO PASTA ECO LOTE 6', 'Patatas', 'Pepino (unidad)', 'Bolsa', 'BOLSAS PLASTICO', 'SUPER ARCOS BOLSA AS', 'BOLSA 50% RECICLADA']:
    if n in ('SALSA LEA&PERRINS',): continue
    baja(n, 'compra puntual, servicio o línea de factura sin género')

# ---------------------------------------------------------------- 3) repetidos (mismo producto con otro nombre). Factor = cuántas unidades del principal es 1 del repetido
G = [
 # aceites
 ('Aceite de girasol alto oleico (freír)', [('ACEITE CAPIPLUS GIRASOL 25L', 25), ('ACEITE GIRASOL ALTO OLEICO 25L (MARIAHELENA)', 25), ('ACEITE CAPIPLUS ALTO REND.LATA 20L', 20), ('ACEITE GIRASOL ALTO OLEICO 7.5L MASTERFRIT (BORGES)', 7.5)], None, 'aceite de freír: mismas compras con distinta marca/envase'),
 ('Aceite de oliva virgen extra', [('ACEITE DE OLIVA VIRGEN EXTRA 5L', 5), ('ACEITE ENORO V.EXT 5L', 5), ('ACEITE GOURMET VIRGEN 5L 0.7o', 5)], None, ''),
 ('ACEITE DE OLIVA SUAVE 5L EL MOLINO', ['ACEITE GOURMET OLIVA SUAVE 5L 0.4º', 'ACEITE CAPICUA ESP.COCINAR 5L', 'CAPICUA ACEITE SUAVE', 'ACEITE DE OLIVA', 'ACEITE OLIVA INTENSO'], 'Aceite de oliva suave (garrafa 5 l)', 'revisa: varias marcas de aceite de oliva suave', True),
 ('Mayonesa (cubo)', [('MAYONESA YBARRA CUBO 5L', 5), ('Mayonesa NCM Cubo 5 L. (Dto. 100%)', 5)], None, ''),
 ('Tomate frito', [('TOMATE QUALITY FRITO 2,5K', 2.5)], None, ''),
 ('Pimentón dulce', [('PIMENTON VEGACACERES DULCE D.O.750G', 0.75)], None, ''),
 ('Pimentón picante', [('PIMENTON QUALITY PICA.MOST.800G', 0.8)], None, ''),
 ('SAL QUALITY COCINA GRUESA 5K \\P', ['SAL QUALIY COCINA GRUESA 5K\\P', 'SAL ECONOMY COCINA GRUESA 5K\\P'], 'Sal gruesa (saco 5 kg)', ''),
 ('SAL QUALITY COCINA FINA 5K \\P', ['SAL ECONOMY COCINA FINA 5K \\P'], 'Sal fina (saco 5 kg)', ''),
 ('Bandeja romero', ['ROMERO BDJA. P.U.'], 'Romero fresco (bandeja)', ''),
 ('Bandeja tomillo', ['TOMILLO BDJA. P.U.'], 'Tomillo fresco (bandeja)', ''),
 ('VINAGRE GOURMET BCO.2L', [], None, ''),
 # cervezas de barril
 ('Cerveza Cruzcampo Especial (barril)', [('CRUZCAMPO ESPECIAL BARRIL 50L', 1)], None, ''),
 ('Cerveza Cruzcampo 1870 (barril)', [('18/70 LA RUBIA BARRIL 30L', 30)], None, ''),
 ('Cerveza Heineken 0,0 (barril)', [('HEINEKEN 0,0% 20L BARRIL DAVID', 20)], None, ''),
 ('Cerveza Paulaner (barril)', [('PAULANER HEFE-WEISSBIER BARRIL 30L', 30)], None, ''),
 # refrescos y aguas
 ('Coca-Cola 35 cl', ['COCACOLA VR35 C24'], 'Coca-Cola 35 cl (vidrio)', ''),
 ('Coca-Cola Zero 35 cl', ['COCACOLA ZER VR35 C24.', 'Coca col zero zero 35cl'], 'Coca-Cola Zero 35 cl (vidrio)', 'revisa: "Coca col zero zero 35cl" lo dio de alta Zulema; ¿es Zero o Zero Zero?', True),
 ('COCACOLA VR237 C24.', ['Coca Cola 33cl peq'], 'Coca-Cola pequeña 23,7 cl (vidrio)', 'revisa: la carta usa la VR237 como "Coca-cola pequeña"; Zulema la llamó "33cl peq"', True),
 ('COCACOLA ZER VR237 C24', ['Coca Cola zero 33cl peq', 'COCA COLA ZERO P12'], 'Coca-Cola Zero pequeña 23,7 cl (vidrio)', 'revisa: igual que la anterior; "COCA COLA ZERO P12" tenía el mismo recuento', True),
 ('Fanta Naranja 35 cl', ['FANTA NAR VR35 C24'], 'Fanta Naranja 35 cl (vidrio)', ''),
 ('FANTA LIM VR35 C24', [], 'Fanta Limón 35 cl (vidrio)', ''),
 ('FANTA NAR VR237 C24', ['Fanta naranja 33cl peq'], 'Fanta Naranja pequeña 23,7 cl (vidrio)', 'revisa: "Fanta naranja 33cl peq" de Zulema', True),
 ('FANTA LIM VR237 C24.', ['Fanta limón 33cl peq'], 'Fanta Limón pequeña 23,7 cl (vidrio)', 'revisa: "Fanta limón 33cl peq" de Zulema', True),
 ('AQUARIUS VR30 C24', ['AQUARIUS LIMON'], 'Aquarius limón 30 cl (vidrio)', ''),
 ('AQUARIUS NAR VR30 C24', ['AQUARIUS NARANJA'], 'Aquarius naranja 30 cl (vidrio)', ''),
 ('Fuze Tea 30 cl', ['FUZE LIMON VR30 C24', 'FUZE TEA LIMON'], 'Fuze Tea limón 30 cl (vidrio)', ''),
 ('FUZE GTM VR30 C24.', ['FUZE TEA MARACUYA'], 'Fuze Tea maracuyá 30 cl (vidrio)', 'revisa: GTM = té verde maracuyá', True),
 ('AQUABONA VR50 C20', ['Agua pequeña'], 'Agua Aquabona 50 cl (vidrio)', 'revisa: "Agua pequeña" de Zulema', True),
 ('AQUABONA VR1L C12', ['Agua grande', ('CAJA+BOT.AQUABONA VR1L', 12)], 'Agua Aquabona 1 l (vidrio)', 'revisa: "Agua grande" de Zulema; y las cajas de agua contadas (CAJA+BOT…) como cajas de 12', True),
 ('SPRITE VR20 C24', ['7up', 'SEVEN UP ZERO'], 'Sprite 20 cl (vidrio)', 'revisa: Zulema contó "7up" y "Seven Up Zero"; ¿es Sprite o 7Up?', True),
 ('RBLISS TON WTR VR20 C24', ['Tónica bliss', 'Tónica'], 'Tónica Royal Bliss 20 cl', ''),
 ('RBLISS ARO BER VR20 C24', ['Tónica bliss berry'], 'Tónica Royal Bliss Berry 20 cl', ''),
 ('RBLISS GINGER ALE VNR20 C24', ['TONICA GINGER ALE'], 'Ginger Ale Royal Bliss 20 cl', ''),
 ('SCH 28U TONICA 200ML RETORNABLE', ['TONICA ORIGINAL', 'SCHWEPPES PREMIUM'], 'Tónica Schweppes 20 cl', ''),
 ('Gaseosa La Casera', [('LCA GASEOSA 1LT (12)', 12), ('Casera blanca 0.5', 0.5)], None, 'revisa: "Casera blanca 0.5" de Zulema va en botellas de 0,5 l', True),
 ('La Casera limón', [('LA CASERA LIMON 1,5L', 1.5), ('LCA LIMON 1LT (12)', 12), ('Casera limón 0.5', 0.5)], None, 'revisa', True),
 ('MINUTE MAID PIN VNR20 C24', ['Zumo de piña'], 'Zumo Minute Maid piña 20 cl', ''),
 ('MINUTE MAID MEL VNR20 C24', ['Zumo de melocotón'], 'Zumo Minute Maid melocotón 20 cl', ''),
 ('PASCUAL BATIDO CACAO CRISTAL 195CC C12', ['Batido de chocolate'], 'Batido Pascual cacao 19,5 cl', ''),
 ('CRUZCAMPO SIN GLUTEN BOT NR 33CL C12', [], 'Cruzcampo sin gluten 33 cl', ''),
 ('Amstel 0,0 Oro 33 cl', ['AMSTEL ORO 0,0% BOT RET 33CL C24'], None, ''),
 ('Cruzcampo Radler 33 cl', ['CRUZCAMPO RADLER LIMON BOT RET 33CL C24'], None, ''),
 ('TINTO LIMON 0,0% CASERA RETORNABLE 275ML (24)', [], 'Tinto de verano Casera limón 0,0 27,5 cl', ''),
 ('COCACOLA PET 2L', ['BIPACK C.COLA 2X2 L'], 'Coca-Cola 2 l (PET)', ''),
 ('COCACOLA ZERO PET 2L', ['REFR COCA ZERO 2X2 L'], 'Coca-Cola Zero 2 l (PET)', ''),
 ('NESTEA LIMON PET 1,5L', ['NESTEA LIMON'], None, ''),
 ('LIMCA PET1L C12', ['LIMCA LCC PET1L C12'], None, ''),
 # vinos y licores
 ('Vino Carramimbre Roble', [('CARRAMIMBRE ROBLE CAJA 6', 0.75)], None, ''),
 ('Vino Pez Volador Frizzante', [('FRIZZANTE EL PEZ VOLADOR CAJA 6', 0.75)], None, ''),
 ('Vino Ha Pasado un Ángel', [('HA PASADO UN ANGEL SEMIDULCE C/ 6', 0.75)], None, ''),
 ('Vino López Cristóbal Roble', [('LOPEZ CRISTOBAL ROBLE LA LINDE', 0.75)], None, ''),
 ('Vino Croft Twist', [('CROFT TWIST FRIZANTE BOT 75CL UNID', 0.75)], None, ''),
 ('Vino Beronia Verdejo', [('BERONIA RUEDA VERDEJO BOT 75CL UNID', 0.75)], None, ''),
 ('Fino Tío Pepe', [('TIO PEPE FINO BOT 75CL UNID', 0.75), ('TIO PEPE FINO BOTELL', 0.75)], None, ''),
 ('Jose Pariente(Botella)', ['VINO TINTO CRIANZA'], 'José Pariente (botella)', 'revisa: la carta descuenta "José Pariente" de "VINO TINTO CRIANZA"', True),
 ('BERONIA CRIANZA(BOTELLA)', [], 'Beronia Crianza (botella)', ''),
 ('Entrechuelos cza. tercer año 75 cl c/ 6', ['VINO TERCER AÑO CRIANZA ENTRECHUELOS'], 'Entrechuelos Crianza Tercer Año (botella)', ''),
 ('ENTRECHUELOS CHARDONNAY 75 CL CAJA 6', ['VINO BLANCO CHARDONNAY LTO. ENTRECHUELOS'], 'Entrechuelos Chardonnay (botella)', ''),
 ('Victoria pariente rosado magnum caja 6', [], 'Victoria Pariente rosado Magnum (botella)', ''),
 ('VICTORIA PARIENTE ROSADO CAJA 6', [], 'Victoria Pariente rosado (botella)', ''),
 ('Dominio de atauta 3/4 caja 6', [], 'Dominio de Atauta (botella)', ''),
 ('Vino tinto (para tinto de verano)', [('Tinto para tinto de verano 5L', 5)], None, 'revisa: Zulema lo contó en garrafas de 5 l', True),
 ('Vermut de grifo', [('VERMUT 5L', 5), ('VERMUT ZARRO ROJO DE GRIFO 1 LTR. C/ 6', 1)], None, ''),
 ('Ron Barceló Añejo', [('RON BARCELO AÑEJO 0,70 L (C12)', 0.7)], None, ''),
 ('Ginebra Beefeater', [('Ginebra Beefeater 0,70 L. (C6)', 0.7), ('GIN BEEFEATER 70CL', 0.7)], None, ''),
 ('Ginebra Seagram\'s', [('Gin Seagram´s 0,70L (C6)', 0.7)], None, ''),
 ('J Walker Red 15% 70cl (C6)', ['Whisky JW Red Soul 70cl (C6)'], 'Whisky Johnnie Walker Red (botella)', 'revisa: ¿Red Soul es otro?', True),
 ('Ginebra Tanqueray 0,0º 0,70L (C6)', [], 'Ginebra Tanqueray 0,0 (botella)', ''),
 ('Tanqueray Ten (C6)', [], 'Ginebra Tanqueray Ten (botella)', ''),
 ('White label', [], 'Whisky White Label (botella)', ''),
 ('BRANDY TERRY 1L', [], None, ''),
 # carne
 ('Carrillada ibérica', [('CARRILL.IBER.VACIO CAJA CONG', 1)], None, ''),
 ('Carne picada para burger (retinto)', ['PICADA BURGER MEAT RETINTO E/K'], None, ''),
 ('PICADA MIXTA VACUNO/CERDO', [('PICADA MIXTA 800G(G)', 0.8), ('CARNE PICADA ELPOZO MIXTA 800G', 0.8)], 'Carne picada mixta', ''),
 ('COSTILLA EXTRA', ['Costilla extra carnuda'], 'Costilla de cerdo extra', ''),
 ('Lomo ciervo', ['Lomo venao'], 'Lomo de ciervo', ''),
 ('Ragout de ciervo', ['Ragout de venado', 'Ragout venao'], None, ''),
 ('Jamon bellota 100% iberico', [], 'Jamón bellota 100 % ibérico', ''),
 ('PLUMA IBERICA', [], 'Pluma ibérica', ''),
 ('Riñones', ['RIÑONES FRESCO (lote 3826)'], None, ''),
 ('Manteca iberica (unidad)', [], None, ''),
 ('Chicharron Confitado 1.5 Kg', [], None, ''),
 ('LAGARTILLO DE BELLOTA IBERICO', [], None, ''),
 # pescado
 ('Calamar en anillas', ['CALAMAR ANILLAS MARAGON'], None, ''),
 ('Choco limpio', ['CHOCO LIMPIO CONGELADO', 'CHOCO LIMPIO IQF 2000/3000', 'CHOCO LIMPIO G ELABORADO (Sepia Officinalis)'], None, ''),
 ('Tiras de choco', ['CHOCO EN TIRAS CONGELADO', 'TIRAS DE CHOCOS LIONZAMAR', 'TIRAS DE CHOCO MARROC C/12KG'], None, ''),
 ('Cola de gambón', ['COLA DE GAMBON Nº1 CONGELADO'], None, ''),
 ('Boquerón', ['BOQUERON CAJA (Engraulis encarasicolus)'], None, ''),
 ('Lubina', ['LUBINAS (Dicentrarchus labrax)'], None, ''),
 ('Hueva de merluza', ['HUEVA DE MERLUZA CONGELADA'], None, ''),
 ('Pavía de merluza', ['PAVIAS MERLUZA GRANEL'], None, ''),
 ('Ortiguilla prefrita', ['ORTIGUILLA PREFRITA GRANEL'], None, ''),
 ('Puntillitas', ['PUNTILLAS CONGELADAS EXTRA', 'PUNTILLAS CONGELADOS EXTRA', 'PUNTILLA MARRUECOS MARROC C/7KG'], None, ''),
 ('Pulpo', ['PULPO T-1 CONGELADO'], None, ''),
 ('Atún rojo (tacos de lomo)', ['TACOS DE LN ATÚN ALM CONG SIN COLA/SOL', 'TACOS DE LOMO ATUN ALM CONG SIN COLA/SOL'], None, ''),
 ('Solomillo de atún', ['SOLOMILLO DE ATÚN CONGELADO'], None, ''),
 ('Sardina ahumada (lomos)', [('Lomos de sardina ahumada 1000 gr', 1)], None, ''),
 ('Mejillón en su jugo', [('CUBO DE MEJILLONES EN SU JUGO', 2.5), ('CUBA DE MEJILLONES EN SU JUGO', 2.5)], None, 'revisa: el cubo se compra por unidad; pon el formato del cubo', True),
 ('CAELLA TACO', ['CAELLA TAQUITOS CONGELADA'], 'Cazón en tacos', ''),
 ('Almeja japonesa', ['ALMEJA JAPONESA CARRIL'], None, ''),
 ('Melva en aceite', [('FILETE MELVA MONTEY ACEITE RO-1000', 0.65)], None, ''),
 ('Gamba pelada', [('GAMBA PELADA MARAGON 180GR', 0.18)], None, ''),
 # verdura y fruta
 ('PATATA BLANCA', [('Caja patata blanca', 18)], 'Patata blanca', 'revisa: "Caja patata blanca" se pasa a kg suponiendo cajas de 18 kg (18 € la caja)', True),
 ('Patata guarnición', [('PATATA GUARNICIÓN C-12,5K E/CAJA', 12.5)], None, ''),
 ('Zanahoria', ['ZANAHORIA BOL.5K E/K', ('Zanahoria bol.5k e/k (unidad)', 5)], None, ''),
 ('CEBOLLA', ['Cebolla blanca'], 'Cebolla', ''),
 ('Bolsa ajo pelado', ['AJO PELADO BCO.BOL.1K', 'AJO BLANCO PELADO MC BL 1KG'], 'Ajo pelado (bolsa 1 kg)', ''),
 ('MANOJO PEREJIL', ['Perejil'], 'Perejil (manojo)', ''),
 ('BANDEJA CILANTRO', ['CILANTRO BDJA.P.U.'], 'Cilantro (bandeja)', ''),
 ('Pimiento padrón', [('PIMIENTO PADRON 1K P.U', 1)], None, ''),
 ('Pimiento verde', ['PIMIENTO VERDE PAIS E/K', 'PIMIENTO ITALIANO E/K', 'Pimiento freir'], None, 'revisa: verde, italiano y de freír', True),
 ('PIMIENTO ASAR', ['Pimiento asar avenado'], 'Pimiento rojo de asar', ''),
 ('TOMATE MARTINETE TRITUR.2,5K', ['MARTINETE TOMATE TRI'], 'Tomate triturado Martinete 2,5 kg', ''),
 ('Tomate cherry', [], None, ''),
 ('PEPINO', [], 'Pepino', ''),
 ('ENSALADA QUALITY MEZCLUM 500G', ['MEZCLUM MC BL 300G', 'ENSALADA QUALITY SELEC.500G'], 'Mezclum (bolsa)', ''),
 # lácteos
 ('Leche entera', [('LECHE GOURMET ENT.1L', 1), ('COLOMBRES LECHE ENTE', 1)], None, ''),
 ('LECHE ASTURIANA S/LACT. ENT. 1L', [('LECHE ASTURIANA S/LACT.ENT.1L', 1), ('LECHE GOURMET S/LACT.ENT.1L', 1)], 'Leche sin lactosa entera', ''),
 ('Huevo líquido dovo 1l.', [('HUEVO LIQUIDO DOVO 1L', 1)], 'Huevo líquido (brik 1 l)', ''),
 ('Queso cheddar en lonchas', [('LONCHAS ECONOMY SABOR CHEDDAR 1K', 1), ('QUESO QUALITY CHEDDAR LONCH. 1K', 1), ('QUESO GIORNO CHEDDAR LONCH.500G', 0.5)], None, ''),
 ('CREMA QUESO MEZCLA UNTAR 2KG BOSQUEÑO', ['CREMA QUESO MEZCLA UNTAR 800GR APROX BOSQUEÑO'], 'Crema de queso untar Bosqueño', ''),
 ('Tarta de queso Payoyo (entera)', ['Tarta de queso Payoyo Clasica', 'Queso Payoyo - 28 cm | Tartas de queso 28 cm ( )'], None, ''),
 ('Tarta de queso Payoyo con Pistacho', ['Queso con pistachos - 28 cm | Tartas de queso 28 cm'], None, ''),
 ('MOZZARELA GALBANI 100G', ['MOZZARELLA L.MAGGIORE FRES.100G'], 'Mozzarella fresca 100 g', ''),
 # pan y masas
 ('Picos (bolsa)', [], None, 'revisa: hay picos por caja de 100 y por bolsa', True),
 ('Pan brioche burger', ['BOLLOS BRIOCHE BURGUER'], None, ''),
 ('TELERAS DE 2 KG MORENAS CORTADAS', ['TELLERAS DE 2 KG MORENAS CORTADAS'], 'Telera morena 2 kg cortada', ''),
 # precocinados
 ('Croqueta de jamón ibérico', ['Croquetas de Jamon'], None, 'revisa: la carta descuenta las croquetas de jamón de "Croquetas de Jamon"', True),
 ('Flamenquín de chicharrón (250 g)', ['Flamenquin chicharron de cadiz 250 gr 12 pz - kg', ('Flamenquin Chicharron de cadiz', 0.25)], None, 'revisa: "Flamenquin Chicharron de cadiz" iba por unidades (0,25 kg)', True),
 ('Flamenquín de lomo y queso (250 g)', ['Flamenquin lomo queso 250 gr 12 pz - kg', ('flamenquin lomo queso', 0.25)], None, 'revisa: igual que el anterior', True),
 ('Patata bastón prefrita', [('PATATA BASTON BOL.2K P.U.', 2)], None, ''),
 ('Patata dado prefrita (bravas)', [('PATATA DADO 2K P.U', 2)], None, ''),
 ('PATATA POCHADA CLASICA BASTON BOLSA 1KG (COMOENCASA)', ['PATATA POCHADA CLASICA BASTON BOLSA 1KG (COMOENCASA) - Albarán 47513 de'], 'Patata pochada bastón (bolsa 1 kg)', ''),
 ('Flor de alcachofa confitada', [('Flor de alcachofa confitada en aove 20 pz gastro', 20)], None, ''),
 # secos
 ('Harina de freír', [('HARINA SEVILLANA FREIR 5K', 5), ('HARINA DE FREIR 5KG', 5)], None, ''),
 ('NUEZ QUALITY MONDADA GRANO 750G\\P', ['Cubo nuez pelada'], 'Nuez pelada', 'revisa', True),
 ('PIÑON GOURMET MONDADO 250G', [], None, ''),
 # limpieza
 ('LEJIA MICAL 5L', [], 'Lejía 5 l', ''),
 ('BOLSAS BASURA 50 L', ['BOLSA BASURA AZUL', 'BOLSAS BASURA COMUNIDAD JP'], 'Bolsas de basura 50 l', 'revisa', True),
]
for g in G:
    target, sources, final, note = g[0], g[1], g[2], g[3]
    rev = g[4] if len(g) > 4 else False
    if not sources:
        i = pid(target)
        if i and final: updates[i]['name'] = final
        continue
    merge(target, sources, final, note, rev)

for p in P.values():
    if re.search(r'dep[oó]sito|caja vac[ií]a|^env\. |^envase co2|^caja\+bot', p['name'], re.I) and p['id'] not in used:
        baja(p['id'], 'envase retornable o depósito: no es género')
json.dump({'missing': missing}, open('faltan.json', 'w'), ensure_ascii=False, indent=1)
print('nombres no encontrados:', missing)

# ---------------------------------------------------------------- 4) precio de caja puesto como precio de botella/unidad
PACK = [  # (nombre, unidades por caja, nombre del formato)
 ('Gin Puerto de Indias Fresa 70 cl (C6) NF', 6, 'Caja 6'), ('Ginebra Larios 12 0,70 L. (C6)', 6, 'Caja 6'), ('Ginebra Rives 0,70 L. (C6)', 6, 'Caja 6'),
 ('Whisky Ballantine\'s 0,70 L. (C6)', 6, 'Caja 6'), ('Whisky JB 0,70 L. (C6)', 6, 'Caja 6'), ('Balleys Original 70cl 15% (C6)', 6, 'Caja 6'),
 ('J Walker Red 15% 70cl (C6)', 6, 'Caja 6'),
 ('CRUZCAMPO PILSEN 1/3*24 RET.', 24, 'Caja 24'), ('CRUZCAMPO PILSEN BOT RET 20CL C30', 30, 'Caja 30'), ('CRUZCAMPO SIN GLUTEN BOT NR 33CL C12', 12, 'Caja 12'),
 ('DESPERADOS BOT. RET 33CL C24', 24, 'Caja 24'), ('EL AGUILA BOT RET 33CL C24', 24, 'Caja 24'), ('HEINEKEN BOT RET 33CL C24 LONG', 24, 'Caja 24'),
 ('LADRON DE VERANO BOT. RET 33CL C24', 24, 'Caja 24'), ('LADRON DE MANZANAS BOT RET 33CL C24', 24, 'Caja 24'), ('LIPTON TE MELOCOTON 350 RET (24U)', 24, 'Caja 24'),
 ('SCH 28U TONICA 200ML RETORNABLE', 28, 'Caja 28'), ('SEVEN UP ZERO RETORNABLE 200', 24, 'Caja 24'), ('TINTO LIMON 0,0% CASERA RETORNABLE 275ML (24)', 24, 'Caja 24'),
 ('LCA GASEOSA 500ML (12) PET', 12, 'Caja 12'), ('LCA LIMON 500ML (12) PET', 12, 'Caja 12'), ('PASCUAL BATIDO CACAO CRISTAL 195CC C12', 12, 'Caja 12'),
 ('LECHE ENTERA 1,5 L PASCUAL', 6, 'Pack 6'),
]
BYBASE = collections.defaultdict(list)
for p in P.values(): BYBASE[nk(base_name(p['name']))].append(p['id'])
for name, n, fname in PACK:
    i = (BYBASE.get(nk(name)) or [None])[0]
    if not i: continue
    p = P[i]
    if p['unit'] != 'ud' or not p['price'] or p['price'] < 8: continue  # ya corregido a mano: no se vuelve a dividir
    updates[i]['price'] = round(p['price'] / n, 4)
    updates[i]['formats_add'] = [{'name': fname, 'factor': n, 'price': p['price'], 'is_default': 1}]
    review.append(('Precio por caja', p['name'], f"{p['price']} € era la caja de {n}: precio por unidad {round(p['price']/n,2)} € y formato «{fname}»", ''))
# los de la carta que van en caja de 6 botellas: formato Caja 6 (el precio ya es por botella)
for p in P.values():
    if p['id'] in used or p['unit'] != 'ud': continue
    if re.search(r'caja ?6\b|c/ ?6\b|\(c6\)|\(cj6u\)|\(6\)|\(6uds\)', p['name'], re.I) and not updates[p['id']].get('formats_add'):
        updates[p['id']]['formats_add'] = [{'name': 'Caja 6', 'factor': 6, 'price': None, 'is_default': 1}]

# ---------------------------------------------------------------- 5) categorías ordenadas
CATS = [
 ('Cervezas', r'cerveza|cruzcampo|heineken|amstel|paulaner|desperados|el aguila|ladron de|radler|mahou|alhambra|tostada 00|1870|la rubia|barril'),
 ('Refrescos, aguas y zumos', r'coca ?-?col|cocacola|fanta|sprite|seven up|7up|aquarius|fuze|nestea|lipton|t[oó]nica|rbliss|bliss|schweppes|sch 28u|kas |casera|lca |gaseosa|limca|minute maid|zumo|batido|monster|agua|aquabona|fontarel|colacao|ref te|cola cao|red ?bull|mixer'),
 ('Vinos, cava y vermut', r'vino|verdejo|rioja|ribera|crianza|roble|albari|chardonnay|garnatxa|rosado|tinto|blanco bot|frizzante|frizante|brut|cava|cremant|champ|manzanilla|fino|oloroso|amontillado|palo cortado|cream|moscatel|vermut|tintilla|beronia|protos|atauta|pariente|carramimbre|entrechuelos|barbadillo|almarina|pardinal|dulcemar|mar garc|lusco|can sumoi|castellroig|simonnet|vilarnau|zarro|montecillo|montefiel|melvin|tio nicolas|jose part|buho|leonor|vina ab|alfonso|solera|ceballos|martinez|velasco|parrilla|tio pepe|guita|muyfina|croft|ha pasado|pez volador|lopez cristobal|parada de atauta|vegas del bodion'),
 ('Licores y destilados', r'gin|ginebra|whisky|ron |brugal|bacardi|legendario|santa teresa|matusal|barcel|flor de ca|tanqueray|larios|roku|nordes|bulldog|bombay|hendri|ampensard|alambique|mart[ií]n miller|licor|eristoff|vodka|amaret|lobo|doble v|white label|black label|cuervo|tequila|brandy|anis|pachar|ruavieja|crema oro|baileys|balleys|aperol|jager|limoncello|beb\. esp|sarti|zacapa|j walker|jameson|jack daniel|dyc|macallan|beefeater|seagram|rives|puerto de indias|engine|143|43'),
 ('Café, té e infusiones', r'caf[eé]|descafeinado|t[eé] |rooibos|piramide|manzanilla piramide|menta poleo|infusi|edulcorante|azucar|az[uú]car'),
 ('Carne y embutidos', r'carne|lomo|cerdo|ib[eé]ric|pollo|pavo|ternera|vaca|a[nñ]ojo|retinto|burger|picada|chuleta|costilla|carrillad|presa|pluma|secreto|solomillo(?! de at)|panceta|bacon|jam[oó]n|chorizo|salchich|morcilla|longani|cecina|ciervo|venad|venao|jabal|ragout|rabo|ri[nñ]on|higado|h[ií]gado|manitas|venaitas|magro|manteca|chicharr|guanciale|fiambre|lagart|tiras chuletero|mousse pato|taco a|taco c|taco de cerdo|alitas|cuarto|muslo|contramuslo|pechuga|canal'),
 ('Pescado y marisco', r'pescado|merluza|at[uú]n|bonito|boquer|sardina|caballa|melva|calamar|choco|sepia|pulpo|gamb|langost|almeja|mejill|zamburi|lubina|dorada|lenguado|salmon|salmonet|caella|caz[oó]n|hueva|mojama|ortiguilla|puntill|pav[ií]a|anchoa|bacoreta|ventresca|banderilla'),
 ('Frutas y verduras', r'patata(?! bast)(?! dado)(?! pochad)|tomate(?! frito)|cebolla|ajo|pimiento|lechuga|cogollo|zanahoria|pepino|calabac|berenjena(?! rellena)|apio|perejil|cilantro|albahaca|romero fresco|tomillo fresco|hierbabuena|acelga|lim[oó]n$|lim[oó]n |lima|naranja$|naranja |aguacate|kiwi|nectarina|paraguayo|manzana|ar[aá]ndano|frambuesa|fresa$|jengibre|r[uú]cula|mezclum|ensalada|germinad|esp[aá]rrago|champi|setas|tapin|cebollino|alfalfa'),
 ('Lácteos y huevos', r'leche|nata|queso|mantequilla|yogur|kefir|huevo|burrata|mozzarel|provolone|parmesano|cheddar|brie|roquef|cabra|payoyo'),
 ('Pan y bollería', r'pan |pan$|picos|regañ|telera|brioche|boba de pan|bastones|hojaldre|hogaza|bollo|molde'),
 ('Precocinados y congelados', r'croqueta|flamenqu|patata bast|patata dado|pochada|berenjena rellena|berenjenas rellenas|prefrit|empanad|lingote|gilda'),
 ('Postres y helados', r'helado|tarta|flan|natilla|lemon pie|trufas|sirope|caramelo|mermelada|crema de pistacho|royal caramelo|topping|jellies'),
 ('Aceites, salsas y especias', r'aceite|vinagre|aceto|sal |sal$|pimienta|piment|or[eé]gano|laurel|comino|curry|canela|azafr|colorante|clavo|cayena|nuez moscada|an[ií]s grano|mostaza|ketchup|mayonesa|salsa|soja|kikkoman|wasabi|tomate frito|alcaparra|pepinillo|s[eé]samo|hierbas|romero|tomillo|ajo quality|cebolla quality|jengibre quality|crema borges|crema trufa|bovril|tartufata'),
 ('Secos, conservas y harinas', r'harina|arroz|pasta|fideo|macarr|garbanz|legumbre|lenteja|jud[ií]a|aceituna|conserva|lata|at[uú]n ac|nuez|pi[ñn]on|almendra|pistacho|frutos secos|levadura|maizena|pan rallado|rall\.|kataifi|lays|ruffles|patatas fritas|galleta|gall\.|cacao|garbanza|guisante|fritada|pisto|alcachofa|salmorejo|crema de berenjena|tomate tritur|tomate quality nat|triturado'),
 ('Limpieza', r'lej[ií]a|desengras|lavav|fregasuel|limpia|antical|desin|ambien|abrill|fairy|vileda|fregona|bayeta|estropajo|guante|vinagre de limpieza|vinagre quality limpieza|viakal|sanytol|neutraliz'),
 ('Desechables, papel y envases', r'bolsa|basura|papel|film|aluminio|alum|servill|serv\.|ca[nñ]ita|pajita|vaso to go|tapa vaso|vaso pp|envase|bowl c-t|ensaladera|tapa ensaladera|brocheta|pincho|bobina|pa[nñ]o|pa[nñ]uelo|rolldrap|kraf|vegetal mpro|secamanos|higi[eé]n|cajas? de pa'),
]
SHORT = {'ron', 'gin', '43', 'agua', 'te', 'sal', 'kas', 'fino', 'lima', 'anis', 'lobo', 'cava', 'pan', 'ajo', 'lata', 'nata', 'cream'}
def to_rx(rx):
    rx = rx.replace('\\.', ' ').replace('-', ' ').replace('/', ' ')
    parts = rx.split('|')
    return re.compile('|'.join((r'\b' + x.strip() + r'\b') if x.strip().rstrip('$ ') in SHORT else (r'\b' + x) for x in parts))
CATS = [CATS[i] for i in (10, 6, 9, 1, 4, 11, 8, 0, 2, 3, 5, 14, 7, 12, 13, 15)]  # orden de prioridad al clasificar
CRX = [(c, to_rx(rx)) for c, rx in CATS]
def cat_for(name, current):
    n = re.sub(r'[^a-z0-9ñ ]+', ' ', nk(name))
    n = ' ' + re.sub(r'\s+', ' ', n) + ' '
    if re.search(r'\banis\b.*\bgrano\b', n): return 'Aceites, salsas y especias'
    for c, rx in CRX:
        if rx.search(n): return c
    return None
REMAP = {'Bebidas': None, 'VINO': 'Vinos, cava y vermut', 'PESCADO': 'Pescado y marisco', 'Fritura': 'Precocinados y congelados', 'R': None,
         'Carne': 'Carne y embutidos', 'Aceites y condimentos': 'Aceites, salsas y especias', 'Secos y conservas': 'Secos, conservas y harinas',
         'Panadería y masas': 'Pan y bollería', 'Limpieza y menaje': None}
nocat = []
for p in P.values():
    if p['id'] in bajas or any(p['id'] == s for m in merges for s, _ in m[1]): continue
    name = updates[p['id']].get('name') or p['name']
    c = cat_for(name, p['category'])
    if not c:
        c = REMAP.get(p['category'], p['category']) if p['category'] in REMAP else p['category']
    if not c: nocat.append(name); c = 'Otros (revisar)'
    if c != p['category']: updates[p['id']]['category'] = c

# ---------------------------------------------------------------- 6) retoques a mano
MANUAL = {
 'VONAGRE JEREZ RESER': {'name': 'Vinagre de Jerez reserva', 'category': 'Aceites, salsas y especias'},
 'CO2 10KG': {'name': 'CO2 para tirador (botella 10 kg)', 'category': 'Cervezas'},
 'MANGA CREMA GORGONZOLA 600GR (DEMETRA)': {'category': 'Lácteos y huevos'},
 'LONGANZ FRES 1KG BJ EMC': {'name': 'Longaniza fresca', 'category': 'Carne y embutidos'},
 'Browine': {'name': 'Brownie', 'category': 'Postres y helados'},
 'SABORES LUSIANA COLI': {'category': 'Refrescos, aguas y zumos'},
 'Ampensaedo rosa ': {'name': 'Ampensardo rosa', 'category': 'Licores y destilados'},
 'Bombay shapire': {'name': 'Ginebra Bombay Sapphire'}, 'Hendriks': {'name': "Ginebra Hendrick's", 'category': 'Licores y destilados'},
 'Balleys Original 70cl 15% (C6)': {'name': 'Baileys Original 70 cl'}, 'Amor amareto': {'name': 'Amaretto'},
 'Quite lañe, ': {'name': 'White Label'}, 'Coca col zero zero 35cl': {},
 'GAS/A': {'name': 'Gaseosa (garrafa)', 'category': 'Refrescos, aguas y zumos'},
 'RUFFLES JAMON 243GR': {'category': 'Secos, conservas y harinas'}, 'LAYS SAL 248GR': {'category': 'Secos, conservas y harinas'},
 'SALSA BOVRIL CONCENT. CARNE 500G': {'category': 'Aceites, salsas y especias'}, 'AJO QUALITY MOL. BOTE 800G': {'category': 'Aceites, salsas y especias'},
 'CEBOLLA QUALITY ESCAMA 300G': {'category': 'Aceites, salsas y especias'}, 'JENGIBRE QUALITY MOL.700G': {'category': 'Aceites, salsas y especias'},
 'SALMOREJO G.MILLAN FRES S/PAN 1L': {'category': 'Precocinados y congelados'}, 'SALMOREJO LA ABUELA BOTE 1L (MAJAO)': {'category': 'Precocinados y congelados'},
 'Chicharron de Cádiz Asado al Amontillado': {'category': 'Carne y embutidos'}, 'Champinon': {'name': 'Champiñón', 'category': 'Frutas y verduras'},
 'BEB. ESP. 1715 1L 30º': {'name': 'Bebida espirituosa 1715 (1 l)', 'category': 'Licores y destilados'},
}
for n, u in MANUAL.items():
    i = BYNAME.get(nk(n), [None])[0]
    if i and i not in bajas: updates[i].update(u)
i = BYNAME.get(nk('La Barraca Aroma Vai...'), [None])[0]
if i: bajas[i] = 'compra puntual sin identificar (¿ambientador?)'

# ---------------------------------------------------------------- 7) proveedores
SUP_MERGE = [(77, [76]), (89, [2]), (96, [95]), (104, [3]), (12, [114]), (116, [63])]
SUP_NAMES = {77: 'Carrefour', 89: 'Frutería El Melón', 96: 'Mariscos Aragón (Maragon)', 104: 'Productos de la Pesca Fish & Seafood (Petaca)'}

# ---------------------------------------------------------------- 8) compras sueltas de supermercado (Carrefour, Dia, Super Arcos, Ordóñez): fuera
SUPERMKT = {76, 77}
merged_src = collections.defaultdict(list)
for t, src, fin, note, rev in merges:
    for i, f in src: merged_src[t].append(i)
def needed(i): return counted.get(i) or i in in_recipe or any(counted.get(x) or x in in_recipe for x in merged_src.get(i, []))
for p in P.values():
    if p['supplier_id'] in SUPERMKT and p['id'] not in bajas and not any(p['id'] == s for m in merges for s, _ in m[1]):
        if needed(p['id']): updates[p['id']]['supplier_id'] = None
        else: bajas[p['id']] = 'compra suelta en Carrefour'

# ---------------------------------------------------------------- 9) unidades de medida: lo que se usa en escandallos se controla en kg o l (el envase es un formato)
from tamano import size
NO_CONV = {'Cervezas', 'Refrescos, aguas y zumos', 'Limpieza', 'Desechables, papel y envases', 'Café, té e infusiones', 'Postres y helados'}
convert = {}
merged_away = {s for m in merges for s, _ in m[1]}
for p in P.values():
    if p['id'] in bajas or p['id'] in merged_away or p['unit'] != 'ud': continue
    cat = updates[p['id']].get('category') or p['category']
    name = updates[p['id']].get('name') or p['name']
    if cat in NO_CONV and not (cat == 'Café, té e infusiones' and re.search(r'\bgrano\b|molido', name, re.I)): continue
    r = size(p['name'], cat)
    if not r: continue
    unit, f, fname = r
    convert[p['id']] = {'unit': unit, 'factor': f, 'format': fname, 'price_ud': updates[p['id']].get('price', p['price'])}
    u = updates[p['id']]
    if 'price' in u: u['price'] = round(u['price'] / f, 4)
    if u.get('formats_add'): u['formats_add'] = [{**x, 'factor': round(x['factor'] * f, 4)} for x in u['formats_add']]

# ---------------------------------------------------------------- salida
out = {
  'merges': [{'target': t, 'sources': [[s, f] for s, f in src], 'name': fin, 'note': note, 'review': rev} for t, src, fin, note, rev in merges],
  'bajas': [{'id': i, 'why': w} for i, w in bajas.items()],
  'updates': {str(k): v for k, v in updates.items() if v and k not in bajas},
  'convert': {str(k): v for k, v in convert.items()},
  'pack_price': {str(BYBASE[nk(n)][0]): (round(P[BYBASE[nk(n)][0]]['price'] / f, 4) if P[BYBASE[nk(n)][0]]['price'] >= 8 else P[BYBASE[nk(n)][0]]['price']) for n, f, _ in PACK if BYBASE.get(nk(n))},
  'supplier_merges': SUP_MERGE, 'supplier_names': SUP_NAMES,
  'pack': {str(BYBASE[nk(n)][0]): f for n, f, _ in PACK if BYBASE.get(nk(n))},
}
json.dump(out, open('decisiones.json', 'w'), ensure_ascii=False, indent=1)
srcs = sum(len(m['sources']) for m in out['merges'])
print(f"fusiones: {len(out['merges'])} grupos ({srcs} artículos desaparecen) · bajas: {len(bajas)} · cambios: {len(out['updates'])} · sin categoría: {len(nocat)}")
print('quedan activos aprox:', len(P) - srcs - len(bajas), '· pasan a kg/l:', len(convert))
print('sin categoría:', nocat[:80])
