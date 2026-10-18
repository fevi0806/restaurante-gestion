import re
# Tamaño del envase escrito en el nombre: devuelve (unidad base, cantidad por envase, nombre del formato) o None
UNIT = {'k': 'kg', 'kg': 'kg', 'kgs': 'kg', 'kilo': 'kg', 'kilos': 'kg', 'g': 'kg', 'gr': 'kg', 'grs': 'kg', 'gramos': 'kg',
        'l': 'l', 'lt': 'l', 'lts': 'l', 'ltr': 'l', 'litro': 'l', 'litros': 'l', 'ml': 'l', 'cl': 'l', 'cc': 'l'}
MULT = {'g': 0.001, 'gr': 0.001, 'grs': 0.001, 'gramos': 0.001, 'ml': 0.001, 'cl': 0.01, 'cc': 0.001}
KIND = [(r'garrafa', 'Garrafa'), (r'\bbote\b|tarro|frasco', 'Bote'), (r'\blata\b|\bro-?\s?\d', 'Lata'), (r'\bsaco\b|\\p\b', 'Saco'), (r'\bcubo\b|\bcuba\b', 'Cubo'),
        (r'\bbolsa\b|\bbol\.?\b', 'Bolsa'), (r'\bbrik\b|\bbrick\b', 'Brik'), (r'\bbot\b|botella|\bpet\b|\bvr\d', 'Botella'), (r'paquete|\bpack\b|\bpq\b', 'Paquete'),
        (r'bandeja|\bbdja?\b', 'Bandeja'), (r'tarrina', 'Tarrina'), (r'barra', 'Barra'), (r'pieza|\bpza\b', 'Pieza')]
def size(name, category=''):
    n = name.lower().replace('º', ' ')
    if category in ('Vinos, cava y vermut', 'Licores y destilados'):
        n = re.sub(r'\((c\s?\d+|\d+|\d+ ?uds?|cj\d+u)\)?|\bc/?\s?\d+\b|caja ?\d+|\(c\d*$', ' ', n)
    # varios envases o unidades sueltas en el nombre (sobres, 6x500, 220u, p-2): no se toca
    if re.search(r'\d\s*x\s*\d|\d+\s*u(ds?|nds?|nidades)?\b|\bp-\d|\(\d+\)|\bc\d{1,2}\b|\d+\s*sobres|\bs\.\d|\d+x|\bx\d', n): return None
    m = list(re.finditer(r'(\d+(?:[.,]\d+)?)\s*(kgs?|kilos?|k|grs?|gramos|g|ltr|lts?|litros?|l|ml|cl|cc)\b', n))
    if m:
        mm = m[-1] if not re.search(r'/', n[m[-1].start() - 1:m[-1].start()]) else m[0]
        q = float(mm.group(1).replace(',', '.')); u = mm.group(2)
        base = UNIT[u]; f = q * MULT.get(u, 1)
        if f <= 0 or f > 60: return None
        if 'helado' in n: return None
    elif re.search(r'\b3/4\b|75 ?cl', n): base, f = 'l', 0.75
    elif category == 'Vinos, cava y vermut' and not re.search(r'brick|garrafa|grifo', n): base, f = 'l', 1.5 if 'magnum' in n else 0.75
    elif category == 'Licores y destilados': base, f = 'l', 0.7
    else: return None
    kind = next((k for rx, k in KIND if re.search(rx, n)), ('Garrafa' if f >= 2 else 'Botella') if base == 'l' else 'Paquete')
    qty = (f'{f*1000:g} g' if f < 1 else f'{f:g} kg') if base == 'kg' else (f'{f*100:g} cl' if f < 1 else f'{f:g} l')
    return base, round(f, 4), f'{kind} {qty}'.replace('.', ',')
