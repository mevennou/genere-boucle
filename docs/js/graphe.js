// Construction du graphe praticable.
//
// Difference avec la version Python : les identifiants OSM (des entiers de 10
// chiffres, dispersés) sont remplaces des la lecture par des indices denses
// 0..n-1. Tout ce qui suit travaille alors sur des tableaux types plutot que
// sur des tables de hachage, ce qui est l'essentiel du gain de vitesse.

import { distanceHaversine } from "./geo.js";
import { evalueVoie } from "./regles.js";

/**
 * Graphe noeud-a-noeud limite aux voies jugees praticables.
 * brut[u] = [[v, longueur, cout, etiquette, qualite], ...]
 */
export function construitGrapheBrut(voies, niveau, balises, bloques = new Set()) {
  const indexDe = new Map();          // id OSM -> indice dense
  const lats = [];
  const lons = [];
  const idOsm = [];

  const indice = (id, lat, lon) => {
    let i = indexDe.get(id);
    if (i === undefined) {
      i = lats.length;
      indexDe.set(id, i);
      lats.push(lat); lons.push(lon); idOsm.push(id);
    } else {
      lats[i] = lat; lons[i] = lon;   // derniere geometrie vue, comme en Python
    }
    return i;
  };

  const brut = [];
  let retenues = 0;

  for (const voie of voies) {
    const tags = voie.tags || {};
    const verdict = evalueVoie(tags, niveau, balises.has(voie.id));
    if (verdict === null) continue;
    const [cout, etiquette, qualite] = verdict;
    const geometrie = voie.geometry || [];
    const noeuds = voie.nodes || [];
    if (noeuds.length !== geometrie.length || noeuds.length < 2) continue;
    retenues += 1;

    const denses = new Array(noeuds.length);
    for (let k = 0; k < noeuds.length; k++) {
      denses[k] = indice(noeuds[k], geometrie[k].lat, geometrie[k].lon);
    }

    for (let k = 0; k + 1 < noeuds.length; k++) {
      const a = noeuds[k], b = noeuds[k + 1];
      if (a === b || bloques.has(a) || bloques.has(b)) continue;
      const ia = denses[k], ib = denses[k + 1];
      const longueur = distanceHaversine(lats[ia], lons[ia], lats[ib], lons[ib]);
      if (longueur <= 0) continue;
      (brut[ia] || (brut[ia] = [])).push([ib, longueur, cout, etiquette, qualite]);
      (brut[ib] || (brut[ib] = [])).push([ia, longueur, cout, etiquette, qualite]);
    }
  }

  const nbNoeuds = lats.length;
  for (let i = 0; i < nbNoeuds; i++) if (brut[i] === undefined) brut[i] = null;

  return {
    brut,
    nbNoeuds,
    lat: Float64Array.from(lats),
    lon: Float64Array.from(lons),
    idOsm,
    indexDe,
    retenues,
    nbAvecAretes: brut.reduce((n, v) => n + (v ? 1 : 0), 0),
  };
}

/**
 * Fusionne les chaines de noeuds de degre 2 en aretes uniques. Le graphe
 * devient 5 a 10 fois plus petit sans rien perdre de la geometrie.
 * arete = {u, v, longueur, poids, polyligne, etiquette, qualite}
 * `poids` est la somme des longueur x cout : c'est lui que minimise l'A*.
 */
export function contracte(brut, nbNoeuds, proteges = new Set()) {
  const estJonction = new Uint8Array(nbNoeuds);
  for (let n = 0; n < nbNoeuds; n++) {
    if (brut[n] && brut[n].length !== 2) estJonction[n] = 1;
  }
  for (const n of proteges) if (brut[n]) estJonction[n] = 1;

  const aretes = [];
  const adjacence = new Array(nbNoeuds);
  const vues = new Array(nbNoeuds);
  const drapeaux = (n) => vues[n] || (vues[n] = new Uint8Array(brut[n].length));

  // Marque la demi-arete de retour, pour ne pas reparcourir la chaine en sens
  // inverse (equivalent de marque_retour en Python).
  const marqueRetour = (noeud, precedent) => {
    const liste = brut[noeud];
    const f = drapeaux(noeud);
    for (let i = 0; i < liste.length; i++) {
      if (liste[i][0] === precedent && !f[i]) { f[i] = 1; return; }
    }
  };

  for (let depart = 0; depart < nbNoeuds; depart++) {
    if (!estJonction[depart] || !brut[depart]) continue;
    const liste = brut[depart];
    const f = drapeaux(depart);

    for (let i = 0; i < liste.length; i++) {
      if (f[i]) continue;
      f[i] = 1;
      let [courant, longCourante, coutCourant, etiquette, qualite] = liste[i];

      const polyligne = [depart];
      let totalLongueur = 0, totalPoids = 0;
      let precedent = depart;
      let garde = 0;

      for (;;) {
        if (++garde > 100000) break;
        totalLongueur += longCourante;
        totalPoids += longCourante * coutCourant;
        polyligne.push(courant);
        marqueRetour(courant, precedent);
        if (estJonction[courant]) break;
        const voisins = brut[courant];
        let suite = null;
        for (const t of voisins) if (t[0] !== precedent) { suite = t; break; }
        if (!suite) break;
        precedent = courant;
        courant = suite[0]; longCourante = suite[1]; coutCourant = suite[2];
      }

      if (polyligne.length < 2 || totalLongueur <= 0) continue;
      const u = polyligne[0], v = polyligne[polyligne.length - 1];
      const index = aretes.length;
      aretes.push({
        u, v, longueur: totalLongueur, poids: totalPoids,
        polyligne: Int32Array.from(polyligne), etiquette, qualite,
      });
      (adjacence[u] || (adjacence[u] = [])).push([v, index]);
      (adjacence[v] || (adjacence[v] = [])).push([u, index]);
    }
  }

  return { aretes, adjacence };
}

