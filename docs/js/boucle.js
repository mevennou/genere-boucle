// Recherche de la boucle et du parcours point a point.
// La distance cible est atteinte en ELARGISSANT la boucle, jamais en ajoutant
// des va-et-vient : c'est tout l'objet de la penalite sur les aretes deja
// empruntees et du critere de repetition dans la notation.

import { pointADistance, capEntre, distanceHaversine, moduloPositif, arrondiPython } from "./geo.js";

/** Suite de noeuds parcourus, dans l'ordre, sans doublon consecutif. */
export function polyligneDuTrajet(trajet, aretes) {
  const noeuds = [];
  for (const [index, depuis] of trajet) {
    const arete = aretes[index];
    const p = arete.polyligne;
    const inverse = depuis !== arete.u;
    const n = p.length;
    const premier = inverse ? p[n - 1] : p[0];
    let debut = 0;
    if (noeuds.length && noeuds[noeuds.length - 1] === premier) debut = 1;
    if (inverse) {
      for (let k = n - 1 - debut; k >= 0; k--) noeuds.push(p[k]);
    } else {
      for (let k = debut; k < n; k++) noeuds.push(p[k]);
    }
  }
  return noeuds;
}

/**
 * Changements de direction brutaux par kilometre : la signature des petits
 * crochets qui rallongent un parcours sans rien lui apporter. Mesure locale,
 * qui ne penalise pas une boucle allongee, seulement une boucle qui zigzague.
 */
export function viragesSerres(trajet, aretes, lat, lon, longueur) {
  const noeuds = polyligneDuTrajet(trajet, aretes);
  if (noeuds.length < 3 || longueur <= 0) return 0.0;
  let compte = 0;
  let precedent = null;
  for (let k = 0; k + 1 < noeuds.length; k++) {
    const a = noeuds[k], b = noeuds[k + 1];
    const lat1 = lat[a], lon1 = lon[a], lat2 = lat[b], lon2 = lon[b];
    if (Math.abs(lat2 - lat1) < 9e-5 && Math.abs(lon2 - lon1) < 1.4e-4) continue;
    const cap = Math.atan2((lon2 - lon1) * Math.cos(lat1 * Math.PI / 180),
                           lat2 - lat1) * 180 / Math.PI;
    if (precedent !== null) {
      if (Math.abs(moduloPositif(cap - precedent + 180, 360) - 180) > 100) compte += 1;
    }
    precedent = cap;
  }
  return compte / (longueur / 1000.0);
}

/**
 * Classement des boucles candidates, du meilleur au moins bon. Criteres
 * successifs, par tranches d'un demi-pour-cent pour ne pas departager sur du
 * bruit : d'abord la boucle qui se repete le moins, puis celle qui colle a la
 * distance, et a egalite celle qui zigzague le moins.
 */
export function noteBoucle(longueur, repetee, cibleM, tolerance, virages = 0.0) {
  const erreur = Math.abs(longueur - cibleM) / cibleM;
  const part = longueur ? repetee / longueur : 1.0;
  if (erreur <= tolerance) {
    return [0, arrondiPython(part * 200), arrondiPython(erreur * 200), virages];
  }
  return [1, erreur, part, virages];
}

