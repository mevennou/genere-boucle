// Controle geometrique du trace produit.
//
// Le compteur de repetition historique compare des identifiants d'aretes : il
// voit un aller-retour sur la meme voie, mais pas un aller par la rue et un
// retour par le trottoir cartographie a part, qui sont deux aretes distinctes.
// A l'ecran, c'est pourtant le meme defaut : deux traits paralleles a quelques
// metres l'un de l'autre.
//
// Ce module mesure le probleme sur la geometrie finale, sans rien supposer de
// sa cause : rue doublee d'un trottoir, chaussees separees, ou tout autre cas
// qu'on n'aurait pas prevu.

import { distanceHaversine } from "./geo.js";

const RAD = Math.PI / 180;

/** Distance d'un point au segment [A,B], en metres (approximation locale). */
export function distancePointSegment(plat, plon, alat, alon, blat, blon) {
  const cos = Math.cos(plat * RAD);
  const mx = 111320.0;                        // metres par degre de latitude
  const px = (plon - alon) * mx * cos, py = (plat - alat) * mx;
  const bx = (blon - alon) * mx * cos, by = (blat - alat) * mx;
  const norme = bx * bx + by * by;
  if (norme === 0) return Math.hypot(px, py);
  let t = (px * bx + py * by) / norme;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return Math.hypot(px - t * bx, py - t * by);
}

/**
 * Longueur du trace qui longe une autre portion du meme trace, a moins de
 * `seuil` metres, alors qu'elle en est eloignee d'au moins `ecartChemin`
 * metres le long du parcours. Les deux passages sont comptes : un aller-retour
 * de 150 m rend environ 300 m.
 *
 * Renvoie { longueur, portions } ou portions liste les zones concernees, pour
 * pouvoir les designer a l'utilisateur.
 */
export function mesureDoublement(points, { seuil = 15, ecartChemin = 80 } = {}) {
  const n = points.length;
  if (n < 4) return { longueur: 0, portions: [] };

  // Longueurs cumulees le long du trace.
  const cumul = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cumul[i] = cumul[i - 1] + distanceHaversine(points[i - 1][0], points[i - 1][1],
                                                points[i][0], points[i][1]);
  }
  const total = cumul[n - 1];
  // Sur une boucle fermee, le debut et la fin sont voisins : l'ecart le long
  // du chemin doit se mesurer dans les deux sens.
  const ferme = distanceHaversine(points[0][0], points[0][1],
                                  points[n - 1][0], points[n - 1][1]) < 25;
  const ecartLeLongDuChemin = (a, b) => {
    const d = Math.abs(cumul[a] - cumul[b]);
    return ferme ? Math.min(d, total - d) : d;
  };

  // Grille spatiale sur les milieux de segments.
  const CASE = 40;
  const cases = new Map();
  const mlat = new Float64Array(n - 1), mlon = new Float64Array(n - 1);
  const clef = (i, j) => i * 1000003 + j;
  for (let s = 0; s + 1 < n; s++) {
    mlat[s] = (points[s][0] + points[s + 1][0]) / 2;
    mlon[s] = (points[s][1] + points[s + 1][1]) / 2;
    const ci = Math.floor(mlat[s] * 111320 / CASE);
    const cj = Math.floor(mlon[s] * 111320 * Math.cos(mlat[s] * RAD) / CASE);
    const c = clef(ci, cj);
    const liste = cases.get(c);
    if (liste) liste.push(s); else cases.set(c, [s]);
  }

  const double = new Uint8Array(n - 1);
  for (let s = 0; s + 1 < n; s++) {
    const ci = Math.floor(mlat[s] * 111320 / CASE);
    const cj = Math.floor(mlon[s] * 111320 * Math.cos(mlat[s] * RAD) / CASE);
    for (let di = -1; di <= 1 && !double[s]; di++) {
      for (let dj = -1; dj <= 1 && !double[s]; dj++) {
        const liste = cases.get(clef(ci + di, cj + dj));
        if (!liste) continue;
        for (const t of liste) {
          if (t === s) continue;
          if (ecartLeLongDuChemin(s, t) < ecartChemin) continue;
          const d = distancePointSegment(mlat[s], mlon[s],
                                         points[t][0], points[t][1],
                                         points[t + 1][0], points[t + 1][1]);
          if (d < seuil) { double[s] = 1; break; }
        }
      }
    }
  }

  let longueur = 0;
  const portions = [];
  let debut = -1;
  for (let s = 0; s + 1 < n; s++) {
    const l = cumul[s + 1] - cumul[s];
    if (double[s]) {
      longueur += l;
      if (debut < 0) debut = s;
    } else if (debut >= 0) {
      portions.push({ debut, fin: s, longueur: cumul[s] - cumul[debut] });
      debut = -1;
    }
  }
  if (debut >= 0) {
    portions.push({ debut, fin: n - 1, longueur: cumul[n - 1] - cumul[debut] });
  }

  // Une portion isolee de quelques metres releve du bruit de numerisation,
  // pas d'un aller-retour : on ne retient que les portions significatives.
  const retenues = portions.filter((p) => p.longueur >= 25);
  return {
    longueur: retenues.reduce((s, p) => s + p.longueur, 0),
    portions: retenues,
  };
}