/**
 * Reduction 2-coeur : retire iterativement tout noeud a un seul voisin.
 * Plus aucune antenne sans issue ne subsiste, le trace ne peut donc plus y
 * entrer pour en ressortir.
 */
export function supprimeImpasses(aretes, adjacence, nbNoeuds) {
  const degre = new Int32Array(nbNoeuds);
  for (let n = 0; n < nbNoeuds; n++) degre[n] = adjacence[n] ? adjacence[n].length : 0;

  const active = new Uint8Array(aretes.length).fill(1);
  const supprime = new Uint8Array(nbNoeuds);
  const pile = [];
  for (let n = 0; n < nbNoeuds; n++) {
    if (adjacence[n] && degre[n] <= 1) pile.push(n);
  }

  while (pile.length) {
    const noeud = pile.pop();
    if (supprime[noeud] || degre[noeud] > 1) continue;
    supprime[noeud] = 1;
    for (const [voisin, index] of (adjacence[noeud] || [])) {
      if (!active[index]) continue;
      active[index] = 0;
      if (voisin !== noeud) {
        degre[voisin] -= 1;
        if (degre[voisin] <= 1 && !supprime[voisin]) pile.push(voisin);
      }
    }
    degre[noeud] = 0;
  }

  const reduite = new Array(nbNoeuds);
  for (let index = 0; index < aretes.length; index++) {
    if (!active[index]) continue;
    const { u, v } = aretes[index];
    (reduite[u] || (reduite[u] = [])).push([v, index]);
    (reduite[v] || (reduite[v] = [])).push([u, index]);
  }
  return reduite;
}

/** Noeuds atteignables depuis source (parcours en largeur). */
export function composante(adjacence, source) {
  const vus = new Set([source]);
  const pile = [source];
  while (pile.length) {
    const noeud = pile.pop();
    for (const [voisin] of (adjacence[noeud] || [])) {
      if (!vus.has(voisin)) { vus.add(voisin); pile.push(voisin); }
    }
  }
  return vus;
}

/** Restreint une adjacence a un ensemble de noeuds. */
export function restreint(adjacence, noeuds, nbNoeuds) {
  const reduite = new Array(nbNoeuds);
  for (const n of noeuds) {
    const liste = adjacence[n];
    if (!liste) continue;
    const gardees = liste.filter(([v]) => noeuds.has(v));
    if (gardees.length) reduite[n] = gardees;
  }
  return reduite;
}

/** Representation CSR de l'adjacence : c'est elle que parcourt l'A*. */
export function construitCSR(adjacence, nbNoeuds) {
  const debut = new Int32Array(nbNoeuds + 1);
  for (let n = 0; n < nbNoeuds; n++) {
    debut[n + 1] = debut[n] + (adjacence[n] ? adjacence[n].length : 0);
  }
  const total = debut[nbNoeuds];
  const voisin = new Int32Array(total);
  const arete = new Int32Array(total);
  for (let n = 0; n < nbNoeuds; n++) {
    let k = debut[n];
    for (const [v, i] of (adjacence[n] || [])) { voisin[k] = v; arete[k] = i; k++; }
  }
  return { debut, voisin, arete };
}

/** Grille simple pour trouver le noeud le plus proche d'une coordonnee. */
export class IndexSpatial {
  static PAS = 0.002;                  // ~200 m

  constructor(lat, lon, noeuds) {
    this.lat = lat; this.lon = lon;
    this.cases = new Map();
    for (const noeud of noeuds) {
      const cle = this._cle(lat[noeud], lon[noeud]);
      const liste = this.cases.get(cle);
      if (liste) liste.push(noeud); else this.cases.set(cle, [noeud]);
    }
  }

  _cle(lat, lon) {
    const i = Math.floor(lat / IndexSpatial.PAS);
    const j = Math.floor(lon / IndexSpatial.PAS);
    return i * 1000000 + j;            // les latitudes tiennent largement
  }

  plusProche(lat, lon, rayonMax = 1500.0) {
    const baseI = Math.floor(lat / IndexSpatial.PAS);
    const baseJ = Math.floor(lon / IndexSpatial.PAS);
    let meilleur = null, meilleureDistance = rayonMax;
    for (let anneau = 0; anneau <= 12; anneau++) {
      for (let i = baseI - anneau; i <= baseI + anneau; i++) {
        for (let j = baseJ - anneau; j <= baseJ + anneau; j++) {
          if (anneau && Math.max(Math.abs(i - baseI), Math.abs(j - baseJ)) !== anneau) continue;
          const candidats = this.cases.get(i * 1000000 + j);
          if (!candidats) continue;
          for (const noeud of candidats) {
            const d = distanceHaversine(lat, lon, this.lat[noeud], this.lon[noeud]);
            if (d < meilleureDistance) { meilleur = noeud; meilleureDistance = d; }
          }
        }
      }
      if (meilleur !== null && anneau >= 1) break;
    }
    return [meilleur, meilleureDistance];
  }
}
