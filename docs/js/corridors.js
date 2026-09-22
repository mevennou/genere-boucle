// Regroupement des voies jumelles en "couloirs".
//
// Une rue et son trottoir cartographie a part sont deux aretes distinctes du
// graphe, alors qu'ils sont physiquement la meme voie. La penalite qui empeche
// de reprendre une arete deja parcourue ne les reliait pas : on pouvait aller
// par la rue et revenir par le trottoir sans que rien ne le remarque.
//
// Ici, ces aretes sont reunies dans un meme couloir. La penalite et le
// comptage de repetition raisonnent ensuite par couloir, ce qui rend le
// doublement visible la ou il se produit plutot qu'apres coup.
//
// Vaut aussi pour les chaussees separees et les contre-allees.

import { distancePointSegment } from "./controle.js";

const RAD = Math.PI / 180;

/** Echantillonne la polyligne d'une arete, au plus `maximum` points. */
function echantillonne(arete, lat, lon, maximum = 16) {
  const p = arete.polyligne;
  const pas = Math.max(1, Math.ceil(p.length / maximum));
  const points = [];
  for (let k = 0; k < p.length; k += pas) points.push([lat[p[k]], lon[p[k]]]);
  const dernier = p[p.length - 1];
  const fin = points[points.length - 1];
  if (fin[0] !== lat[dernier] || fin[1] !== lon[dernier]) {
    points.push([lat[dernier], lon[dernier]]);
  }
  return points;
}

/** Part des echantillons de A situes a moins de `seuil` de la polyligne de B. */
function recouvrement(echA, areteB, lat, lon, seuil) {
  const p = areteB.polyligne;
  let proches = 0;
  for (const [plat, plon] of echA) {
    let meilleure = Infinity;
    for (let k = 0; k + 1 < p.length && meilleure >= seuil; k++) {
      const d = distancePointSegment(plat, plon, lat[p[k]], lon[p[k]],
                                     lat[p[k + 1]], lon[p[k + 1]]);
      if (d < meilleure) meilleure = d;
    }
    if (meilleure < seuil) proches++;
  }
  return proches / echA.length;
}

class UnionFind {
  constructor(n) { this.parent = new Int32Array(n).map((_, i) => i); }
  trouve(x) {
    let r = x;
    while (this.parent[r] !== r) r = this.parent[r];
    while (this.parent[x] !== r) { const s = this.parent[x]; this.parent[x] = r; x = s; }
    return r;
  }
  unit(a, b) {
    const ra = this.trouve(a), rb = this.trouve(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/** Vecteur d'une arete, de son debut vers sa fin, en metres (est, nord). */
function vecteur(arete, lat, lon) {
  const p = arete.polyligne;
  const a = p[0], b = p[p.length - 1];
  const cos = Math.cos(lat[a] * RAD);
  return [(lon[b] - lon[a]) * 111320 * cos, (lat[b] - lat[a]) * 111320];
}

/** Milieu geometrique approche d'une arete. */
function milieu(arete, lat, lon) {
  const p = arete.polyligne;
  const k = p[Math.floor(p.length / 2)];
  return [lat[k], lon[k]];
}

/**
 * Renvoie { couloir, nbCouloirs, nbJumelages, decalage, alignement } ou
 * couloir[i] est l'identifiant du couloir de l'arete i. Sans jumelle,
 * couloir[i] === i et tout se comporte exactement comme avant.
 *
 * `decalage[i]` est l'ecart lateral de l'arete i par rapport a l'arete de
 * reference de son couloir, en metres, compte positivement a gauche du sens
 * de cette reference. `alignement[i]` vaut +1 si l'arete i va dans le meme
 * sens que la reference, -1 sinon. Les deux ensemble disent, pour un sens de
 * parcours donne, si l'on court a gauche ou a droite de la chaussee — ce que
 * le code de la route francais demande hors agglomeration.
 */
export function detecteCorridors(aretes, lat, lon, {
  ecartMax = 14,          // ecart lateral maximal entre deux voies jumelles
  recouvrementMin = 0.65, // part de la voie qui doit longer l'autre
  longueurMin = 25,       // en deca, un jumelage n'a pas de sens
  maximumPaires = 400000, // garde-fou sur les tres grands reseaux
} = {}) {
  const n = aretes.length;
  const union = new UnionFind(n);
  const CASE = 30;
  const cases = new Map();
  const echantillons = new Array(n);
  const clef = (i, j) => i * 1000003 + j;

  for (let i = 0; i < n; i++) {
    if (aretes[i].longueur < longueurMin) continue;
    const ech = echantillonne(aretes[i], lat, lon);
    echantillons[i] = ech;
    for (const [plat, plon] of ech) {
      const ci = Math.floor(plat * 111320 / CASE);
      const cj = Math.floor(plon * 111320 * Math.cos(plat * RAD) / CASE);
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const c = clef(ci + di, cj + dj);
          let liste = cases.get(c);
          if (!liste) cases.set(c, liste = new Set());
          liste.add(i);
        }
      }
    }
  }

  // Paires candidates : deux aretes qui partagent au moins une case.
  const vues = new Set();
  let jumelages = 0, examinees = 0;
  for (const liste of cases.values()) {
    if (liste.size < 2) continue;
    const tableau = [...liste];
    for (let a = 0; a < tableau.length; a++) {
      for (let b = a + 1; b < tableau.length; b++) {
        const i = tableau[a], j = tableau[b];
        const paire = i < j ? i * n + j : j * n + i;
        if (vues.has(paire)) continue;
        vues.add(paire);
        if (++examinees > maximumPaires) break;
        const li = aretes[i].longueur, lj = aretes[j].longueur;
        // Deux voies jumelles ont des longueurs comparables : sans ce
        // garde-fou, une arete courte serait absorbee par une longue qu'elle
        // ne fait que croiser.
        if (li > lj * 2.2 || lj > li * 2.2) continue;
        if (recouvrement(echantillons[i], aretes[j], lat, lon, ecartMax) < recouvrementMin) continue;
        if (recouvrement(echantillons[j], aretes[i], lat, lon, ecartMax) < recouvrementMin) continue;
        union.unit(i, j);
        jumelages++;
      }
    }
  }

  const couloir = new Int32Array(n);
  for (let i = 0; i < n; i++) couloir[i] = union.trouve(i);
  const distincts = new Set(couloir);

  // Cote de la chaussee. Seules les aretes jumelees en ont un : ailleurs, la
  // voie est cartographiee par son axe et le trace ne peut pas designer un
  // bord plutot que l'autre.
  const decalage = new Float64Array(n);
  const alignement = new Int8Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const reference = couloir[i];
    if (reference === i) continue;
    const [rx, ry] = vecteur(aretes[reference], lat, lon);
    const norme = Math.hypot(rx, ry);
    if (norme < 1) continue;
    const [ix, iy] = vecteur(aretes[i], lat, lon);
    alignement[i] = (ix * rx + iy * ry) >= 0 ? 1 : -1;

    // Ecart lateral du milieu de i par rapport a l'axe de la reference,
    // positif a gauche du sens de la reference.
    const [mlat, mlon] = milieu(aretes[i], lat, lon);
    const p = aretes[reference].polyligne;
    const alat = lat[p[0]], alon = lon[p[0]];
    const cos = Math.cos(alat * RAD);
    const ox = (mlon - alon) * 111320 * cos, oy = (mlat - alat) * 111320;
    decalage[i] = (rx * oy - ry * ox) / norme;
  }

  return { couloir, nbCouloirs: distincts.size, nbJumelages: jumelages,
           decalage, alignement };
}