/** Comparaison lexicographique, equivalent de la comparaison de tuples. */
export function compareNote(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Boucle passant par `sommets` ancres reparties en couronne autour du depart. */
export function construitBoucle(routeur, aretes, indexSpatial, depart, lat, lon,
                                rayon, cap, sommets, cibleM) {
  const ancres = [];
  for (let i = 0; i < sommets; i++) {
    const angle = moduloPositif(cap + i * 360.0 / sommets, 360);
    const [cibleLat, cibleLon] = pointADistance(lat, lon, angle, rayon);
    const [noeud] = indexSpatial.plusProche(cibleLat, cibleLon,
                                            Math.max(400.0, rayon * 0.45));
    if (noeud === null || noeud === depart || ancres.includes(noeud)) continue;
    ancres.push(noeud);
  }
  if (ancres.length < 2) return null;

  const etapes = [depart, ...ancres, depart];
  return assemble(routeur, etapes, cibleM);
}

/**
 * Efface les boucles du parcours : effacement de lacets sur la marche obtenue.
 *
 * Un parcours qui repasse par un noeud deja visite contient, entre les deux
 * passages, une boucle fermee — le crochet qui fait le tour d'un pate de
 * maisons et revient au meme carrefour. La retirer laisse une marche valide
 * entre les memes extremites, simplement plus courte : la dichotomie sur le
 * rayon rattrape la distance en elargissant, ce qui est precisement la facon
 * dont ce programme veut allonger un parcours.
 *
 * La fermeture d'une boucle est le but recherche, pas un lacet : le dernier
 * retour au depart est donc epargne. Un retour au depart en cours de route,
 * lui, est bien une boucle de trop et disparait.
 */
// Ce qui separe un lacet de la forme meme du parcours : au-dela d'un quart
// de la distance visee, la boucle n'est plus un crochet a supprimer mais une
// part du dessin. C'est la borne que retient aussi mesureBouclettes, et il
// faut l'appliquer a tout effacement : effacer les lacets d'une marche fermee
// sans borne la reduirait a rien, puisqu'une boucle est, par construction,
// une marche qui revient sur elle-meme.
export const PART_LACET = 0.25;

export function effaceBoucles(trajet, aretes, lat, lon, depart, ferme, cibleM,
                              ecartMax = 80, rapportMin = 4) {
  const lacetMax = cibleM * PART_LACET;
  const pile = [];
  const cumul = [0];                       // longueur parcourue a chaque etape
  const position = new Map([[depart, 0]]); // noeud -> rang dans la pile
  // Grille spatiale sur les points deja atteints : une boucle peut se
  // refermer a quelques metres sans repasser par le meme noeud, quand l'aller
  // et le retour empruntent deux voies voisines.
  const CASE = Math.max(10, ecartMax);
  const cases = new Map();
  const clef = (i, j) => i * 1000003 + j;
  const caseDe = (n) => [
    Math.floor(lat[n] * 111320 / CASE),
    Math.floor(lon[n] * 111320 * Math.cos(lat[n] * Math.PI / 180) / CASE),
  ];
  const atteints = [depart];               // noeud atteint a chaque rang
  const enregistre = (noeud, rang) => {
    position.set(noeud, rang);
    atteints[rang] = noeud;
    const [ci, cj] = caseDe(noeud);
    const c = clef(ci, cj);
    const liste = cases.get(c);
    if (liste) liste.push(rang); else cases.set(c, [rang]);
  };
  enregistre(depart, 0);

  const oublie = (rang) => {
    for (const [noeud, p] of position) if (p > rang) position.delete(noeud);
    for (const liste of cases.values()) {
      let ecrit = 0;
      for (const p of liste) if (p <= rang) liste[ecrit++] = p;
      liste.length = ecrit;
    }
    pile.length = rang;
    cumul.length = rang + 1;
  };

  for (let k = 0; k < trajet.length; k++) {
    const [index, depuis] = trajet[k];
    const arete = aretes[index];
    const vers = depuis === arete.u ? arete.v : arete.u;
    pile.push(trajet[k]);
    cumul.push(cumul[cumul.length - 1] + arete.longueur);
    if (ferme && k === trajet.length - 1) break;

    const lacet = (rang) => {
      // Le depart est le seul point qu'une boucle a le droit de revoir :
      // y revenir en cours de route n'autorise pas a jeter tout ce qui
      // precede, sans quoi il ne resterait rien.
      if (ferme && rang === 0) return false;
      const parcouru = cumul[cumul.length - 1] - cumul[rang];
      return parcouru >= 80 && parcouru <= lacetMax;
    };

    // Retour exact sur un noeud deja visite : la boucle est sans ambiguite.
    const connu = position.get(vers);
    if (connu !== undefined) {
      if (lacet(connu)) { oublie(connu); continue; }
      enregistre(vers, pile.length);
      continue;
    }

    // Sinon, retour a quelques metres d'un point deja atteint : l'aller et le
    // retour ont emprunte deux voies voisines sans partager de noeud.
    const [ci, cj] = caseDe(vers);
    let candidat = -1;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const rang of (cases.get(clef(ci + di, cj + dj)) || [])) {
          if (rang <= candidat || !lacet(rang)) continue;
          // Meme critere que la mesure : un rapport, pas une distance seule.
          const ecart = distanceHaversine(lat[vers], lon[vers],
                                          lat[atteints[rang]], lon[atteints[rang]]);
          const parcouru = cumul[cumul.length - 1] - cumul[rang];
          if (ecart >= ecartMax || parcouru < ecart * rapportMin) continue;
          candidat = rang;
        }
      }
    }
    if (candidat >= 0) { oublie(candidat); continue; }

    enregistre(vers, pile.length);
  }
  return pile;
}

/**
 * Enchaine les troncons en penalisant au fur et a mesure les aretes deja
 * empruntees. Renvoie [longueur, repetee, trajet] ou null.
 */
