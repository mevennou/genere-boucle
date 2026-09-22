// Orchestration : portage de genere(). La source de donnees est injectee, ce
// qui permet aux tests de faire tourner l'algorithme complet sur un reseau
// fabrique, sans reseau ni Overpass.

import { distanceHaversine } from "./geo.js";
import { noeudsInfranchissables, LIBELLES_QUALITE } from "./regles.js";
import {
  construitGrapheBrut, contracte, supprimeImpasses, composante, restreint,
  construitCSR, IndexSpatial,
} from "./graphe.js";
import { Routeur } from "./routage.js";
import {
  chercheBoucle, affineBoucle, chercheTrajet, affineTrajet,
  polyligneDuTrajet, viragesSerres, compareNote,
} from "./boucle.js";
import { repartition, allege } from "./sortie.js";
import { detecteCorridors } from "./corridors.js";
import { mesureDoublement, mesureBouclettes } from "./controle.js";

export class DonneesIndisponibles extends Error {}
export class BoucleIntrouvable extends Error {}

const km = (m) => (m / 1000).toFixed(2);

// Ce qu'un repli anti-doublement a le droit de couter en distance : un
// dixieme de la distance demandee, pas davantage. Assez pour preferer un
// parcours un peu plus court a un parcours qui se longe, trop peu pour que le
// plus court chemin direct — qui ne double rien par construction — devienne
// une reponse acceptable a « quinze kilometres ».
export const MARGE_REPLI = 0.20;

// Combien de candidats le controle geometrique examine, du meilleur au moins
// bon. Les traces sans defaut ne sont pas forcement les mieux classes sur la
// distance : en regarder une poignee ne suffisait pas a en trouver un.
const CANDIDATS_EXAMINES = 120;

// Nombre de points de passage essayes pour un parcours d'un point a un autre.
// Au-dela de quatre, l'arc se plie assez pour tenir une longue distance entre
// deux points proches sans se refermer en lacets.
const POINTS_DE_PASSAGE = [1, 2, 3, 4, 5, 6];

/**
 * Choisit, parmi les candidats classes du meilleur au moins bon, celui dont
 * le dessin tient la route : ni portion longee, ni petite boucle ajoutee.
 *
 * Le repli ne porte que sur des candidats qui tiennent encore la distance.
 * Sans ce garde-fou, le plus court chemin direct — qui ne double evidemment
 * rien, puisqu'il ne fait aucun detour — finissait par etre retenu : 15 km
 * demandes, 1 km rendu. Mieux vaut un parcours qui longe cent metres de
 * lui-meme, et le dire, qu'un parcours a la bonne allure mais dix fois trop
 * court.
 *
 * L'ordre de preference est explicite : d'abord un trace sans rien a redire,
 * sinon un trace qui ne longe pas une portion de lui-meme, sinon le meilleur
 * tel quel — et le defaut restant est alors annonce.
 */
export function choisitTracePropre(meilleur, reserve, cible, seuils,
                                   pointsDe, maximum) {
  const erreurDe = (candidat) => Math.abs(candidat[1] - cible) / cible;
  // Le repli part de ce que le meilleur atteignait deja : sur un reseau qui
  // sature, manquer la distance est acceptable, s'en eloigner encore d'un
  // dixieme de plus ne l'est pas.
  const erreurMax = erreurDe(meilleur) + MARGE_REPLI;
  const candidats = [
    meilleur,
    ...reserve.filter((c) => c !== meilleur && erreurDe(c) <= erreurMax),
  ].slice(0, maximum);

  const mesures = [];
  let sansDoublement = null;
  for (const candidat of candidats) {
    const points = pointsDe(candidat);
    const mesure = { candidat, doublement: mesureDoublement(points),
                     bouclettes: mesureBouclettes(points) };
    mesures.push(mesure);
    if (mesure.doublement.longueur > seuils.doublement) continue;
    if (mesure.bouclettes.longueur <= seuils.bouclettes) return rendu(mesure);
    if (sansDoublement === null) sansDoublement = mesure;
  }
  return rendu(sansDoublement || mesures[0]);
}