/**
 * Petites boucles refermees sur elles-memes a l'interieur du parcours.
 *
 * Le comptage par arete et la mesure de doublement ne les voient pas : un
 * crochet qui part d'un carrefour, fait le tour d'un pate de maisons et
 * revient au meme carrefour n'emprunte aucune arete deux fois et ne longe
 * rien. C'est pourtant exactement ce qu'on ne veut pas : un circuit, pas un
 * circuit plus trois lacets pour faire la distance.
 *
 * Une bouclette est un retour du trace a moins de `seuil` metres d'un point
 * deja visite, apres avoir parcouru entre `minimum` metres et une part
 * `partMax` du parcours. La borne haute ecarte la fermeture de la boucle
 * principale, qui est le but recherche et non un defaut.
 *
 * Renvoie { nombre, longueur, boucles }, ou `longueur` est le perimetre
 * cumule des bouclettes trouvees.
 */
export function mesureBouclettes(points, { seuil = 25, minimum = 60,
                                           partMax = 0.25 } = {}) {
  const n = points.length;
  if (n < 4) return { nombre: 0, longueur: 0, boucles: [] };

  const cumul = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cumul[i] = cumul[i - 1] + distanceHaversine(points[i - 1][0], points[i - 1][1],
                                                points[i][0], points[i][1]);
  }
  const total = cumul[n - 1];
  const maximum = total * partMax;
  if (maximum <= minimum) return { nombre: 0, longueur: 0, boucles: [] };

  // Grille spatiale sur les points, au pas du seuil : deux points voisins
  // dans le plan se retrouvent dans la meme case ou dans une case adjacente.
  const CASE = Math.max(10, seuil);
  const cases = new Map();
  const clef = (i, j) => i * 1000003 + j;
  const caseDe = (k) => [
    Math.floor(points[k][0] * 111320 / CASE),
    Math.floor(points[k][1] * 111320 * Math.cos(points[k][0] * RAD) / CASE),
  ];
  for (let k = 0; k < n; k++) {
    const [ci, cj] = caseDe(k);
    const c = clef(ci, cj);
    const liste = cases.get(c);
    if (liste) liste.push(k); else cases.set(c, [k]);
  }

  // Pour chaque point, le retour le plus tardif encore admissible : c'est la
  // plus grande bouclette qui se referme sur ce point.
  const intervalles = [];
  for (let i = 0; i < n; i++) {
    const [ci, cj] = caseDe(i);
    let fin = -1;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const liste = cases.get(clef(ci + di, cj + dj));
        if (!liste) continue;
        for (const j of liste) {
          if (j <= i || j <= fin) continue;
          const parcouru = cumul[j] - cumul[i];
          if (parcouru < minimum || parcouru > maximum) continue;
          if (distanceHaversine(points[i][0], points[i][1],
                                points[j][0], points[j][1]) > seuil) continue;
          fin = j;
        }
      }
    }
    if (fin > i) intervalles.push([i, fin]);
  }

  // Deux bouclettes qui se recouvrent sont le meme crochet vu de deux points.
  const boucles = [];
  for (const [debut, fin] of intervalles) {
    const derniere = boucles[boucles.length - 1];
    if (derniere && debut <= derniere.fin) {
      if (fin > derniere.fin) derniere.fin = fin;
    } else {
      boucles.push({ debut, fin });
    }
  }
  for (const b of boucles) b.longueur = cumul[b.fin] - cumul[b.debut];

  return {
    nombre: boucles.length,
    longueur: boucles.reduce((s, b) => s + b.longueur, 0),
    boucles,
  };
}
