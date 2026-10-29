// Orchestration : portage de genere(). La source de donnees est injectee, ce
// qui permet aux tests de faire tourner l'algorithme complet sur un reseau
// fabrique, sans reseau ni Overpass.

import { distanceHaversine } from "./geo.js";
import { noeudsInfranchissables, expositionRoute, LIBELLES_QUALITE } from "./regles.js";
import {
  construitGrapheBrut, contracte, supprimeImpasses, composante, restreint,
  construitCSR, IndexSpatial, composantesUtiles,
} from "./graphe.js";
import { Routeur } from "./routage.js";
import {
  chercheBoucle, affineBoucle, chercheTrajet, affineTrajet,
  polyligneDuTrajet, viragesSerres, compareNote, ecartDistance,
} from "./boucle.js";
import { repartition, allege } from "./sortie.js";
import { detecteCorridors } from "./corridors.js";
import { mesureDoublement, mesureBouclettes } from "./controle.js";

export class DonneesIndisponibles extends Error {}
export class BoucleIntrouvable extends Error {}

const km = (m) => (m / 1000).toFixed(2);

// Jusqu'ou un repli anti-doublement peut s'ecarter de la distance demandee,
// en ecart pondere : la tolerance elle-meme, soit 5 % de plus ou 0,5 % de
// moins. La distance est la seule chose que le coureur ait demandee ; une
// petite boucle se voit sur la carte et s'annonce, dix pour cent de moins ne
// se rattrapent qu'en tournant autour du pate de maisons a l'arrivee. Une
// marge d'un cinquieme rendait neuf kilometres pour dix des que le meilleur
// trace avait un defaut.
export const MARGE_REPLI = 0.05;

// En deca, une composante du reseau ne peut pas porter un parcours : ce n'est
// pas un quartier, c'est un ilot.
const MIN_NOEUDS_COEUR = 20;

// Jusqu'ou chercher une voie reliee au reste, quand le point pose n'en touche
// aucune. La meme portee que la recherche initiale : au-dela, il n'y a plus
// rien a proposer.
const PORTEE_SECOURS = 1500;

// Ce qu'une amorce en impasse peut representer de la distance demandee. Une
// boucle la court deux fois : au-dela, ce n'est plus l'acces au parcours,
// c'en est la moitie en aller-retour. Une campagne dont on a retire les
// routes rapides n'est plus qu'un arbre de chemins, et le premier noeud du
// reseau maille pouvait s'y trouver a trois kilometres et demi : huit
// kilometres demandes, trente-six rendus.
const PART_AMORCE = 0.15;

// Repetition admise en dernier recours, quand aucun candidat ne tient la
// distance sous le plafond ordinaire. Un depart pose sur une petite boucle
// que le reste du reseau ne rejoint que par un seul passage ne peut pas
// s'en eloigner sans repasser par la : refuser toute repetition le
// condamnait au tour de son pate de maisons, 1,6 km pour 8 demandes.
const REPETITION_RECOURS = 0.25;

// Quand une seule boucle ne peut vraiment pas tenir la distance — elle en
// manque plus d'un vingtieme ou la depasse d'un cinquieme —, une boucle plus
// courte a faire plusieurs fois vaut mieux qu'un parcours faux : quatorze
// kilometres, c'est deux fois une boucle de sept. Pas avant : refaire la
// meme boucle est un pis-aller, pas une facon de gagner en precision.
const MANQUE_TOURS = 0.05;
const SURPLUS_TOURS = 0.20;
// Au-dela de quatre tours, ou sous deux kilometres, ce n'est plus une boucle
// a refaire, c'est un tour de pate de maisons : mieux vaut alors le meilleur
// parcours unique, et l'annoncer tel qu'il est.
const TOURS_MAX = 4;
const BOUCLE_MIN = 2000;

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
 * sinon celui dont les defauts sont les plus courts — portions longees et
 * petites boucles comptees ensemble — et le defaut restant est alors annonce.
 * Preferer d'office un trace sans portion longee retenait un parcours qui
 * gardait 1,8 km de crochets plutot qu'un voisin qui longeait 400 m.
 */
