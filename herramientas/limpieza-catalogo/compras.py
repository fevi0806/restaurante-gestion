# Prepara las compras de la hoja «Compras» para importarlas como facturas sobre el catálogo limpio.
import json, re, sys, unicodedata, collections, openpyxl, datetime

BACKUP, XLSX = sys.argv[1], sys.argv[2]
T = json.load(open(BACKUP))['tables']
D = json.load(open('decisiones.json'))
P = {p['id']: p for p in T['products']}

def nk(s):
    s = unicodedata.normalize('NFD', str(s or '')).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'\s+', ' ', s.replace('"', '').strip())
def nk2(s): return re.sub(r'[^a-z0-9]+', ' ', nk(s)).strip()
BYNAME = collections.defaultdict(list)
for p in P.values():
    if p['active']: BYNAME[nk(p['name'])].append(p['id']); BYNAME[nk2(p['name'])].append(p['id'])
# nombres que ya se fusionaron antes en la app (registro de actividad)
for a in T['audit_log']:
    if a['action'] == 'fusión' and a['entity'] == 'artículo' and a.get('detail'):
        try: det = json.loads(a['detail']).get('antes') or {}
        except Exception: continue
        q = (det.get('queda') or {}).get('id')
        for f in det.get('fusionados') or []:
            if q in P and P[q]['active'] and f.get('unit') == P[q]['unit']:
                BYNAME[nk(f['name'])].append(q); BYNAME[nk2(f['name'])].append(q)

# a dónde va cada artículo y con qué factor
dest = {}
for m in D['merges']:
    for s, f in m['sources']: dest[s] = (m['target'], f)
def final(i):
    f = 1.0
    seen = set()
    while i in dest and i not in seen:
        seen.add(i); t, ff = dest[i]; f *= ff; i = t
    return i, f
bajas = {b['id'] for b in D['bajas']}
pack = {int(k): v for k, v in D['pack'].items()}
newprice = {int(k): v for k, v in D['pack_price'].items()}
convert = {int(k): v for k, v in D['convert'].items()}

wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
rows = list(wb['Compras'].iter_rows(values_only=True))[1:]
out, skipped, unmatched = [], collections.Counter(), collections.Counter()
for r in rows:
    name, sup, cif, doc, date, qty, unit, price, amount = r[:9]
    if not name or qty in (None, 0): continue
    if re.search(r'carrefour', str(sup or ''), re.I): skipped['(Carrefour) ' + name] += 1; continue
    ids = BYNAME.get(nk(name)) or BYNAME.get(nk2(name))
    if not ids: unmatched[name] += 1; continue
    i0 = ids[0]
    i, f = final(i0)
    if i in bajas or i0 in bajas: skipped[name] += 1; continue
    tp = P[i]
    q, pr = float(qty), float(price or 0)
    # artículo con precio de caja: la línea de la factura es de cajas
    if i in pack and pr > (newprice.get(i) or 0) * pack[i] * 0.5:
        q, pr = q * pack[i], pr / pack[i]
    q, pr = q * f, pr / f if f else pr
    if i in convert:
        c = convert[i]; q, pr = q * c['factor'], pr / c['factor']
    out.append({'pid': i, 'supplier_name': sup, 'cif': cif, 'doc': str(doc or ''), 'date': date.strftime('%Y-%m-%d') if isinstance(date, datetime.datetime) else str(date)[:10],
                'qty': round(q, 4), 'unit': convert[i]['unit'] if i in convert else tp['unit'], 'price': round(pr, 4), 'amount': float(amount) if amount not in (None, '') else None})
json.dump(out, open('compras.json', 'w'), ensure_ascii=False)
print('líneas a importar:', len(out), '· saltadas (no son género):', sum(skipped.values()), '· sin artículo:', sum(unmatched.values()))
print('sin artículo:', list(unmatched.items())[:30])
print('saltadas:', list(skipped.items())[:40])