function assemble(routeur, etapes, cibleM) {
  routeur.nouvellesPenalites();
  const trajetBrut = [];

  for (let k = 0; k + 1 < etapes.length; k++) {
    const a = etapes[k], b = etapes[k + 1];
    if (a === b) continue;
    const resultat = routeur.plusCourtChemin(a, b);
    if (resultat === null) return null;
    for (const pas of resultat[1]) {
      routeur.penalise(pas[0]);
      trajetBrut.push(pas);
    }
  }

  const ferme = etapes[0] === etapes[etapes.length - 1];
  const trajetTotal = effaceBoucles(trajetBrut, routeur.aretes, routeur.lat,
                                    routeur.lon, etapes[0], ferme, cibleM);
  if (!trajetTotal.length) return null;

  // Les comptes se refont sur le trajet net : ce qui a ete efface n'a pas ete
  // parcouru, et ne doit donc compter ni comme repetition ni comme longueur.
  const comptes = new Map();
  for (const [index] of trajetTotal) comptes.set(index, (comptes.get(index) || 0) + 1);
  const longueur = routeur.longueurTrajet(trajetTotal);

  // Repetition comptee par couloir et non par arete : aller par la rue et
  // revenir par le trottoir d'a cote est un doublement, meme si ce sont deux
  // aretes differentes. Un seul passage reste du au couloir, le reste est
  // compte comme repete. Sans jumelle, la formule redonne exactement
  // longueur x (n - 1), comme avant.
  const parCouloir = new Map();
  for (const [index, n] of comptes) {
    const c = routeur.couloir[index];
    const entree = parCouloir.get(c) || { total: 0, plusLong: 0 };
    entree.total += routeur.longueurs[index] * n;
    entree.plusLong = Math.max(entree.plusLong, routeur.longueurs[index]);
    parCouloir.set(c, entree);
  }
  let repetee = 0;
  for (const { total, plusLong } of parCouloir.values()) {
    repetee += Math.max(0, total - plusLong);
  }
  return [longueur, repetee, trajetTotal];
}

/**
 * Dichotomie sur le rayon de la couronne d'ancres. La distance cible est
 * atteinte en elargissant la boucle, jamais en la faisant zigzaguer.
 */
export function chercheBoucle(routeur, aretes, lat, lon, indexSpatial, depart,
                              latD, lonD, cibleM, cap, sommets, iterations,
                              tolerance, variantes = null) {
  const rayonIdeal = cibleM / (2 * sommets * Math.sin(Math.PI / sommets));
  let bas = rayonIdeal * 0.25, haut = rayonIdeal * 1.60;
  let meilleur = null;

  for (let i = 0; i < iterations; i++) {
    const rayon = (bas + haut) / 2.0;
    const essai = construitBoucle(routeur, aretes, indexSpatial, depart,
                                  latD, lonD, rayon, cap, sommets, cibleM);
    if (essai === null) { haut = rayon; continue; }
    const [longueur, repetee, trajet] = essai;
    const note = noteBoucle(longueur, repetee, cibleM, tolerance,
                            viragesSerres(trajet, aretes, lat, lon, longueur));
    const essaiNote = [note, longueur, repetee, trajet, sommets, cap, rayon];
    // Toutes les tentatives valides sont conservees, pas seulement la
    // meilleure : le controle geometrique final a besoin de matiere pour
    // trouver un trace sans defaut, et la dichotomie en produit dix par forme.
    if (variantes) variantes.push(essaiNote);
    if (meilleur === null || compareNote(note, meilleur[0]) < 0) meilleur = essaiNote;
    if (longueur < cibleM) bas = rayon; else haut = rayon;
  }
  return meilleur;
}

/** Balayage fin d'orientation et de rayon autour de la meilleure boucle. */
export function affineBoucle(routeur, aretes, lat, lon, indexSpatial, depart,
                             latD, lonD, cibleM, tolerance, repetitionMax,
                             meilleur, variantes = null) {
  const sommets = meilleur[4], cap = meilleur[5], rayon = meilleur[6];
  for (const decalage of [-9.0, -6.0, -3.0, 3.0, 6.0, 9.0, 0.0]) {
    for (const facteur of [0.88, 0.92, 0.96, 1.0, 1.04, 1.08, 1.12]) {
      if (decalage === 0.0 && facteur === 1.0) continue;
      const nouveauCap = moduloPositif(cap + decalage, 360);
      const essai = construitBoucle(routeur, aretes, indexSpatial, depart,
                                    latD, lonD, rayon * facteur, nouveauCap,
                                    sommets, cibleM);
      if (essai === null) continue;
      const [longueur, repetee, trajet] = essai;
      if (longueur && repetee / longueur > repetitionMax) continue;
      const note = noteBoucle(longueur, repetee, cibleM, tolerance,
                              viragesSerres(trajet, aretes, lat, lon, longueur));
      const essaiNote = [note, longueur, repetee, trajet, sommets, nouveauCap,
                         rayon * facteur];
      if (variantes) variantes.push(essaiNote);
      if (compareNote(note, meilleur[0]) < 0) meilleur = essaiNote;
    }
  }
  return meilleur;
}