export function choisitTracePropre(meilleur, reserve, cible, seuils,
                                   pointsDe, maximum) {
  const erreurDe = (candidat) => ecartDistance(candidat[1], cible);
  // Le repli reste dans la marge, ou a l'ecart qu'avait deja le meilleur : sur
  // un reseau qui sature, manquer la distance est acceptable, s'en eloigner
  // davantage pour un dessin plus net ne l'est pas. L'ecart ne s'additionne
  // pas : un meilleur deja a vingt pour cent ne donne pas droit a quarante.
  const erreurMax = Math.max(erreurDe(meilleur), MARGE_REPLI);
  const candidats = [
    meilleur,
    ...reserve.filter((c) => c !== meilleur && erreurDe(c) <= erreurMax),
  ].slice(0, maximum);

  let moinsPire = null, defautMin = Infinity;
  for (const candidat of candidats) {
    const points = pointsDe(candidat);
    const mesure = { candidat, doublement: mesureDoublement(points),
                     bouclettes: mesureBouclettes(points) };
    if (mesure.doublement.longueur <= seuils.doublement
        && mesure.bouclettes.longueur <= seuils.bouclettes) return rendu(mesure);
    const defaut = mesure.doublement.longueur + mesure.bouclettes.longueur;
    if (defaut < defautMin) { moinsPire = mesure; defautMin = defaut; }
  }
  return rendu(moinsPire);
}

const rendu = (m) => [m.candidat, m.doublement, m.bouclettes];

/**
 * Releve le plafond de repetition quand, dessous, rien ne tient la distance.
 *
 * Le candidat de recours doit alors meriter sa place : un metre couru deux
 * fois compte comme un metre manquant, et il ne l'emporte que si la somme
 * des deux est plus faible. Huit kilometres dont un cinquieme repete valent
 * mieux qu'un tour de pate de maisons ; sept kilometres et demi sans rien
 * repeter valent mieux que huit dont un quart en aller-retour.
 *
 * Renvoie [meilleur, plafond] : le plafond retenu vaut ensuite pour
 * l'affinage et pour la reserve du controle geometrique.
 */