const rendu = (m) => [m.candidat, m.doublement, m.bouclettes];

/**
 * Ce qu'on accepte de laisser passer sur le dessin final. Une portion longee
 * se compte en part de la distance ; une bouclette, elle, n'a pas de taille
 * acceptable : le seuil vaut le plancher de detection, donc toute bouclette
 * reperee compte.
 */
function seuilsGeometriques(cibleM) {
  return { doublement: Math.max(30, cibleM * 0.005), bouclettes: 60 };
}

/** Dit ce qui reste a redire sur le trace retenu, plutot que de le taire. */
function annonceDefauts(journal, quoi, remplace, doublement, bouclettes, seuils) {
  if (remplace) {
    journal(`  le meilleur ${quoi} avait un defaut de trace : candidat suivant retenu`);
  }
  if (doublement.longueur > seuils.doublement) {
    journal(`  aucun ${quoi} sans portion doublee a cette distance : le meilleur `
          + `longe ${doublement.longueur.toFixed(0)} m de lui-meme`);
  }
  if (bouclettes.longueur > seuils.bouclettes) {
    journal(`  aucun ${quoi} sans petite boucle a cette distance : il en reste `
          + `${bouclettes.nombre} (${bouclettes.longueur.toFixed(0)} m au total)`);
  }
}