/** Points de passage sur un arc bombe de `hauteur` metres reliant A a B. */
export function pointsIntermediaires(departLL, arriveeLL, hauteur, nombre) {
  const [lat1, lon1] = departLL;
  const [lat2, lon2] = arriveeLL;
  const direct = capEntre(lat1, lon1, lat2, lon2);
  const corde = distanceHaversine(lat1, lon1, lat2, lon2);
  const points = [];
  for (let i = 1; i <= nombre; i++) {
    const part = i / (nombre + 1.0);
    const [baseLat, baseLon] = pointADistance(lat1, lon1, direct, corde * part);
    const ecart = hauteur * Math.sin(Math.PI * part);
    const cote = ecart >= 0 ? moduloPositif(direct + 90.0, 360)
                            : moduloPositif(direct - 90.0, 360);
    points.push(pointADistance(baseLat, baseLon, cote, Math.abs(ecart)));
  }
  return points;
}

export function construitTrajet(routeur, aretes, indexSpatial, depart, arrivee,
                                departLL, arriveeLL, hauteur, nombre, cibleM) {
  const etapes = [depart];
  for (const [cibleLat, cibleLon] of pointsIntermediaires(departLL, arriveeLL, hauteur, nombre)) {
    const [noeud] = indexSpatial.plusProche(cibleLat, cibleLon,
                                            Math.max(400.0, Math.abs(hauteur) * 0.6));
    if (noeud !== null && !etapes.includes(noeud)) etapes.push(noeud);
  }
  etapes.push(arrivee);
  return assemble(routeur, etapes, cibleM);
}

export function chercheTrajet(routeur, aretes, lat, lon, indexSpatial, depart, arrivee,
                              departLL, arriveeLL, cibleM, nombre, cote,
                              iterations, tolerance, variantes = null) {
  const corde = distanceHaversine(departLL[0], departLL[1], arriveeLL[0], arriveeLL[1]);
  const reste = Math.max(0.0, Math.pow(cibleM / 2.0, 2) - Math.pow(corde / 2.0, 2));
  let bas = 0.0, haut = Math.sqrt(reste) * 1.7 + 300.0;
  let meilleur = null;

  for (let i = 0; i < iterations; i++) {
    const hauteur = (bas + haut) / 2.0;
    const essai = construitTrajet(routeur, aretes, indexSpatial, depart, arrivee,
                                  departLL, arriveeLL, hauteur * cote, nombre,
                                  cibleM);
    if (essai === null) { haut = hauteur; continue; }
    const [longueur, repetee, trajet] = essai;
    const note = noteBoucle(longueur, repetee, cibleM, tolerance,
                            viragesSerres(trajet, aretes, lat, lon, longueur));
    const essaiNote = [note, longueur, repetee, trajet, nombre, cote, hauteur];
    if (variantes) variantes.push(essaiNote);
    if (meilleur === null || compareNote(note, meilleur[0]) < 0) meilleur = essaiNote;
    if (longueur < cibleM) bas = hauteur; else haut = hauteur;
  }
  return meilleur;
}

export function affineTrajet(routeur, aretes, lat, lon, indexSpatial, depart, arrivee,
                             departLL, arriveeLL, cibleM, tolerance,
                             repetitionMax, meilleur, variantes = null) {
  const nombre = meilleur[4], cote = meilleur[5], hauteur = meilleur[6];
  for (const facteur of [0.84, 0.88, 0.92, 0.96, 1.04, 1.08, 1.12, 1.16]) {
    const essai = construitTrajet(routeur, aretes, indexSpatial, depart, arrivee,
                                  departLL, arriveeLL, hauteur * facteur * cote,
                                  nombre, cibleM);
    if (essai === null) continue;
    const [longueur, repetee, trajet] = essai;
    if (longueur && repetee / longueur > repetitionMax) continue;
    const note = noteBoucle(longueur, repetee, cibleM, tolerance,
                            viragesSerres(trajet, aretes, lat, lon, longueur));
    const essaiNote = [note, longueur, repetee, trajet, nombre, cote,
                       hauteur * facteur];
    if (variantes) variantes.push(essaiNote);
    if (compareNote(note, meilleur[0]) < 0) meilleur = essaiNote;
  }
  return meilleur;
}