function recoursRepetition(meilleur, variantes, cible, repetitionMax, journal, quoi) {
  if (meilleur !== null && meilleur[0][0] === 0) return [meilleur, repetitionMax];
  const part = (c) => (c[1] ? c[2] / c[1] : 1.0);
  const cout = (c) => ecartDistance(c[1], cible) + part(c);
  let recours = null;
  for (const c of variantes) {
    if (part(c) <= repetitionMax || part(c) > REPETITION_RECOURS) continue;
    if (recours === null || cout(c) < cout(recours)) recours = c;
  }
  if (recours === null || (meilleur !== null && cout(recours) >= cout(meilleur))) {
    return [meilleur, repetitionMax];
  }
  journal(`  aucun ${quoi} a cette distance sans repasser par les memes voies : `
        + `jusqu'a ${(REPETITION_RECOURS * 100).toFixed(0)} % de repetition admis`);
  return [recours, REPETITION_RECOURS];
}

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
  excentres = [false, true],
  iterations = 10, tolerance = 0.05, repetitionMax = 0.12, maxPoints = 3000,
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
  // Les routes ecartees pour le danger sont dites a part : quand elles seules
  // reliaient le depart au reste, le refus doit dire pourquoi, et comment le
  // lever en connaissance de cause.
  let indiceDanger = "";
  if (niveau !== "tolerant") {
    const dangereuses = voies.filter((v) => expositionRoute(v.tags || {}) === "danger").length;
    if (dangereuses) {
      journal(`  dont ${dangereuses} routes sans trottoir a 70 km/h ou plus, `
            + "trop dangereuses a pied");
      indiceDanger = " Les routes sans trottoir a 70 km/h ou plus sont ecartees "
                   + "par securite ; le niveau tolerant les accepte, a ne "
                   + "choisir qu'en les connaissant.";
    }
  }
  if (G.nbAvecAretes < 50) {
    throw new BoucleIntrouvable(
      "Trop peu de voies praticables autour de ce point. Essayer le niveau "
      + "tolerant, ou un depart plus proche d'une zone habitee." + indiceDanger);
  }

  const avecAretes = [];
  for (let n = 0; n < nbNoeuds; n++) if (brut[n]) avecAretes.push(n);
  const indexComplet = new IndexSpatial(latN, lonN, avecAretes);
  let [departBrut, ecartDepart] = indexComplet.plusProche(lat, lon);
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

  // Le reseau n'est pas d'un seul tenant. On retient les composantes capables
  // de porter le parcours demande, et c'est a l'une d'elles que les points
  // s'accrochent : le noeud le plus proche a vol d'oiseau appartient souvent a
  // un ilot — les allees d'un campus, un lotissement ferme — qui ne mene nulle
  // part. C'est ce qui se produisait des qu'une adresse ou une geolocalisation
  // posait le depart au milieu d'un site plutot que sur une rue.
  let utiles = composantesUtiles(coeur, aretes, nbNoeuds,
    { minNoeuds: MIN_NOEUDS_COEUR, minLongueur: cibleM * 0.5 });
  if (!utiles.size) {
    utiles = composantesUtiles(coeur, aretes, nbNoeuds, { minNoeuds: MIN_NOEUDS_COEUR });
  }
  if (!utiles.size) {
    throw new BoucleIntrouvable("Reseau maille trop petit autour du depart.");
  }
  const indexUtile = new IndexSpatial(latN, lonN, utiles);

  const accroche = (brut, ecart, point, quoi) => {
    // 1. Deja sur le reseau utile : rien a faire.
    if (utiles.has(brut)) return { noeud: brut, amorce: [], longueur: 0, ecart };

    // 2. Sur une voie sans issue qui y mene : on la remonte, et cette amorce
    //    est le seul aller-retour inevitable — tant qu'elle reste courte.
    const [noeud, trajet] = routeur.rejointCoeur(adjacence, brut, (n) => utiles.has(n));
    let raison = "n'est relie a aucune rue praticable";
    if (noeud !== null) {
      const longueur = routeur.longueurTrajet(trajet);
      if (longueur <= cibleM * PART_AMORCE) {
        journal(`  amorce depuis l'impasse ${quoi} : ${longueur.toFixed(0)} m `
              + "(seul aller-retour inevitable)");
        return { noeud, amorce: trajet, longueur, ecart };
      }
      raison = `ne rejoint le reseau qu'au bout de ${longueur.toFixed(0)} m d'impasse`;
    }

    // 3. Sur un ilot sans issue, ou au bout d'une impasse trop longue : on
    //    prend la voie reliee au reste la plus proche, et le resultat dit ou le
    //    parcours commence vraiment — c'est a l'interface de replacer le
    //    marqueur, pour que la carte montre le depart reel plutot que de
    //    laisser croire qu'il est reste ou on l'avait pose.
    const [secours, distance] = indexUtile.plusProche(point[0], point[1],
                                                      PORTEE_SECOURS);
    if (secours === null) {
      throw new BoucleIntrouvable(
        `Le point ${quoi} ${raison}, et aucune voie reliee au reste ne se `
        + "trouve a moins d'un kilometre et demi. Poser le point plus pres "
        + "d'une rue ou d'un chemin." + indiceDanger);
    }
    journal(`  point ${quoi} deplace de ${distance.toFixed(0)} m : l'endroit `
          + `pose ${raison}`);
    return { noeud: secours, amorce: [], longueur: 0, ecart: distance,
             deplace: distance };
  };

  const pose = accroche(departBrut, ecartDepart, [lat, lon], "de depart");
  const deplaceDepart = pose.deplace || 0;
  const depart = pose.noeud;
  const amorce = pose.amorce;
  const longueurAmorce = pose.longueur;
  ecartDepart = pose.ecart;

  let noeudArrivee = depart, amorceArrivee = [], longueurAmorceArrivee = 0.0;
  let deplaceArrivee = 0;
  if (arrivee) {
    const fin = accroche(arriveeBrut, ecartArrivee, arrivee, "d'arrivee");
    noeudArrivee = fin.noeud;
    amorceArrivee = fin.amorce;
    longueurAmorceArrivee = fin.longueur;
    ecartArrivee = fin.ecart;
    deplaceArrivee = fin.deplace || 0;
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
      + "deux points, ou assouplir le niveau d'exigence." + indiceDanger);
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
      deplaceDepart, deplaceArrivee, indiceDanger,
    });
  }

  const budget = Math.max(cibleM - 2 * longueurAmorce, cibleM * 0.3);
  // Le polygone se pose sur le depart reel, pas sur le point clique : quand
  // celui-ci a du etre deplace, ou rejoint le reseau par une impasse, une
  // forme dont le depart est un sommet partirait sinon d'un endroit ou le
  // parcours ne passe pas.
  const latDepart = latN[depart], lonDepart = lonN[depart];
  const formes = sommets.length * excentres.length;

  // Une recherche complete : toutes les orientations, toutes les formes.
  // Renvoie le meilleur candidat sous le plafond de repetition, et toutes les
  // tentatives en reserve.
  const recherche = async (cible, enTete) => {
    journal(enTete);
    let meilleur = null;
    // Toutes les tentatives valides sont gardees en reserve : si le meilleur
    // candidat se revele avoir un defaut de trace, on prend le suivant plutot
    // que de le servir tel quel.
    const variantes = [];
    for (let indexCap = 0; indexCap < caps; indexCap++) {
      const cap = indexCap * 360.0 / caps;
      let ligne = `  cap ${String(Math.round(cap)).padStart(3)} deg :`;
      for (const excentre of excentres) {
        for (const nbSommets of sommets) {
          // « 4s » : carre centre sur le depart ; « 4e » : carre dont le
          // depart est un sommet.
          const forme = `${nbSommets}${excentre ? "e" : "s"}`;
          const essai = chercheBoucle(routeurCoeur, aretes, latN, lonN, indexCoeur,
                                      depart, latDepart, lonDepart, cible, cap,
                                      nbSommets, iterations, tolerance, variantes,
                                      excentre);
          if (essai === null) { ligne += `  ${forme}: -`; continue; }
          const [note, longueur, repetee] = essai;
          const part = longueur ? repetee / longueur : 1.0;
          ligne += `  ${forme}: ${km(longueur + 2 * longueurAmorce)}km/`
                 + `${(part * 100).toFixed(0)}%`;
          if (part > repetitionMax) continue;
          if (meilleur === null || compareNote(note, meilleur[0]) < 0) meilleur = essai;
        }
      }
      journal(ligne);
      if (indexCap % 4 === 3) await souffle();
    }
    return [meilleur, variantes];
  };

  let [meilleur, variantes] = await recherche(
    budget, `4/5 Recherche de la boucle (${caps} orientations x ${formes} formes)`);

  // Incapacite reelle : la meilleure boucle manque nettement la distance. On
  // cherche alors un parcours deux, trois... fois plus court, a refaire
  // autant de fois, et on garde le premier qui tient la tolerance. Un tour,
  // c'est le fichier entier, amorce comprise : « fais-le deux fois » doit
  // donner la distance annoncee.
  let tours = 1, cibleBoucle = budget;
  const incapable = (c) => c === null || c[1] < budget * (1 - MANQUE_TOURS)
                        || c[1] > budget * (1 + SURPLUS_TOURS);
  if (incapable(meilleur) && cibleM / 2 >= BOUCLE_MIN) {
    journal(`  aucune boucle unique ne tient ${km(cibleM)} km sans aller-retour`);
    for (let n = 2; n <= TOURS_MAX && cibleM / n >= BOUCLE_MIN; n++) {
      const cibleTour = cibleM / n - 2 * longueurAmorce;
      // L'amorce ne doit pas devenir l'essentiel de chaque tour.
      if (cibleTour < cibleM / n / 2) break;
      const [unTour, reserveTour] = await recherche(cibleTour,
        `  essai d'un parcours de ${km(cibleM / n)} km a faire ${n} fois`);
      if (unTour !== null && unTour[0][0] === 0) {
        [meilleur, variantes, tours, cibleBoucle] = [unTour, reserveTour, n, cibleTour];
        break;
      }
    }
  }

  let plafond;
  [meilleur, plafond] = recoursRepetition(meilleur, variantes, cibleBoucle,
                                          repetitionMax, journal, "boucle");
  if (meilleur === null) {
    throw new BoucleIntrouvable(
      "Aucune boucle sans aller-retour trouvee pour cette distance. Essayer une "
      + "distance un peu differente, un autre depart, ou un niveau d'exigence "
      + "moins severe." + indiceDanger);
  }

  const avant = meilleur;
  meilleur = affineBoucle(routeurCoeur, aretes, latN, lonN, indexCoeur, depart,
                          latDepart, lonDepart, cibleBoucle, tolerance, plafond,
                          meilleur, variantes);
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
  const seuils = seuilsGeometriques(cibleBoucle);
  const pointsDe = (essai) =>
    allege(polyligneDuTrajet(essai[3], aretes).map((n) => [latN[n], lonN[n]]), maxPoints);

  const reserve = variantes.filter((c) => !(c[1] && c[2] / c[1] > plafond));
  reserve.sort((a, b) => compareNote(a[0], b[0]));
  const [choisi, doublement, bouclettes] = choisitTracePropre(
    meilleur, reserve, cibleBoucle, seuils, pointsDe, CANDIDATS_EXAMINES);
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
  // Le trace ne contient qu'un tour : c'est lui qu'on suit, et le resultat
  // dit combien de fois le faire.
  const distance = tours * (longueur + 2 * longueurAmorce);
  journal(`5/5 Trace retenu : `
        + (tours > 1 ? `parcours de ${km(distance / tours)} km a faire ${tours} `
                       + `fois, soit ${km(distance)} km` : `${km(distance)} km`)
        + `, ${repetee.toFixed(0)} m parcourus deux fois`
        + (doublement.longueur > 0
           ? `, ${doublement.longueur.toFixed(0)} m longeant une autre portion` : ""));

  return {
    points, distance, cible: cibleM, repetee,
    partRepetee: longueur ? repetee / longueur : 0.0,
    amorce: longueurAmorce, sommets: nbSommets, cap, accroche: ecartDepart,
    types: repartition(trajet, aretes, "etiquette"),
    qualites: repartition(trajet, aretes, "qualite")
      .map(([q, m]) => [LIBELLES_QUALITE[q] || q, m]),
    longueurBoucle: longueur, boucle: true, tours,
    // De combien les points poses ont du etre deplaces pour toucher une rue :
    // l'interface s'en sert pour replacer le marqueur, plutot que de laisser
    // croire que le parcours part de la ou on avait clique.
    deplaceDepart, deplaceArrivee,
    doublement: doublement.longueur, portionsDoublees: doublement.portions.length,
    bouclettes: bouclettes.longueur, nbBouclettes: bouclettes.nombre,
  };
}