export async function genere({
  lat, lon, cibleM, niveau = "normal", caps = 16, sommets = [3, 4, 5, 6],
  iterations = 10, tolerance = 0.03, repetitionMax = 0.12, maxPoints = 3000,
  arrivee = null, rafraichir = false, journal = () => {}, source,
}) {
  // 1. reseau OSM ---------------------------------------------------------
  let rayon = cibleM * 0.40 + 800;
  let centreLat = lat, centreLon = lon;
  if (arrivee) {
    centreLat = (lat + arrivee[0]) / 2.0;
    centreLon = (lon + arrivee[1]) / 2.0;
    rayon += distanceHaversine(lat, lon, arrivee[0], arrivee[1]) / 2.0;
  }
  rayon = Math.min(rayon, 25000);
  journal(`1/5 Reseau OpenStreetMap dans un rayon de ${rayon.toFixed(0)} m`);
  if (rayon > 8000) {
    journal("  zone etendue : compter un peu de patience la premiere fois, "
          + "puis c'est en cache");
  }

  const [voies, balisesRes, barrieresRes] = await Promise.all([
    source.reseau(centreLat, centreLon, rayon, rafraichir, journal),
    source.itineraires(centreLat, centreLon, rayon, rafraichir, journal)
      .catch((e) => e),
    source.barrieres(centreLat, centreLon, rayon, rafraichir, journal)
      .catch((e) => e),
  ]);

  const bloques = barrieresRes instanceof Error
    ? new Set() : noeudsInfranchissables(barrieresRes);
  if (bloques.size) {
    journal(`  ${bloques.size} obstacles infranchissables releves (portails, clotures)`);
  }
  let balises;
  if (balisesRes instanceof Error) {
    journal("  itineraires balises indisponibles : les chemins non documentes "
          + "seront ecartes");
    balises = new Set();
  } else {
    balises = balisesRes;
    journal(`  ${balises.size} voies appartiennent a un itineraire pedestre balise`);
  }

  // 2. filtrage de praticabilite ------------------------------------------
  journal("2/5 Filtrage de praticabilite");
  const G = construitGrapheBrut(voies, niveau, balises, bloques);
  const { brut, nbNoeuds, lat: latN, lon: lonN } = G;
  journal(`  ${G.retenues} voies sur ${voies.length} retenues comme praticables `
        + `(${voies.length - G.retenues} ecartees comme impraticables ou interdites)`);
  if (G.nbAvecAretes < 50) {
    throw new BoucleIntrouvable(
      "Trop peu de voies praticables autour de ce point. Essayer le niveau "
      + "tolerant, ou un depart plus proche d'une zone habitee.");
  }

  const avecAretes = [];
  for (let n = 0; n < nbNoeuds; n++) if (brut[n]) avecAretes.push(n);
  const indexComplet = new IndexSpatial(latN, lonN, avecAretes);
  const [departBrut, ecartDepart] = indexComplet.plusProche(lat, lon);
  if (departBrut === null) {
    throw new BoucleIntrouvable(
      "Aucun chemin praticable a proximite du point de depart choisi.");
  }
  journal(`  depart accroche a ${ecartDepart.toFixed(0)} m du point demande`);

  let arriveeBrut = null, ecartArrivee = 0.0;
  if (arrivee) {
    [arriveeBrut, ecartArrivee] = indexComplet.plusProche(arrivee[0], arrivee[1]);
    if (arriveeBrut === null) {
      throw new BoucleIntrouvable("Aucun chemin praticable a proximite du point d'arrivee.");
    }
  }

  // 3. suppression des impasses -------------------------------------------
  journal("3/5 Suppression des impasses (aucun demi-tour possible ensuite)");
  const proteges = new Set([departBrut]);
  if (arriveeBrut !== null) proteges.add(arriveeBrut);
  const { aretes, adjacence } = contracte(brut, nbNoeuds, proteges);
  let coeur = supprimeImpasses(aretes, adjacence, nbNoeuds);
  let nbCoeur = 0;
  for (let n = 0; n < nbNoeuds; n++) if (coeur[n]) nbCoeur += coeur[n].length;
  journal(`  ${aretes.length} aretes, ${Math.floor(nbCoeur / 2)} apres elagage `
        + "des culs-de-sac");

  const { couloir, nbJumelages, decalage, alignement } =
    detecteCorridors(aretes, latN, lonN);
  if (nbJumelages) {
    journal(`  ${nbJumelages} voies doublees d'un trottoir cartographie a part : `
          + "regroupees, pour qu'aller par l'une et revenir par l'autre compte "
          + "comme un aller-retour");
  }

  const routeur = new Routeur(construitCSR(adjacence, nbNoeuds), aretes,
                              latN, lonN, nbNoeuds, couloir, decalage, alignement);

  let depart, amorce = [], longueurAmorce = 0.0;
  if (coeur[departBrut]) {
    depart = departBrut;
  } else {
    // Le depart est sur une voie sans issue : on rejoint le premier point du
    // reseau maille, et cette amorce est le seul aller-retour inevitable.
    const [noeud, trajet] = routeur.rejointCoeur(adjacence, departBrut, (n) => Boolean(coeur[n]));
    if (noeud === null) throw new BoucleIntrouvable("Depart isole du reseau praticable.");
    depart = noeud; amorce = trajet;
    longueurAmorce = routeur.longueurTrajet(amorce);
    journal(`  amorce depuis l'impasse du depart : ${longueurAmorce.toFixed(0)} m `
          + "(seul aller-retour inevitable)");
  }

  let noeudArrivee = depart, amorceArrivee = [], longueurAmorceArrivee = 0.0;
  if (arrivee) {
    if (coeur[arriveeBrut]) {
      noeudArrivee = arriveeBrut;
    } else {
      const [noeud, trajet] = routeur.rejointCoeur(adjacence, arriveeBrut, (n) => Boolean(coeur[n]));
      if (noeud === null) throw new BoucleIntrouvable("Arrivee isolee du reseau praticable.");
      noeudArrivee = noeud; amorceArrivee = trajet;
      longueurAmorceArrivee = routeur.longueurTrajet(amorceArrivee);
    }
    journal(`  arrivee accrochee a ${ecartArrivee.toFixed(0)} m du point demande`);
  }

  const atteignables = composante(coeur, depart);
  coeur = restreint(coeur, atteignables, nbNoeuds);
  if (atteignables.size < 20) {
    throw new BoucleIntrouvable("Reseau maille trop petit autour du depart.");
  }
  if (arrivee && !coeur[noeudArrivee]) {
    throw new BoucleIntrouvable(
      "Aucun itineraire praticable ne relie le depart a l'arrivee. Verifier les "
      + "deux points, ou assouplir le niveau d'exigence.");
  }
  const indexCoeur = new IndexSpatial(latN, lonN, atteignables);
  const routeurCoeur = new Routeur(construitCSR(coeur, nbNoeuds), aretes,
                                   latN, lonN, nbNoeuds, couloir, decalage,
                                   alignement);

  // 4. recherche -----------------------------------------------------------
  if (arrivee) {
    return traceVersArrivee({
      routeur: routeurCoeur, aretes, latN, lonN, indexCoeur, depart, noeudArrivee,
      departLL: [lat, lon], arriveeLL: arrivee, cibleM, amorce, amorceArrivee,
      longueurAmorce, longueurAmorceArrivee, iterations, tolerance,
      repetitionMax, maxPoints, ecartDepart, journal,
    });
  }

  const budget = Math.max(cibleM - 2 * longueurAmorce, cibleM * 0.3);
  journal(`4/5 Recherche de la boucle (${caps} orientations x ${sommets.length} formes)`);
  let meilleur = null;
  // Toutes les tentatives valides sont gardees en reserve : si le meilleur
  // candidat se revele avoir un defaut de trace, on prend le suivant plutot
  // que de le servir tel quel.
  const variantes = [];

  for (let indexCap = 0; indexCap < caps; indexCap++) {
    const cap = indexCap * 360.0 / caps;
    let ligne = `  cap ${String(Math.round(cap)).padStart(3)} deg :`;
    for (const nbSommets of sommets) {
      const essai = chercheBoucle(routeurCoeur, aretes, latN, lonN, indexCoeur,
                                  depart, lat, lon, budget, cap, nbSommets,
                                  iterations, tolerance, variantes);
      if (essai === null) { ligne += `  ${nbSommets}s: -`; continue; }
      const [note, longueur, repetee] = essai;
      const part = longueur ? repetee / longueur : 1.0;
      ligne += `  ${nbSommets}s: ${km(longueur + 2 * longueurAmorce)}km/`
             + `${(part * 100).toFixed(0)}%`;
      if (part > repetitionMax) continue;
      if (meilleur === null || compareNote(note, meilleur[0]) < 0) meilleur = essai;
    }
    journal(ligne);
    if (indexCap % 4 === 3) await souffle();
  }

  if (meilleur === null) {
    throw new BoucleIntrouvable(
      "Aucune boucle sans aller-retour trouvee pour cette distance. Essayer une "
      + "distance un peu differente, un autre depart, ou un niveau d'exigence "
      + "moins severe.");
  }

  const avant = meilleur;
  meilleur = affineBoucle(routeurCoeur, aretes, latN, lonN, indexCoeur, depart,
                          lat, lon, budget, tolerance, repetitionMax, meilleur,
                          variantes);
  if (meilleur !== avant) {
    journal(`  affinage : ${km(avant[1] + 2 * longueurAmorce)} km -> `
          + `${km(meilleur[1] + 2 * longueurAmorce)} km, repetition `
          + `${avant[2].toFixed(0)} -> ${meilleur[2].toFixed(0)} m, crochets `
          + `${avant[0][3].toFixed(2)} -> ${meilleur[0][3].toFixed(2)} par km`);
  }

  // Derniere verification, sur la geometrie et non sur le graphe : un aller
  // par la rue et un retour par le trottoir d'a cote restent deux aretes
  // distinctes, donc invisibles pour tout comptage base sur les identifiants.
  // Ce controle ne suppose rien de la cause, il regarde le dessin obtenu.
  const seuils = seuilsGeometriques(cibleM);
  const pointsDe = (essai) =>
    allege(polyligneDuTrajet(essai[3], aretes).map((n) => [latN[n], lonN[n]]), maxPoints);

  const reserve = variantes.filter((c) => !(c[1] && c[2] / c[1] > repetitionMax));
  reserve.sort((a, b) => compareNote(a[0], b[0]));
  const [choisi, doublement, bouclettes] = choisitTracePropre(
    meilleur, reserve, budget, seuils, pointsDe, CANDIDATS_EXAMINES);
  annonceDefauts(journal, "boucle", choisi !== meilleur, doublement, bouclettes, seuils);
  meilleur = choisi;

  const [, longueur, repetee, trajet, nbSommets, cap] = meilleur;


  // 5. assemblage du trace -------------------------------------------------
  let noeuds = [];
  if (amorce.length) noeuds = polyligneDuTrajet(amorce, aretes);
  const boucle = polyligneDuTrajet(trajet, aretes);
  if (noeuds.length && boucle.length && noeuds[noeuds.length - 1] === boucle[0]) {
    noeuds.push(...boucle.slice(1));
  } else {
    noeuds.push(...boucle);
  }
  if (amorce.length) {
    const retour = polyligneDuTrajet(amorce, aretes).reverse();
    noeuds.push(...(noeuds[noeuds.length - 1] === retour[0] ? retour.slice(1) : retour));
  }

  const points = allege(noeuds.map((n) => [latN[n], lonN[n]]), maxPoints);
  const distance = longueur + 2 * longueurAmorce;
  journal(`5/5 Trace retenu : ${km(distance)} km, ${repetee.toFixed(0)} m parcourus deux fois`
        + (doublement.longueur > 0
           ? `, ${doublement.longueur.toFixed(0)} m longeant une autre portion` : ""));

  return {
    points, distance, cible: cibleM, repetee,
    partRepetee: longueur ? repetee / longueur : 0.0,
    amorce: longueurAmorce, sommets: nbSommets, cap, accroche: ecartDepart,
    types: repartition(trajet, aretes, "etiquette"),
    qualites: repartition(trajet, aretes, "qualite")
      .map(([q, m]) => [LIBELLES_QUALITE[q] || q, m]),
    longueurBoucle: longueur, boucle: true,
    doublement: doublement.longueur, portionsDoublees: doublement.portions.length,
    bouclettes: bouclettes.longueur, nbBouclettes: bouclettes.nombre,
  };
}