function traceVersArrivee({
  routeur, aretes, latN, lonN, indexCoeur, depart, noeudArrivee, departLL,
  arriveeLL, cibleM, amorce, amorceArrivee, longueurAmorce,
  longueurAmorceArrivee, iterations, tolerance, repetitionMax, maxPoints,
  ecartDepart, journal, deplaceDepart = 0, deplaceArrivee = 0, indiceDanger = "",
}) {
  const budget = cibleM - longueurAmorce - longueurAmorceArrivee;

  routeur.nouvellesPenalites();
  const direct = routeur.plusCourtChemin(depart, noeudArrivee);
  if (direct === null) {
    throw new BoucleIntrouvable(
      "Aucun itineraire praticable ne relie le depart a l'arrivee." + indiceDanger);
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

  let plafond;
  [meilleur, plafond] = recoursRepetition(meilleur, variantes, budget,
                                          repetitionMax, journal, "parcours");
  if (meilleur === null) {
    throw new BoucleIntrouvable(
      "Aucun parcours sans aller-retour trouve pour cette distance entre ces "
      + "deux points. Essayer une distance differente." + indiceDanger);
  }

  meilleur = affineTrajet(routeur, aretes, latN, lonN, indexCoeur, depart,
                          noeudArrivee, departLL, arriveeLL, budget, tolerance,
                          plafond, meilleur, variantes);

  // Meme controle geometrique que pour les boucles : un parcours d'un point a
  // un autre peut tout aussi bien longer une portion de lui-meme, par la rue a
  // l'aller et le trottoir au retour.
  const seuils = seuilsGeometriques(cibleM);
  const pointsDe = (essai) =>
    allege(polyligneDuTrajet(essai[3], aretes).map((n) => [latN[n], lonN[n]]), maxPoints);

  const reserve = variantes.filter((c) => !(c[1] && c[2] / c[1] > plafond));
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
    longueurBoucle: longueur, boucle: false, tours: 1,
    // De combien les points poses ont du etre deplaces pour toucher une rue :
    // l'interface s'en sert pour replacer le marqueur, plutot que de laisser
    // croire que le parcours part de la ou on avait clique.
    deplaceDepart, deplaceArrivee,
    doublement: doublement.longueur, portionsDoublees: doublement.portions.length,
    bouclettes: bouclettes.longueur, nbBouclettes: bouclettes.nombre,
  };
}

// Rend la main au fil d'execution pour que les messages d'avancement
// parviennent a l'interface pendant le calcul.
const souffle = () => new Promise((r) => setTimeout(r, 0));