function traceVersArrivee({
  routeur, aretes, latN, lonN, indexCoeur, depart, noeudArrivee, departLL,
  arriveeLL, cibleM, amorce, amorceArrivee, longueurAmorce,
  longueurAmorceArrivee, iterations, tolerance, repetitionMax, maxPoints,
  ecartDepart, journal,
}) {
  const budget = cibleM - longueurAmorce - longueurAmorceArrivee;

  routeur.nouvellesPenalites();
  const direct = routeur.plusCourtChemin(depart, noeudArrivee);
  if (direct === null) {
    throw new BoucleIntrouvable("Aucun itineraire praticable ne relie le depart a l'arrivee.");
  }
  const minimum = routeur.longueurTrajet(direct[1]);
  const totalMinimum = minimum + longueurAmorce + longueurAmorceArrivee;
  if (budget < minimum * 0.98) {
    throw new BoucleIntrouvable(
      `Distance trop courte : le plus court chemin praticable entre ces deux `
      + `points fait deja ${km(totalMinimum)} km.`);
  }

  journal(`4/5 Recherche du parcours (plus court chemin : ${km(totalMinimum)} km)`);
  let meilleur = null;
  const variantes = [];
  for (const nombre of POINTS_DE_PASSAGE) {
    let ligne = `  ${nombre} point(s) de passage :`;
    for (const [cote, libelle] of [[1.0, "gauche"], [-1.0, "droite"]]) {
      const essai = chercheTrajet(routeur, aretes, latN, lonN, indexCoeur, depart,
                                  noeudArrivee, departLL, arriveeLL, budget,
                                  nombre, cote, iterations, tolerance, variantes);
      if (essai === null) { ligne += `  ${libelle} : -`; continue; }
      const [note, longueur, repetee] = essai;
      const part = longueur ? repetee / longueur : 1.0;
      ligne += `  ${libelle} : ${km(longueur + longueurAmorce + longueurAmorceArrivee)}`
             + ` km / ${(part * 100).toFixed(0)} %`;
      if (part > repetitionMax) continue;
      if (meilleur === null || compareNote(note, meilleur[0]) < 0) meilleur = essai;
    }
    journal(ligne);
  }

  if (meilleur === null) {
    throw new BoucleIntrouvable(
      "Aucun parcours sans aller-retour trouve pour cette distance entre ces "
      + "deux points. Essayer une distance differente.");
  }

  meilleur = affineTrajet(routeur, aretes, latN, lonN, indexCoeur, depart,
                          noeudArrivee, departLL, arriveeLL, budget, tolerance,
                          repetitionMax, meilleur, variantes);

  // Meme controle geometrique que pour les boucles : un parcours d'un point a
  // un autre peut tout aussi bien longer une portion de lui-meme, par la rue a
  // l'aller et le trottoir au retour.
  const seuils = seuilsGeometriques(cibleM);
  const pointsDe = (essai) =>
    allege(polyligneDuTrajet(essai[3], aretes).map((n) => [latN[n], lonN[n]]), maxPoints);

  const reserve = variantes.filter((c) => !(c[1] && c[2] / c[1] > repetitionMax));
  reserve.sort((a, b) => compareNote(a[0], b[0]));
  const [choisi, doublement, bouclettes] = choisitTracePropre(
    meilleur, reserve, budget, seuils, pointsDe, CANDIDATS_EXAMINES);
  annonceDefauts(journal, "parcours", choisi !== meilleur, doublement, bouclettes, seuils);
  meilleur = choisi;

  const [, longueur, repetee, trajet, nombre] = meilleur;

  let noeuds = amorce.length ? polyligneDuTrajet(amorce, aretes) : [];
  const coeurTrace = polyligneDuTrajet(trajet, aretes);
  noeuds.push(...(noeuds.length && noeuds[noeuds.length - 1] === coeurTrace[0]
                  ? coeurTrace.slice(1) : coeurTrace));
  if (amorceArrivee.length) {
    const fin = polyligneDuTrajet(amorceArrivee, aretes).reverse();
    noeuds.push(...(noeuds[noeuds.length - 1] === fin[0] ? fin.slice(1) : fin));
  }

  const points = allege(noeuds.map((n) => [latN[n], lonN[n]]), maxPoints);
  const distance = longueur + longueurAmorce + longueurAmorceArrivee;
  journal(`5/5 Parcours retenu : ${km(distance)} km, ${repetee.toFixed(0)} m parcourus deux fois`
        + (doublement.longueur > 0
           ? `, ${doublement.longueur.toFixed(0)} m longeant une autre portion` : ""));

  return {
    points, distance, cible: cibleM, repetee,
    partRepetee: longueur ? repetee / longueur : 0.0,
    amorce: longueurAmorce + longueurAmorceArrivee,
    sommets: nombre, cap: 0.0, accroche: ecartDepart,
    types: repartition(trajet, aretes, "etiquette"),
    qualites: repartition(trajet, aretes, "qualite")
      .map(([q, m]) => [LIBELLES_QUALITE[q] || q, m]),
    longueurBoucle: longueur, boucle: false,
    doublement: doublement.longueur, portionsDoublees: doublement.portions.length,
    bouclettes: bouclettes.longueur, nbBouclettes: bouclettes.nombre,
  };
}

// Rend la main au fil d'execution pour que les messages d'avancement
// parviennent a l'interface pendant le calcul.
const souffle = () => new Promise((r) => setTimeout(r, 0));
